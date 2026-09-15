/**
 * Check: every endpoint enrolled in CrowdStrike Falcon is running a healthy sensor.
 *
 * SCOPE — read this before changing the title or the task mapping.
 *
 * This check measures the *health* of machines Falcon already knows about. It
 * cannot measure fleet *coverage*: a laptop with no sensor installed never
 * appears in Falcon's inventory, so it can never fail here. Reporting this as
 * "endpoint protection is deployed" would mean a fleet that is 40% unprotected
 * still reports all-green.
 *
 * Proving coverage requires reconciling Falcon's hosts against Comp's own
 * `Device` records, and `CheckContext` deliberately exposes no organisation
 * data (see types.ts) — so that belongs in the platform or the Device List
 * task, not in a vendor connector. Until then, every result carries
 * `hostname` and `serialNumber` so a future coverage feature can join on them
 * without re-collecting anything.
 */

import { TASK_TEMPLATES } from '../../../task-mappings';
import type { CheckContext, CheckVariable, IntegrationCheck } from '../../../types';
import { remediationForReadFailure, toHttpReadFailure } from '../../http-read-failure';
import {
  falconAuthHeaders,
  falconBaseUrl,
  getFalconToken,
  isFalconConfigError,
} from '../helpers/api-client';
import type { FalconDevice, FalconEnvelope } from '../types';

/** Falcon caps `ids` lookups; 100 per request keeps the GET URL well inside limits. */
const DEVICE_DETAIL_BATCH_SIZE = 100;

/** Page size for the device id scroll. */
const DEVICE_QUERY_LIMIT = 500;

/**
 * Hard stop on pagination, mirroring MAX_PAGES_DEFAULT in
 * runtime/check-context.ts. Without a cap, an endpoint that ignores the cursor
 * loops forever accumulating ids.
 */
const MAX_DEVICE_PAGES = 100;

const DEFAULT_STALE_AFTER_DAYS = 30;

const GRANT_REMEDIATION =
  'Grant the Falcon API client the "Hosts: Read" scope (Falcon console → Support and resources → API clients and keys), then re-run the check.';

const staleAfterDaysVariable: CheckVariable = {
  id: 'stale_after_days',
  label: 'Treat a device as stale after (days)',
  type: 'number',
  required: false,
  default: DEFAULT_STALE_AFTER_DAYS,
  helpText:
    'A sensor that has not checked in within this many days is reported as not protecting the device. 30 days avoids flagging laptops that are simply switched off during leave.',
};

interface EnrolledDevices {
  ids: string[];
  /** Set when the id sweep could not be completed; ids may be partial. */
  readFailure?: ReturnType<typeof toHttpReadFailure>;
  /** True when the page cap stopped the sweep, so coverage is known-partial. */
  truncated: boolean;
}

/** Read the scroll cursor, which Falcon returns as a string in either field. */
function readCursor(meta: FalconEnvelope<string[]>['meta']): string | undefined {
  const pagination = meta?.pagination;
  if (!pagination) return undefined;
  if (typeof pagination.offset_string === 'string' && pagination.offset_string) {
    return pagination.offset_string;
  }
  // The scroll endpoint returns an opaque string here; the offset endpoint
  // returns a number, which is not a cursor and must not be treated as one.
  if (typeof pagination.offset === 'string' && pagination.offset) {
    return pagination.offset;
  }
  return undefined;
}

function envelopeError(envelope: FalconEnvelope<unknown>): Error | undefined {
  if (!envelope.errors?.length) return undefined;
  // Falcon returns HTTP 200 with a populated `errors` array for partial and
  // per-id failures. Treating that as an empty success is how a failed read
  // becomes a green run.
  const first = envelope.errors[0]!;
  const extra = envelope.errors.length > 1 ? ` (+${envelope.errors.length - 1} more)` : '';
  const error = new Error(`Falcon returned an error: ${first.message}${extra}`);
  (error as Error & { status: number }).status = first.code;
  return error;
}

