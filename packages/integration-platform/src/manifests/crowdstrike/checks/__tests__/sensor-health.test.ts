import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { CheckContext } from '../../../../types';
import { clearFalconTokenCache } from '../../helpers/api-client';
import type { FalconDevice } from '../../types';
import { DEVICE_QUERY_LIMIT, MAX_DEVICE_PAGES } from '../collect';
import { sensorHealthCheck } from '../sensor-health';

const DAY_MS = 86_400_000;

interface Result {
  resourceId: string;
  title: string;
  remediation?: string;
  evidence?: Record<string, unknown>;
}

interface RunResult {
  passed: Result[];
  failed: Result[];
  calls: Array<{ path: string; baseUrl?: string; headers?: Record<string, string> }>;
  warnings: string[];
}

const healthy = (id: string, hostname = `${id}.local`, o: Partial<FalconDevice> = {}): FalconDevice => ({
  device_id: id,
  hostname,
  platform_name: 'Mac',
  agent_version: '7.40.21204.0',
  serial_number: `SER-${id}`,
  status: 'normal',
  reduced_functionality_mode: 'no',
  last_seen: new Date(Date.now() - DAY_MS).toISOString(),
  ...o,
});

interface Scenario {
  devices?: FalconDevice[];
  idPages?: Array<{ ids: string[]; cursor?: string; total?: number }>;
  dropFromDetails?: string[];
  detailErrors?: Array<{ code: number; message: string }>;
  listErrors?: Array<{ code: number; message: string }>;
  throwOnList?: Error;
  throwOnDetails?: Error;
  malformedList?: boolean;
  tokenStatus?: number;
  cloud?: string;
  staleAfterDays?: number;
}

const originalFetch = globalThis.fetch;
beforeEach(() => clearFalconTokenCache());
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearFalconTokenCache();
});

