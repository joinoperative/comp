import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { CheckContext } from '../../../../types';
import { clearFalconTokenCache, getFalconToken } from '../../helpers/api-client';
import type { FalconDevice } from '../../types';
import { sensorHealthCheck } from '../sensor-health';

const DAY_MS = 86_400_000;

interface Result {
  resourceId: string;
  title: string;
  evidence?: Record<string, unknown>;
}

interface RunResult {
  passed: Result[];
  failed: Result[];
  /** Every ctx.fetch call, so tests can assert on routing, auth and query shape. */
  calls: Array<{ path: string; baseUrl?: string; headers?: Record<string, string> }>;
  warnings: string[];
}

/** A device that is healthy by every rule the check applies. */
const healthy = (id: string, hostname: string, overrides: Partial<FalconDevice> = {}): FalconDevice => ({
  device_id: id,
  hostname,
  platform_name: 'Mac',
  os_version: 'Tahoe (26)',
  agent_version: '7.40.21204.0',
  serial_number: `SER-${id}`,
  status: 'normal',
  reduced_functionality_mode: 'no',
  last_seen: new Date(Date.now() - DAY_MS).toISOString(),
  ...overrides,
});

interface Scenario {
  devices?: FalconDevice[];
  /** Pages of device ids. Defaults to one page derived from `devices`. */
  idPages?: Array<{ ids: string[]; cursor?: string }>;
  /** Ids to omit from the detail response even though they were listed. */
  dropFromDetails?: string[];
  /** Envelope-level errors returned with HTTP 200. */
  listErrors?: Array<{ code: number; message: string }>;
  detailErrors?: Array<{ code: number; message: string }>;
  /** Throw from the list or detail fetch. */
  throwOnList?: Error;
  throwOnDetails?: Error;
  /** Make the token exchange fail. */
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

async function runCheck(scenario: Scenario = {}): Promise<RunResult> {
  const passed: Result[] = [];
  const failed: Result[] = [];
  const calls: RunResult['calls'] = [];
  const warnings: string[] = [];

  const devices = scenario.devices ?? [];
  const idPages =
    scenario.idPages ?? [{ ids: devices.map((d) => d.device_id) }];

  // getFalconToken uses the global fetch directly: the platform only attaches an
  // Authorization header for oauth2/api_key/basic, never for `custom` auth.
  globalThis.fetch = (async () => {
    if (scenario.tokenStatus) {
      return new Response(
        JSON.stringify({ errors: [{ message: 'client_id 1234secret is invalid' }] }),
        { status: scenario.tokenStatus, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ access_token: 'tok', expires_in: 1799, token_type: 'bearer' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;

  const ctx: CheckContext = {
    accessToken: '',
    credentials: {
      client_id: 'id',
      client_secret: 'secret',
      cloud: scenario.cloud ?? 'us-2',
    },
    variables:
      scenario.staleAfterDays === undefined ? {} : { stale_after_days: scenario.staleAfterDays },
    connectionId: 'conn_1',
    organizationId: 'org_1',
    metadata: {},
    log: () => {},
    warn: (message: string) => {
      warnings.push(message);
    },
    pass: (result) => {
      passed.push({
        resourceId: result.resourceId ?? '',
        title: result.title,
        evidence: result.evidence as Record<string, unknown> | undefined,
      });
    },
    fail: (result) => {
      failed.push({
        resourceId: result.resourceId ?? '',
        title: result.title,
        evidence: result.evidence as Record<string, unknown> | undefined,
      });
    },
    fetch: (async <T>(
      path: string,
      opts?: {
        baseUrl?: string;
        headers?: Record<string, string>;
        params?: Record<string, string>;
      },
    ): Promise<T> => {
      calls.push({ path, baseUrl: opts?.baseUrl, headers: opts?.headers });

      if (path.startsWith('/devices/queries/devices-scroll/v1')) {
        if (scenario.throwOnList) throw scenario.throwOnList;
        if (scenario.listErrors) return { errors: scenario.listErrors } as unknown as T;

        const cursorParam = opts?.params?.offset;
        const index = cursorParam
          ? idPages.findIndex((p) => p.cursor === cursorParam) + 1
          : 0;
        const page = idPages[index];
        if (!page) return { resources: [], meta: { pagination: {} } } as unknown as T;

        return {
          resources: page.ids,
          meta: { pagination: page.cursor ? { offset: page.cursor } : {} },
        } as unknown as T;
      }

      if (path.startsWith('/devices/entities/devices/v2')) {
        if (scenario.throwOnDetails) throw scenario.throwOnDetails;
        if (scenario.detailErrors) return { errors: scenario.detailErrors } as unknown as T;

        const requested = new URLSearchParams(path.split('?')[1] ?? '').getAll('ids');
        const dropped = new Set(scenario.dropFromDetails ?? []);
        return {
          resources: devices.filter(
            (d) => requested.includes(d.device_id) && !dropped.has(d.device_id),
          ),
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

  await sensorHealthCheck.run(ctx);
  return { passed, failed, calls, warnings };
}

const detailCalls = (r: RunResult) =>
  r.calls.filter((c) => c.path.startsWith('/devices/entities/devices/v2'));

describe('reduced functionality mode', () => {
  it("passes a device reporting 'no' (regression: Boolean('no') is true)", async () => {
    const { passed, failed } = await runCheck({
      devices: [healthy('dev_ok', 'Juns-MacBook-Pro-2.local')],
    });

    expect(failed).toHaveLength(0);
    expect(passed).toHaveLength(1);
    expect(passed[0]!.resourceId).toBe('dev_ok');
  });

  it("fails a device reporting 'yes'", async () => {
    const { passed, failed } = await runCheck({
      devices: [
        healthy('dev_rfm', 'Bryans-MacBook-Pro.local', { reduced_functionality_mode: 'yes' }),
      ],
    });

    expect(passed).toHaveLength(0);
    expect(failed[0]!.title).toContain('not fully protected');
  });

  it('reports unverified — not healthy — when the field is absent', async () => {
    const { passed, failed } = await runCheck({
      devices: [
        healthy('dev_unknown', 'Mystery.local', { reduced_functionality_mode: undefined }),
      ],
    });

    expect(passed).toHaveLength(0);
    expect(failed[0]!.title).toContain('could not be verified');
  });
});

describe('containment status is evidence, not health', () => {
  it('passes a network-contained host with a healthy sensor', async () => {
    // Falcon's `status` is containment state, not sensor health. A host isolated
    // during incident response must not be reported as missing protection.
    const { passed, failed } = await runCheck({
      devices: [healthy('dev_contained', 'Quarantined.local', { status: 'contained' })],
    });

    expect(failed).toHaveLength(0);
    expect(passed).toHaveLength(1);
    expect(passed[0]!.evidence?.containmentStatus).toBe('contained');
  });
});

describe('staleness', () => {
  it('passes a device seen just inside the threshold', async () => {
    const { passed, failed } = await runCheck({
      staleAfterDays: 30,
      devices: [
        healthy('dev_fresh', 'Fresh.local', {
          last_seen: new Date(Date.now() - 29 * DAY_MS).toISOString(),
        }),
      ],
    });

    expect(failed).toHaveLength(0);
    expect(passed).toHaveLength(1);
  });

  it('fails a device seen beyond the threshold', async () => {
    const { passed, failed } = await runCheck({
      staleAfterDays: 30,
      devices: [
        healthy('dev_stale', 'Abandoned.local', {
          last_seen: new Date(Date.now() - 200 * DAY_MS).toISOString(),
        }),
      ],
    });

    expect(passed).toHaveLength(0);
    expect(failed[0]!.title).toContain('has not checked in');
  });

  it('honours a configured threshold over the default', async () => {
    const devices = [
      healthy('dev_10d', 'Recent.local', {
        last_seen: new Date(Date.now() - 10 * DAY_MS).toISOString(),
      }),
    ];

    expect((await runCheck({ devices })).passed).toHaveLength(1); // default 30
    expect((await runCheck({ devices, staleAfterDays: 7 })).failed).toHaveLength(1);
  });

  it('reports unverified when last_seen is missing or unparseable', async () => {
    const { failed } = await runCheck({
      devices: [healthy('dev_nolastseen', 'NoClock.local', { last_seen: 'not-a-date' })],
    });

    expect(failed[0]!.title).toContain('could not be verified');
  });
});

describe('device detail request', () => {
  it('sends ids as repeated query parameters, not comma-joined', async () => {
    // Falcon reads `?ids=a,b` as one device id and rejects it with HTTP 400
    // "invalid device id".
    const { calls } = await runCheck({
      devices: [healthy('dev_1', 'one.local'), healthy('dev_2', 'two.local')],
    });

    const path = detailCalls({ calls } as RunResult)[0]!.path;
    expect(new URLSearchParams(path.split('?')[1]).getAll('ids')).toEqual(['dev_1', 'dev_2']);
    expect(path).not.toContain('dev_1,dev_2');
  });

  it('routes to the tenant region and sends the bearer token', async () => {
    const { calls } = await runCheck({
      cloud: 'us-2',
      devices: [healthy('dev_1', 'one.local')],
    });

    for (const call of calls) {
      expect(call.baseUrl).toBe('https://api.us-2.crowdstrike.com');
      expect(call.headers?.Authorization).toBe('Bearer tok');
    }
  });

  it('splits more than 100 devices across batches', async () => {
    const devices = Array.from({ length: 250 }, (_, i) => healthy(`dev_${i}`, `host-${i}.local`));
    const { passed, calls } = await runCheck({ devices });

    expect(detailCalls({ calls } as RunResult)).toHaveLength(3);
    expect(passed).toHaveLength(250);
  });
});

describe('pagination', () => {
  it('follows the scroll cursor across pages', async () => {
    const devices = [healthy('dev_1', 'one.local'), healthy('dev_2', 'two.local')];
    const { passed } = await runCheck({
      devices,
      idPages: [{ ids: ['dev_1'], cursor: 'CURSOR_1' }, { ids: ['dev_2'] }],
    });

    expect(passed).toHaveLength(2);
  });

  it('dedupes ids repeated across pages', async () => {
    // Offset paging over a live inventory can return the same device twice;
    // without deduping it produces two findings for one resource.
    const devices = [healthy('dev_1', 'one.local')];
    const { passed } = await runCheck({
      devices,
      idPages: [{ ids: ['dev_1'], cursor: 'CURSOR_1' }, { ids: ['dev_1'] }],
    });

    expect(passed).toHaveLength(1);
  });

  it('fails loudly on a full page with no cursor rather than reporting a partial fleet', async () => {
    const devices = Array.from({ length: 500 }, (_, i) => healthy(`dev_${i}`, `host-${i}.local`));
    const { passed, failed } = await runCheck({
      devices,
      idPages: [{ ids: devices.map((d) => d.device_id) }], // full page, no cursor
    });

    expect(passed).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.title).toContain('Could not verify');
  });
});

describe('read failures never look like success', () => {
  it('reports a finding when the token exchange fails', async () => {
    const { passed, failed } = await runCheck({ tokenStatus: 401, devices: [] });

    expect(passed).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.resourceId).toBe('tenant');
    // The run must not end with zero findings — the scheduler stores a
    // zero-finding run as `success` (run-connection-checks.ts).
    expect(failed[0]!.title).toContain('Could not verify');
  });

  it('never echoes the token response body into the finding', async () => {
    const { failed } = await runCheck({ tokenStatus: 401, devices: [] });

    const serialised = JSON.stringify(failed);
    expect(serialised).not.toContain('1234secret');
  });

  it('reports a finding when the device list read throws', async () => {
    const err = Object.assign(new Error('HTTP 403: Forbidden'), { status: 403 });
    const { failed } = await runCheck({ throwOnList: err, devices: [] });

    expect(failed).toHaveLength(1);
    expect(failed[0]!.resourceId).toBe('tenant');
  });

  it('treats a 200 envelope carrying errors as a failed read', async () => {
    const { passed, failed } = await runCheck({
      listErrors: [{ code: 403, message: 'access denied' }],
      devices: [],
    });

    expect(passed).toHaveLength(0);
    expect(failed[0]!.title).toContain('Could not verify');
  });

  it('reports a finding when a detail batch throws', async () => {
    const err = Object.assign(new Error('HTTP 500: Server Error'), { status: 500 });
    const { failed } = await runCheck({
      devices: [healthy('dev_1', 'one.local')],
      throwOnDetails: err,
    });

    expect(failed[0]!.title).toContain('Could not verify sensor health for some devices');
  });

  it('accounts for devices dropped from the detail response', async () => {
    // Previously these were neither passed nor failed — they vanished and the
    // run looked clean.
    const { passed, failed } = await runCheck({
      devices: [healthy('dev_1', 'one.local'), healthy('dev_2', 'two.local')],
      idPages: [{ ids: ['dev_1', 'dev_2'] }],
      dropFromDetails: ['dev_2'],
    });

    expect(passed.map((p) => p.resourceId)).toEqual(['dev_1']);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.resourceId).toBe('dev_2');
  });

  it('fails when the tenant has no enrolled devices', async () => {
    const { passed, failed } = await runCheck({ devices: [] });

    expect(passed).toHaveLength(0);
    expect(failed[0]!.resourceId).toBe('tenant');
  });
});

describe('evidence', () => {
  it('carries the keys a future coverage check needs to join on', async () => {
    const { passed } = await runCheck({ devices: [healthy('dev_1', 'one.local')] });

    expect(passed[0]!.evidence).toMatchObject({
      hostname: 'one.local',
      serialNumber: 'SER-dev_1',
    });
  });
});

describe('credential validation', () => {
  const ctxWith = (credentials: Record<string, string | string[]>): CheckContext =>
    ({ credentials, connectionId: 'conn_1' }) as unknown as CheckContext;

  it('rejects an unknown Falcon cloud instead of defaulting to US-1', async () => {
    // Silently defaulting sent a US-2 tenant's credentials to the US-1 host and
    // surfaced as an unexplained 401 on every device read.
    await expect(
      getFalconToken(ctxWith({ client_id: 'a', client_secret: 'b', cloud: 'mars-1' })),
    ).rejects.toThrow(/Unknown CrowdStrike Falcon cloud/);
  });

  it('rejects a missing Falcon cloud', async () => {
    await expect(
      getFalconToken(ctxWith({ client_id: 'a', client_secret: 'b' })),
    ).rejects.toThrow(/Falcon cloud is not set/);
  });

  it('rejects a prototype key as a cloud', async () => {
    await expect(
      getFalconToken(ctxWith({ client_id: 'a', client_secret: 'b', cloud: 'constructor' })),
    ).rejects.toThrow(/Unknown CrowdStrike Falcon cloud/);
  });

  it('rejects a list-valued credential instead of throwing a TypeError', async () => {
    await expect(
      getFalconToken(ctxWith({ client_id: ['a', 'b'], client_secret: 'b', cloud: 'us-2' })),
    ).rejects.toThrow(/is a list/);
  });
});
