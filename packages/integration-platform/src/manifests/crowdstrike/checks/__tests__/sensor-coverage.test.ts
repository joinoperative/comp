import { afterEach, describe, expect, it } from 'bun:test';
import type { CheckContext } from '../../../../types';
import type { FalconDevice } from '../../types';
import { sensorCoverageCheck } from '../sensor-coverage';

interface RunResult {
  passed: Array<{ resourceId: string; title: string }>;
  failed: Array<{ resourceId: string; title: string }>;
  /** Every path handed to ctx.fetch, so the tests can assert on query shape. */
  paths: string[];
}

const makeDevice = (
  id: string,
  hostname: string,
  overrides: Partial<FalconDevice> = {},
): FalconDevice => ({
  device_id: id,
  hostname,
  platform_name: 'Mac',
  os_version: 'Tahoe (26)',
  agent_version: '7.40.21204.0',
  status: 'normal',
  last_seen: '2026-09-14T20:29:51Z',
  ...overrides,
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function runCheck(devices: FalconDevice[]): Promise<RunResult> {
  const passed: RunResult['passed'] = [];
  const failed: RunResult['failed'] = [];
  const paths: string[] = [];

  // getFalconToken uses the global fetch directly (the platform only attaches an
  // Authorization header for oauth2/api_key/basic, not `custom`), so stub it here.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ access_token: 'tok', expires_in: 1799, token_type: 'bearer' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof globalThis.fetch;

  const ctx: CheckContext = {
    accessToken: '',
    credentials: { client_id: 'id', client_secret: 'secret', cloud: 'us-2' },
    variables: {},
    connectionId: 'conn_1',
    organizationId: 'org_1',
    metadata: {},
    log: () => {},
    warn: () => {},
    pass: (result) => {
      passed.push({ resourceId: result.resourceId ?? '', title: result.title });
    },
    fail: (result) => {
      failed.push({ resourceId: result.resourceId ?? '', title: result.title });
    },
    fetch: (async <T>(path: string): Promise<T> => {
      paths.push(path);

      if (path.startsWith('/devices/queries/devices/v1')) {
        return {
          resources: devices.map((d) => d.device_id),
          meta: { pagination: { offset: 0, limit: 500, total: devices.length } },
        } as unknown as T;
      }

      if (path.startsWith('/devices/entities/devices/v2')) {
        const ids = new URLSearchParams(path.split('?')[1] ?? '').getAll('ids');
        return {
          resources: devices.filter((d) => ids.includes(d.device_id)),
        } as unknown as T;
      }

      throw new Error(`Unexpected fetch: ${path}`);
    }) as CheckContext['fetch'],
    fetchAllPages: (async () => []) as CheckContext['fetchAllPages'],
    fetchWithCursor: (async () => []) as CheckContext['fetchWithCursor'],
    fetchWithLinkHeader: (async () => []) as CheckContext['fetchWithLinkHeader'],
    graphql: (async () => ({})) as CheckContext['graphql'],
    getState: (async () => null) as CheckContext['getState'],
    setState: (async () => {}) as CheckContext['setState'],
  } as CheckContext;

  await sensorCoverageCheck.run(ctx);
  return { passed, failed, paths };
}

describe('sensorCoverageCheck reduced functionality mode', () => {
  it("passes a healthy device that reports reduced_functionality_mode 'no' (regression)", async () => {
    // Falcon sends this field as the string 'yes' or 'no'. The original check used
    // Boolean(device.reduced_functionality_mode), and Boolean('no') is true — so
    // every healthy device was reported as unprotected. That failure was silent:
    // the check ran green and wrote wrong evidence into the Secure Devices task.
    const { passed, failed } = await runCheck([
      makeDevice('dev_ok', 'Juns-MacBook-Pro-2.local', { reduced_functionality_mode: 'no' }),
    ]);

    expect(failed).toHaveLength(0);
    expect(passed).toHaveLength(1);
    expect(passed[0]!.resourceId).toBe('dev_ok');
  });

  it("fails a device that reports reduced_functionality_mode 'yes'", async () => {
    const { passed, failed } = await runCheck([
      makeDevice('dev_rfm', 'Bryans-MacBook-Pro.local', { reduced_functionality_mode: 'yes' }),
    ]);

    expect(passed).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.resourceId).toBe('dev_rfm');
  });

  it('passes a device that omits the field entirely', async () => {
    const { passed, failed } = await runCheck([
      makeDevice('dev_absent', 'Mitchells-MacBook-Pro.local'),
    ]);

    expect(failed).toHaveLength(0);
    expect(passed).toHaveLength(1);
  });

  it('fails a device whose sensor is not reporting normally', async () => {
    const { passed, failed } = await runCheck([
      makeDevice('dev_bad', 'Stale.local', { status: 'containment_pending' }),
    ]);

    expect(passed).toHaveLength(0);
    expect(failed).toHaveLength(1);
  });
});

describe('sensorCoverageCheck device detail request', () => {
  it('sends ids as a repeated query parameter, not a comma-joined value', async () => {
    // Falcon reads `?ids=a,b` as a single device id and rejects the request with
    // HTTP 400 "invalid device id". It requires `?ids=a&ids=b`.
    const { paths } = await runCheck([
      makeDevice('dev_1', 'one.local', { reduced_functionality_mode: 'no' }),
      makeDevice('dev_2', 'two.local', { reduced_functionality_mode: 'no' }),
    ]);

    const detailPath = paths.find((p) => p.startsWith('/devices/entities/devices/v2'));
    expect(detailPath).toBeDefined();

    const ids = new URLSearchParams(detailPath!.split('?')[1] ?? '').getAll('ids');
    expect(ids).toEqual(['dev_1', 'dev_2']);
    expect(detailPath).not.toContain('dev_1,dev_2');
  });

  it('reports a finding when the tenant returns no devices', async () => {
    const { passed, failed } = await runCheck([]);

    expect(passed).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.resourceId).toBe('tenant');
  });
});