async function runCheck(s: Scenario = {}): Promise<RunResult> {
  const passed: Result[] = [];
  const failed: Result[] = [];
  const calls: RunResult['calls'] = [];
  const warnings: string[] = [];

  const devices = s.devices ?? [];
  const idPages = s.idPages ?? [{ ids: devices.map((d) => d.device_id) }];

  globalThis.fetch = (async () =>
    s.tokenStatus
      ? new Response(JSON.stringify({ errors: [{ message: 'nope' }] }), { status: s.tokenStatus })
      : new Response(
          JSON.stringify({ access_token: 'tok', expires_in: 1799, token_type: 'bearer' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )) as typeof globalThis.fetch;

  const record = (bucket: Result[]) => (r: { resourceId?: string; title: string; remediation?: string; evidence?: unknown }) =>
    bucket.push({
      resourceId: r.resourceId ?? '',
      title: r.title,
      remediation: r.remediation,
      evidence: r.evidence as Record<string, unknown> | undefined,
    });

  const ctx = {
    accessToken: '',
    credentials: { client_id: 'id', client_secret: 'secret', cloud: s.cloud ?? 'us-2' },
    variables: s.staleAfterDays === undefined ? {} : { stale_after_days: s.staleAfterDays },
    connectionId: 'conn_1',
    organizationId: 'org_1',
    metadata: {},
    log: () => {},
    warn: (m: string) => warnings.push(m),
    pass: record(passed),
    fail: record(failed),
    fetch: (async <T>(path: string, opts?: { baseUrl?: string; headers?: Record<string, string>; params?: Record<string, string> }): Promise<T> => {
      calls.push({ path, baseUrl: opts?.baseUrl, headers: opts?.headers });

      if (path.startsWith('/devices/queries/devices-scroll/v1')) {
        if (s.throwOnList) throw s.throwOnList;
        if (s.listErrors) return { errors: s.listErrors } as unknown as T;
        if (s.malformedList) return { resources: 'not-a-list' } as unknown as T;

        const cursor = opts?.params?.offset;
        const i = cursor ? idPages.findIndex((p) => p.cursor === cursor) + 1 : 0;
        const page = idPages[i];
        if (!page) return { resources: [], meta: { pagination: {} } } as unknown as T;
        return {
          resources: page.ids,
          meta: {
            pagination: {
              ...(page.cursor ? { offset: page.cursor } : {}),
              ...(page.total === undefined ? {} : { total: page.total }),
            },
          },
        } as unknown as T;
      }

      if (path.startsWith('/devices/entities/devices/v2')) {
        if (s.throwOnDetails) throw s.throwOnDetails;
        const requested = new URLSearchParams(path.split('?')[1] ?? '').getAll('ids');
        const dropped = new Set(s.dropFromDetails ?? []);
        return {
          resources: devices.filter((d) => requested.includes(d.device_id) && !dropped.has(d.device_id)),
          ...(s.detailErrors ? { errors: s.detailErrors } : {}),
        } as unknown as T;
      }
      throw new Error(`Unexpected fetch: ${path}`);
    }) as CheckContext['fetch'],
  } as unknown as CheckContext;

  await sensorHealthCheck.run(ctx);
  return { passed, failed, calls, warnings };
}

const titled = (r: RunResult, fragment: string) => r.failed.find((f) => f.title.includes(fragment));

describe('happy path', () => {
  it('passes healthy devices and fails a degraded one', async () => {
    const r = await runCheck({
      devices: [healthy('a'), healthy('b'), healthy('c', 'c.local', { reduced_functionality_mode: 'yes' })],
    });
    expect(r.passed).toHaveLength(2);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.title).toContain('not fully protected');
  });

  it('routes every call to the tenant region with a bearer token', async () => {
    const r = await runCheck({ cloud: 'us-3', devices: [healthy('a')] });
    for (const c of r.calls) {
      expect(c.baseUrl).toBe('https://api.us-3.crowdstrike.com');
      expect(c.headers?.Authorization).toBe('Bearer tok');
    }
  });

  it('sends ids as repeated query parameters, not comma-joined', async () => {
    const r = await runCheck({ devices: [healthy('a'), healthy('b')] });
    const detail = r.calls.find((c) => c.path.startsWith('/devices/entities'))!;
    expect(new URLSearchParams(detail.path.split('?')[1]).getAll('ids')).toEqual(['a', 'b']);
  });

  it('splits more than 100 devices into batches', async () => {
    const devices = Array.from({ length: 250 }, (_, i) => healthy(`d${i}`));
    const r = await runCheck({ devices });
    expect(r.calls.filter((c) => c.path.startsWith('/devices/entities'))).toHaveLength(3);
    expect(r.passed).toHaveLength(250);
  });
});

describe('partial detail responses', () => {
  it('still evaluates the devices that came back when one id errored', async () => {
    // Falcon returns 99 resources plus one per-id error when a host is
    // decommissioned mid-run. Bailing out discarded 99 devices' evidence and
    // failed the whole run on a routine race.
    const devices = [healthy('a'), healthy('b')];
    const r = await runCheck({
      devices,
      dropFromDetails: ['b'],
      detailErrors: [{ code: 404, message: 'device not found' }],
    });

    expect(r.passed.map((p) => p.resourceId)).toEqual(['a']);
    const unreturned = titled(r, 'returned no details')!;
    expect(unreturned.evidence?.deviceIds).toEqual(['b']);
    expect(unreturned.evidence?.falconErrors).toHaveLength(1);
  });

  it('aggregates unreturned devices into one finding, not one each', async () => {
    const devices = Array.from({ length: 5 }, (_, i) => healthy(`d${i}`));
    const r = await runCheck({ devices, dropFromDetails: devices.map((d) => d.device_id) });
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.resourceId).toBe('unreturned-devices');
    expect(r.failed[0]!.evidence?.deviceCount).toBe(5);
  });

  it('aggregates unverifiable devices into one finding', async () => {
    const devices = Array.from({ length: 4 }, (_, i) =>
      healthy(`d${i}`, `d${i}.local`, { reduced_functionality_mode: undefined }),
    );
    const r = await runCheck({ devices });
    const finding = titled(r, 'could not be verified')!;
    expect(finding.resourceId).toBe('unverified-devices');
    expect(finding.evidence?.deviceCount).toBe(4);
  });
});

