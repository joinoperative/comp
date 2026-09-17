import { describe, expect, it } from 'bun:test';
import { DEVICE_QUERY_LIMIT, MAX_DEVICE_PAGES } from '../collect';
import { healthy, runCheck, titled, type RunResult } from './harness';

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

  it('treats a null resources list as malformed, not an empty fleet', async () => {
    // Reading null as [] turned a broken response into the high-severity
    // "No devices are enrolled" finding, which is a different problem entirely.
    const r = await runCheck({ nullList: true, devices: [] });
    expect(titled(r, 'Could not verify')).toBeDefined();
    expect(titled(r, 'No devices are enrolled')).toBeUndefined();
  });

  it('ignores a non-array errors field rather than reporting "undefined"', async () => {
    // `errors?.length` is truthy for a string, which produced
    // "Falcon returned an error: undefined" and lost the status classification.
    const r = await runCheck({ listErrorsRaw: 'not-an-array', devices: [] });
    expect(r.failed.some((f) => (f.evidence?.readError as string | undefined)?.includes('undefined'))).toBe(false);
  });

  it('reports a malformed success body instead of throwing out of the check', async () => {
    // A non-array `resources` on an HTTP 200 used to escape the guarded paths,
    // and a zero-finding throw is recorded by the scheduler as success.
    const r = await runCheck({ malformedList: true, devices: [] });
    expect(titled(r, 'Could not verify')).toBeDefined();
  });

  it('reports an unreadable detail batch as a read failure, not a possible decommission', async () => {
    // Collapsing these reported a revoked scope as "device decommissioned?"
    // at medium severity with "re-run the check" — advice that cannot work.
    const err = Object.assign(new Error('HTTP 403: Forbidden'), { status: 403 });
    const r = await runCheck({ devices: [healthy('a')], throwOnDetails: err });

    const finding = titled(r, 'could not be read')!;
    expect(finding.resourceId).toBe('unreadable-devices');
    expect(finding.severity).toBe('high');
    expect(finding.remediation).toContain('Hosts: Read');
    expect(titled(r, 'returned no details')).toBeUndefined();
  });

  it('keeps "no record came back" for ids genuinely absent from a 200', async () => {
    const r = await runCheck({ devices: [healthy('a'), healthy('b')], dropFromDetails: ['b'] });
    const finding = titled(r, 'returned no details')!;
    expect(finding.severity).toBe('medium');
    expect(titled(r, 'could not be read')).toBeUndefined();
  });

  it('re-mints once when Falcon rejects a batch, then stops rather than hammering', async () => {
    // Continuing with a dead token sent hundreds of unauthorized calls on a
    // large tenant, and a first transient failure masked the later 401.
    const devices = Array.from({ length: 250 }, (_, i) => healthy(`d${i}`));
    const err = Object.assign(new Error('HTTP 401: Unauthorized'), { status: 401 });
    const r = await runCheck({ devices, throwOnDetails: err });

    const detailCalls = r.calls.filter((c) => c.path.startsWith('/devices/entities'));
    expect(detailCalls).toHaveLength(2); // first batch, then one retry after re-minting
    expect(r.tokenCalls).toBe(2); // initial mint plus one re-mint
    expect(r.warnings.join(' ')).toContain('stopped after');

    // All 250 are accounted for, not just the batch that failed.
    const finding = titled(r, 'could not be read')!;
    expect(finding.evidence?.deviceCount).toBe(250);
  });

  it('invalidates the cached token when the sweep is rejected', async () => {
    const err = Object.assign(new Error('HTTP 401: Unauthorized'), { status: 401 });
    await runCheck({ throwOnList: err, devices: [] });
    // A second run must mint again rather than replay the rejected token.
    const second = await runCheck({ devices: [healthy('a')] });
    expect(second.tokenCalls).toBe(1);
  });

  it('fails when the tenant has no enrolled devices', async () => {
    const r = await runCheck({ devices: [] });
    expect(r.failed[0]!.resourceId).toBe('tenant');
  });
});

describe('remediation stays truthful on the failure paths', () => {
  it('tells the user to reconnect when the mid-run re-mint is rejected', async () => {
    // The re-mint is itself an auth exchange. Letting its rejection throw escaped
    // fetchDeviceDetails, landed in the last-resort handler, and advised granting
    // Hosts: Read — which no scope change can fix. Third appearance of this bug.
    const err = Object.assign(new Error('HTTP 401: Unauthorized'), { status: 401 });
    const r = await runCheck({
      devices: [healthy('a')],
      throwOnDetails: err,
      tokenFailsOnRemint: true,
    });

    const finding = titled(r, 'could not be read')!;
    expect(finding.remediation).toContain('Reconnect');
    expect(finding.remediation).not.toContain('Hosts: Read');
  });

  it('classifies from the most serious batch, not the first', async () => {
    // A transient blip ahead of a permissions failure previously picked the
    // transient one and advised re-running, hiding the missing scope.
    const transient = Object.assign(new Error('HTTP 503: Server Error'), { status: 503 });
    const denied = Object.assign(new Error('HTTP 403: Forbidden'), { status: 403 });
    const devices = Array.from({ length: 150 }, (_, i) => healthy(`d${i}`));

    // Third entry so the post-re-mint retry of batch 2 fails too, rather than
    // succeeding and leaving only the transient failure recorded.
    const r = await runCheck({ devices, detailErrorSequence: [transient, denied, denied] });

    const finding = titled(r, 'could not be read')!;
    expect(finding.remediation).toContain('Hosts: Read');
  });

  it('caps the device list embedded in evidence', async () => {
    // Evidence is stored per finding and paging allows up to 50,000 devices.
    const devices = Array.from({ length: 250 }, (_, i) => healthy(`d${i}`));
    const r = await runCheck({ devices, dropFromDetails: devices.map((d) => d.device_id) });

    const finding = titled(r, 'returned no details')!;
    expect(finding.evidence?.deviceCount).toBe(250);
    expect((finding.evidence?.deviceIds as string[]).length).toBe(100);
    expect(finding.evidence?.deviceIdsTruncated).toBe(150);
  });
});
