/**
 * Shared harness for the CrowdStrike check tests.
 *
 * Not named *.test.ts so the runner does not treat it as a suite; split out
 * of sensor-health.test.ts for the repo's 300-line ceiling.
 */

import { afterEach, beforeEach } from 'bun:test';
import type { CheckContext } from '../../../../types';
import { clearFalconTokenCache } from '../../helpers/api-client';
import type { FalconDevice } from '../../types';
import { DEVICE_QUERY_LIMIT, MAX_DEVICE_PAGES } from '../collect';
import { sensorHealthCheck } from '../sensor-health';

const DAY_MS = 86_400_000;

export interface Result {
  resourceId: string;
  title: string;
  severity?: string;
  remediation?: string;
  evidence?: Record<string, unknown>;
}

export interface RunResult {
  passed: Result[];
  failed: Result[];
  calls: Array<{ path: string; baseUrl?: string; headers?: Record<string, string> }>;
  warnings: string[];
  tokenCalls: number;
}

export const healthy = (id: string, hostname = `${id}.local`, o: Partial<FalconDevice> = {}): FalconDevice => ({
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

export interface Scenario {
  devices?: FalconDevice[];
  idPages?: Array<{ ids: string[]; cursor?: string; total?: number }>;
  dropFromDetails?: string[];
  detailErrors?: Array<{ code: number; message: string }>;
  listErrors?: Array<{ code: number; message: string }>;
  throwOnList?: Error;
  throwOnDetails?: Error;
  malformedList?: boolean;
  nullList?: boolean;
  listErrorsRaw?: unknown;
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

export async function runCheck(s: Scenario = {}): Promise<RunResult> {
  const passed: Result[] = [];
  const failed: Result[] = [];
  const calls: RunResult['calls'] = [];
  const warnings: string[] = [];

  const tokenCalls = { count: 0 };
  const devices = s.devices ?? [];
  const idPages = s.idPages ?? [{ ids: devices.map((d) => d.device_id) }];

  globalThis.fetch = (async () => {
    tokenCalls.count += 1;
    return s.tokenStatus
      ? new Response(JSON.stringify({ errors: [{ message: 'nope' }] }), { status: s.tokenStatus })
      : new Response(
          JSON.stringify({ access_token: 'tok', expires_in: 1799, token_type: 'bearer' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
  }) as typeof globalThis.fetch;

  const record = (bucket: Result[]) => (r: { resourceId?: string; title: string; severity?: string; remediation?: string; evidence?: unknown }) =>
    bucket.push({
      resourceId: r.resourceId ?? '',
      title: r.title,
      severity: r.severity,
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
        if (s.listErrorsRaw !== undefined) {
          return { resources: [], errors: s.listErrorsRaw } as unknown as T;
        }
        if (s.malformedList) return { resources: 'not-a-list' } as unknown as T;
        if (s.nullList) return { resources: null } as unknown as T;

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
  return { passed, failed, calls, warnings, tokenCalls: tokenCalls.count };
}

export const titled = (r: RunResult, fragment: string) => r.failed.find((f) => f.title.includes(fragment));