describe('pagination', () => {
  it('follows the scroll cursor', async () => {
    const devices = [healthy('a'), healthy('b')];
    const r = await runCheck({ devices, idPages: [{ ids: ['a'], cursor: 'C1' }, { ids: ['b'] }] });
    expect(r.passed).toHaveLength(2);
  });

  it('dedupes ids repeated across pages', async () => {
    const r = await runCheck({
      devices: [healthy('a')],
      idPages: [{ ids: ['a'], cursor: 'C1' }, { ids: ['a'] }],
    });
    expect(r.passed).toHaveLength(1);
  });

  it('accepts a full final page when the total confirms the list is complete', async () => {
    // An inventory that is an exact multiple of the page size is not a bug.
    const devices = Array.from({ length: DEVICE_QUERY_LIMIT }, (_, i) => healthy(`d${i}`));
    const ids = devices.map((d) => d.device_id);
    const r = await runCheck({ devices, idPages: [{ ids, total: DEVICE_QUERY_LIMIT }] });

    expect(r.passed).toHaveLength(DEVICE_QUERY_LIMIT);
    expect(r.failed).toHaveLength(0);
  });

  it('fails a full final page with no cursor and no total', async () => {
    const devices = Array.from({ length: DEVICE_QUERY_LIMIT }, (_, i) => healthy(`d${i}`));
    const r = await runCheck({ devices, idPages: [{ ids: devices.map((d) => d.device_id) }] });
    expect(r.passed).toHaveLength(0);
    expect(titled(r, 'Could not verify')).toBeDefined();
  });

  it('reports truncation when the page cap is hit', async () => {
    const pages = Array.from({ length: MAX_DEVICE_PAGES + 2 }, (_, i) => ({
      ids: [`d${i}`],
      cursor: `C${i}`,
    }));
    const devices = pages.map((p) => healthy(p.ids[0]!));
    const r = await runCheck({ devices, idPages: pages });

    expect(r.warnings.join(' ')).toContain('results are partial');
    expect(titled(r, 'truncated')).toBeDefined();
  });
});

describe('read failures never look like success', () => {
  it.each([
    ['config error', { cloud: 'mars-1' }, 'Reconnect'],
    ['rejected credentials', { tokenStatus: 401 }, 'Reconnect'],
  ])('reports %s with reconnect remediation', async (_name, scenario, expected) => {
    // A rejected token exchange is not a missing scope; telling the user to
    // grant "Hosts: Read" sends them somewhere that cannot fix it.
    const r = await runCheck({ ...scenario, devices: [] });
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.resourceId).toBe('tenant');
    expect(r.failed[0]!.remediation).toContain(expected);
  });

  it('reports a device-list 403 with the grant remediation', async () => {
    const err = Object.assign(new Error('HTTP 403: Forbidden'), { status: 403 });
    const r = await runCheck({ throwOnList: err, devices: [] });
    expect(r.failed[0]!.remediation).toContain('Hosts: Read');
  });

  it('treats a 200 envelope carrying errors on the sweep as a failed read', async () => {
    const r = await runCheck({ listErrors: [{ code: 403, message: 'access denied' }], devices: [] });
    expect(r.passed).toHaveLength(0);
    expect(titled(r, 'Could not verify')).toBeDefined();
  });

  it('reports a malformed success body instead of throwing out of the check', async () => {
    // A non-array `resources` on an HTTP 200 used to escape the guarded paths,
    // and a zero-finding throw is recorded by the scheduler as success.
    const r = await runCheck({ malformedList: true, devices: [] });
    expect(titled(r, 'Could not verify')).toBeDefined();
  });

  it('reports a detail batch that throws', async () => {
    const err = Object.assign(new Error('HTTP 500: Server Error'), { status: 500 });
    const r = await runCheck({ devices: [healthy('a')], throwOnDetails: err });
    expect(titled(r, 'returned no details')).toBeDefined();
  });

  it('fails when the tenant has no enrolled devices', async () => {
    const r = await runCheck({ devices: [] });
    expect(r.failed[0]!.resourceId).toBe('tenant');
  });
});
