import { describe, expect, it } from 'bun:test';
import type { FalconDevice } from '../../types';
import { DEFAULT_STALE_AFTER_DAYS, daysSince, evaluateDevice } from '../evaluate';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-09-15T12:00:00Z');

const device = (overrides: Partial<FalconDevice> = {}): FalconDevice => ({
  device_id: 'dev_1',
  hostname: 'one.local',
  platform_name: 'Mac',
  os_version: 'Tahoe (26)',
  agent_version: '7.40.21204.0',
  serial_number: 'SER-1',
  status: 'normal',
  reduced_functionality_mode: 'no',
  last_seen: new Date(NOW - DAY_MS).toISOString(),
  ...overrides,
});

const verdictOf = (overrides: Partial<FalconDevice>, staleAfter = DEFAULT_STALE_AFTER_DAYS) =>
  evaluateDevice(device(overrides), NOW, staleAfter).verdict;

describe('reduced functionality mode', () => {
  it("treats 'no' as healthy (regression: Boolean('no') is true)", () => {
    expect(verdictOf({ reduced_functionality_mode: 'no' }).kind).toBe('healthy');
  });

  it("treats 'yes' as degraded", () => {
    expect(verdictOf({ reduced_functionality_mode: 'yes' }).kind).toBe('degraded');
  });

  it('treats an absent field as unverified, not healthy', () => {
    expect(verdictOf({ reduced_functionality_mode: undefined }).kind).toBe('unverified');
  });

  it('treats an unrecognised value as unverified', () => {
    expect(verdictOf({ reduced_functionality_mode: 'maybe' }).kind).toBe('unverified');
  });
});

describe('containment is evidence, not health', () => {
  it('passes a network-contained host whose sensor is fine', () => {
    // Falcon's `status` is containment state. A host isolated during incident
    // response must not be told to reinstall its sensor.
    const { verdict, evidence } = evaluateDevice(device({ status: 'contained' }), NOW, 30);
    expect(verdict.kind).toBe('healthy');
    expect(evidence.containmentStatus).toBe('contained');
  });

  it.each(['containment_pending', 'lift_containment_pending'])(
    'does not fail on status %s',
    (status) => {
      expect(verdictOf({ status }).kind).toBe('healthy');
    },
  );
});

describe('staleness', () => {
  it('passes just inside the threshold', () => {
    expect(verdictOf({ last_seen: new Date(NOW - 29 * DAY_MS).toISOString() }).kind).toBe(
      'healthy',
    );
  });

  it('fails just outside the threshold', () => {
    expect(verdictOf({ last_seen: new Date(NOW - 31 * DAY_MS).toISOString() }).kind).toBe('stale');
  });

  it('honours a configured threshold', () => {
    const tenDaysAgo = { last_seen: new Date(NOW - 10 * DAY_MS).toISOString() };
    expect(verdictOf(tenDaysAgo, 30).kind).toBe('healthy');
    expect(verdictOf(tenDaysAgo, 7).kind).toBe('stale');
  });

  it('is unverified when last_seen is missing or unparseable', () => {
    expect(verdictOf({ last_seen: undefined }).kind).toBe('unverified');
    expect(verdictOf({ last_seen: 'not-a-date' }).kind).toBe('unverified');
  });

  it('clamps a future last_seen to zero rather than reporting negative days', () => {
    // Clock skew on the endpoint otherwise renders as "-1 day(s) ago".
    const future = new Date(NOW + 2 * DAY_MS).toISOString();
    expect(daysSince(future, NOW)).toBe(0);
    const { verdict, evidence } = evaluateDevice(device({ last_seen: future }), NOW, 30);
    expect(verdict.kind).toBe('healthy');
    expect(evidence.daysSinceLastSeen).toBe(0);
  });
});

describe('evaluation order', () => {
  it('reports a known failure ahead of unknown metadata', () => {
    // Evaluating unknowns first downgraded a degraded sensor to a medium
    // "could not verify" because the same record was also missing last_seen.
    expect(
      verdictOf({ reduced_functionality_mode: 'yes', last_seen: undefined }).kind,
    ).toBe('degraded');
  });

  it('reports staleness ahead of unknown RFM', () => {
    expect(
      verdictOf({
        reduced_functionality_mode: undefined,
        last_seen: new Date(NOW - 200 * DAY_MS).toISOString(),
      }).kind,
    ).toBe('stale');
  });
});

describe('evidence', () => {
  it('carries the keys a future coverage check needs to join on', () => {
    const { evidence } = evaluateDevice(device(), NOW, 30);
    expect(evidence).toMatchObject({ hostname: 'one.local', serialNumber: 'SER-1' });
  });
});