/** Walk the device-id scroll, deduping and capping pages. */
async function listEnrolledDeviceIds(
  ctx: CheckContext,
  baseUrl: string,
  headers: Record<string, string>,
): Promise<EnrolledDevices> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;

  while (pages < MAX_DEVICE_PAGES) {
    pages += 1;

    const params: Record<string, string> = { limit: String(DEVICE_QUERY_LIMIT) };
    if (cursor) params.offset = cursor;

    let page: FalconEnvelope<string[]>;
    try {
      // devices-scroll rather than devices/v1: the offset endpoint caps out
      // around 10k results, and offset paging over a live inventory can repeat
      // a device across pages.
      page = await ctx.fetch<FalconEnvelope<string[]>>('/devices/queries/devices-scroll/v1', {
        baseUrl,
        headers,
        params,
      });
    } catch (err) {
      return { ids: [...ids], readFailure: toHttpReadFailure(err), truncated: false };
    }

    const envelopeErr = envelopeError(page);
    if (envelopeErr) {
      return { ids: [...ids], readFailure: toHttpReadFailure(envelopeErr), truncated: false };
    }

    const pageIds = page.resources ?? [];
    for (const id of pageIds) ids.add(id);

    cursor = readCursor(page.meta);

    // Termination is driven by the cursor, not by meta.pagination.total. An
    // earlier version fell back to `total = ids.length` when pagination was
    // absent, which stopped after one page and reported a partial fleet as clean.
    if (pageIds.length === 0 || !cursor) {
      // A page filled to the limit with no cursor to continue from is far more
      // likely a changed response shape than an exact multiple of the page size.
      // Stopping quietly here is what "reported a partial fleet as clean" looks
      // like, so treat it as a failed read instead.
      if (pageIds.length >= DEVICE_QUERY_LIMIT && !cursor) {
        return {
          ids: [...ids],
          readFailure: toHttpReadFailure(
            new Error(
              `Falcon returned a full page of ${pageIds.length} devices with no pagination cursor, so the remaining devices could not be listed.`,
            ),
          ),
          truncated: false,
        };
      }
      return { ids: [...ids], truncated: false };
    }
  }

  ctx.warn(`Stopped after ${MAX_DEVICE_PAGES} pages of Falcon devices; results are partial.`);
  return { ids: [...ids], truncated: true };
}

/** Days since an ISO timestamp, or undefined when it is missing/unparseable. */
function daysSince(timestamp: string | undefined, now: number): number | undefined {
  if (!timestamp) return undefined;
  const seen = Date.parse(timestamp);
  if (Number.isNaN(seen)) return undefined;
  return (now - seen) / 86_400_000;
}

export const sensorHealthCheck: IntegrationCheck = {
  // Renamed from 'sensor-coverage' before this connector shipped anywhere, so
  // no stored results are orphaned. The old id claimed coverage, which this
  // check cannot measure — see the scope note above.
  id: 'sensor-health',
  name: 'Falcon sensor healthy on enrolled devices',
  description:
    'Verify every endpoint enrolled in CrowdStrike Falcon is running a sensor that is checking in and not in reduced functionality mode. Does not prove that every company device is enrolled.',
  taskMapping: TASK_TEMPLATES.secureDevices,
  defaultSeverity: 'high',

  variables: [staleAfterDaysVariable],

  run: async (ctx: CheckContext) => {
    ctx.log('Starting CrowdStrike sensor health check');

    const configured = Number(ctx.variables.stale_after_days);
    const staleAfterDays =
      Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALE_AFTER_DAYS;

    let token: string;
    let baseUrl: string;
    try {
      baseUrl = falconBaseUrl(ctx);
      token = await getFalconToken(ctx);
    } catch (err) {
      // Without this, an auth failure throws, the run records zero findings, and
      // the scheduler stores it as a *successful* run
      // (apps/api/src/trigger/integration-platform/run-connection-checks.ts).

      // A malformed connection is not a read failure. Routing it through
      // remediationForReadFailure would tell the customer to "re-run the check,
      // and contact support if it keeps failing" — advice that can never fix a
      // wrong region, because the stored value is the problem.
      if (isFalconConfigError(err)) {
        ctx.fail({
          title: 'Could not verify Falcon sensor health',
          description: `This CrowdStrike connection is not configured correctly, so no device was evaluated (${err.message})`,
          resourceType: 'falcon-tenant',
          resourceId: 'tenant',
          severity: 'high',
          remediation:
            'Reconnect the CrowdStrike integration and re-enter the Client ID, Client Secret, and the Falcon cloud shown in your Falcon console URL. A key issued in one region is rejected by every other region.',
          evidence: { configError: err.message },
        });
        return;
      }

      const failure = toHttpReadFailure(err);
      ctx.fail({
        title: 'Could not verify Falcon sensor health',
        description: `CrowdStrike could not be authenticated, so no device was evaluated (${failure.error}).`,
        resourceType: 'falcon-tenant',
        resourceId: 'tenant',
        severity: 'high',
        remediation: remediationForReadFailure(failure, GRANT_REMEDIATION),
        evidence: { readError: failure.error },
      });
      return;
    }

    const headers = falconAuthHeaders(token);

    const { ids: deviceIds, readFailure, truncated } = await listEnrolledDeviceIds(
      ctx,
      baseUrl,
      headers,
    );

    if (readFailure) {
      ctx.fail({
        title: 'Could not verify Falcon sensor health',
        description: `The list of devices enrolled in Falcon could not be read, so sensor health was not verified (${readFailure.error}).`,
        resourceType: 'falcon-tenant',
        resourceId: 'tenant',
        severity: 'high',
        remediation: remediationForReadFailure(readFailure, GRANT_REMEDIATION),
        evidence: { readError: readFailure.error, devicesReadBeforeFailure: deviceIds.length },
      });
      return;
    }

    ctx.log(`Found ${deviceIds.length} devices enrolled in Falcon`);

    if (truncated) {
      ctx.fail({
        title: 'Falcon device list was truncated',
        description: `Paging stopped at the ${MAX_DEVICE_PAGES}-page safety cap, so some enrolled devices were not evaluated.`,
        resourceType: 'falcon-tenant',
        resourceId: 'tenant',
        severity: 'medium',
        remediation:
          'Re-run the check. If this keeps happening the tenant is larger than this check currently supports — raise it with support so paging can be extended.',
        evidence: { devicesEvaluated: deviceIds.length, pageCap: MAX_DEVICE_PAGES },
      });
    }

    if (deviceIds.length === 0) {
      ctx.fail({
        title: 'No devices are enrolled in CrowdStrike Falcon',
        description:
          'Falcon returned no managed devices, so there is no endpoint protection to evidence.',
        resourceType: 'falcon-tenant',
        resourceId: 'tenant',
        severity: 'high',
        remediation:
          '1. In the Falcon console, check Host Management for enrolled devices\n' +
          '2. Deploy the sensor to company devices that are missing it',
        evidence: { deviceCount: 0 },
      });
      return;
    }

    const now = Date.now();

    for (let i = 0; i < deviceIds.length; i += DEVICE_DETAIL_BATCH_SIZE) {
      const batch = deviceIds.slice(i, i + DEVICE_DETAIL_BATCH_SIZE);

      // Falcon expects `ids` repeated once per device (?ids=a&ids=b), not a
      // single comma-joined value — it reads a comma-joined string as one id and
      // rejects it with "invalid device id". ctx.fetch's `params` is a
      // Record<string, string> and so cannot express a repeated key, so the
      // query string is built onto the path instead.
      const idsQuery = batch.map((id) => `ids=${encodeURIComponent(id)}`).join('&');

      let details: FalconEnvelope<FalconDevice[]>;
      try {
        details = await ctx.fetch<FalconEnvelope<FalconDevice[]>>(
          `/devices/entities/devices/v2?${idsQuery}`,
          { baseUrl, headers },
        );
      } catch (err) {
        const failure = toHttpReadFailure(err);
        ctx.fail({
          title: 'Could not verify sensor health for some devices',
          description: `Details for ${batch.length} enrolled device(s) could not be read (${failure.error}).`,
          resourceType: 'falcon-device-batch',
          resourceId: `batch-${i / DEVICE_DETAIL_BATCH_SIZE}`,
          severity: 'high',
          remediation: remediationForReadFailure(failure, GRANT_REMEDIATION),
          evidence: { readError: failure.error, deviceIds: batch },
        });
        continue;
      }

      const envelopeErr = envelopeError(details);
      if (envelopeErr) {
        const failure = toHttpReadFailure(envelopeErr);
        ctx.fail({
          title: 'Could not verify sensor health for some devices',
          description: `Falcon reported an error while returning device details (${failure.error}).`,
          resourceType: 'falcon-device-batch',
          resourceId: `batch-${i / DEVICE_DETAIL_BATCH_SIZE}`,
          severity: 'high',
          remediation: remediationForReadFailure(failure, GRANT_REMEDIATION),
          evidence: { readError: failure.error, deviceIds: batch },
        });
        continue;
      }

      const returned = details.resources ?? [];
      const returnedIds = new Set(returned.map((d) => d.device_id));

      // A device that was listed as enrolled but has no detail record would
      // otherwise be neither passed nor failed — it would simply vanish from the
      // results and the run would look clean.
      for (const missing of batch.filter((id) => !returnedIds.has(id))) {
        ctx.fail({
          title: 'Sensor health could not be verified for an enrolled device',
          description:
            'Falcon listed this device as enrolled but returned no details for it, so its sensor health is unknown.',
          resourceType: 'device',
          resourceId: missing,
          severity: 'medium',
          remediation:
            'Re-run the check. If the device is still missing, open it in Falcon → Host Management to confirm it still exists and is visible to this API client.',
          evidence: { deviceId: missing, detailsReturned: false },
        });
      }

      for (const device of returned) {
        const label = device.hostname || device.device_id;
        const rfm = device.reduced_functionality_mode;
        const staleDays = daysSince(device.last_seen, now);

        const evidence = {
          hostname: device.hostname,
          serialNumber: device.serial_number,
          platform: device.platform_name,
          osVersion: device.os_version,
          agentVersion: device.agent_version,
          reducedFunctionalityMode: rfm ?? null,
          lastSeen: device.last_seen ?? null,
          daysSinceLastSeen: staleDays === undefined ? null : Math.floor(staleDays),
          // Containment state, recorded for context. Deliberately not part of the
          // health decision: a host contained during incident response has a
          // perfectly healthy sensor.
          containmentStatus: device.status ?? null,
        };

        // Unknown beats a guess in both directions: asserting a healthy sensor
        // hides a real gap, and asserting a degraded one sends people chasing a
        // machine that is fine.
        if (rfm !== 'yes' && rfm !== 'no') {
          ctx.fail({
            title: `${label} sensor health could not be verified`,
            description:
              'Falcon did not report whether this sensor is in reduced functionality mode, so it cannot be confirmed as protecting the device.',
            resourceType: 'device',
            resourceId: device.device_id,
            severity: 'medium',
            remediation:
              'Open the device in Falcon → Host Management and confirm the sensor is reporting. If it is, re-run the check.',
            evidence,
          });
          continue;
        }

        if (staleDays === undefined) {
          ctx.fail({
            title: `${label} sensor health could not be verified`,
            description:
              'Falcon reported no usable last check-in time for this device, so it cannot be confirmed as reporting.',
            resourceType: 'device',
            resourceId: device.device_id,
            severity: 'medium',
            remediation:
              'Open the device in Falcon → Host Management and confirm the sensor is checking in, then re-run the check.',
            evidence,
          });
          continue;
        }

        if (rfm === 'yes') {
          ctx.fail({
            title: `${label} is not fully protected`,
            description:
              'The Falcon sensor is running in reduced functionality mode, so prevention is degraded.',
            resourceType: 'device',
            resourceId: device.device_id,
            severity: 'high',
            remediation:
              '1. Open the device in Falcon → Host Management\n' +
              '2. Update the sensor to a version supported on this OS release — reduced functionality mode is most often an OS upgrade running ahead of the sensor\n' +
              '3. Re-run the check once the sensor reports normally',
            evidence,
          });
          continue;
        }

        if (staleDays > staleAfterDays) {
          ctx.fail({
            title: `${label} has not checked in for ${Math.floor(staleDays)} days`,
            description: `The Falcon sensor last reported ${Math.floor(staleDays)} days ago, beyond the ${staleAfterDays}-day threshold, so this device is not currently known to be protected.`,
            resourceType: 'device',
            resourceId: device.device_id,
            severity: 'high',
            remediation:
              '1. Confirm the device is still in use — if it has been decommissioned, remove it from Falcon\n' +
              '2. If it is in use, bring it online and confirm the sensor is running\n' +
              '3. Re-run the check once it has checked in',
            evidence,
          });
          continue;
        }

        ctx.pass({
          title: `${label} is protected`,
          description: `Falcon sensor ${device.agent_version ?? '(unknown version)'} is installed, not in reduced functionality mode, and last checked in ${Math.floor(staleDays)} day(s) ago.`,
          resourceType: 'device',
          resourceId: device.device_id,
          evidence,
        });
      }
    }

    ctx.log('CrowdStrike sensor health check complete');
  },
};
