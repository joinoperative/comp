/**
 * The tenant-level findings this check can emit.
 *
 * Split from sensor-health.ts for the 300-line ceiling, and because the
 * remediation attached to each one is the part most easily got wrong: every
 * exit that evaluated nothing still has to produce a finding, and it has to
 * point at something that can actually fix the cause.
 */

import type { CheckContext } from '../../../types';
import { remediationForReadFailure, type ReadFailure } from '../../http-read-failure';
import type { UnreadableBatch } from './collect';

export const GRANT_REMEDIATION =
  'Grant the Falcon API client the "Hosts: Read" scope (Falcon console → Support and resources → API clients and keys), then re-run the check.';

export const RECONNECT_REMEDIATION =
  'Reconnect the CrowdStrike integration and re-enter the Client ID, Client Secret, and the Falcon cloud shown in your Falcon console URL. A key issued in one region is rejected by every other region.';

const TENANT = { resourceType: 'falcon-tenant', resourceId: 'tenant' } as const;

/** Nothing was evaluated. Always high — a blank run must not read as clean. */
export function failUnverified(
  ctx: CheckContext,
  description: string,
  remediation: string,
  evidence: Record<string, unknown>,
): void {
  ctx.fail({
    title: 'Could not verify Falcon sensor health',
    description,
    ...TENANT,
    severity: 'high',
    remediation,
    evidence,
  });
}

export function reportTruncated(ctx: CheckContext, evaluated: number, pageCap: number): void {
  ctx.fail({
    title: 'Falcon device list was truncated',
    description: `Paging stopped at the ${pageCap}-page safety cap, so some enrolled devices were not evaluated.`,
    ...TENANT,
    severity: 'medium',
    remediation:
      'Re-run the check. If this keeps happening the tenant is larger than this check currently supports — raise it with support so paging can be extended.',
    evidence: { devicesEvaluated: evaluated, pageCap },
  });
}

export function reportNoDevices(ctx: CheckContext): void {
  ctx.fail({
    title: 'No devices are enrolled in CrowdStrike Falcon',
    description:
      'Falcon returned no managed devices, so there is no endpoint protection to evidence.',
    ...TENANT,
    severity: 'high',
    remediation:
      '1. In the Falcon console, check Host Management for enrolled devices\n' +
      '2. Deploy the sensor to company devices that are missing it',
    evidence: { deviceCount: 0 },
  });
}

/**
 * Batches Falcon would not serve.
 *
 * Deliberately separate from `reportUnreturned`, and high rather than medium.
 * Collapsing the two reported a revoked scope as a possible decommission with
 * "re-run the check" as the fix — advice that can never work.
 */
export function reportUnreadable(ctx: CheckContext, unreadable: UnreadableBatch[]): void {
  const ids = unreadable.flatMap((b) => b.ids);
  const failure = unreadable[0]!.failure;

  ctx.fail({
    title: `Sensor health could not be read for ${ids.length} device(s)`,
    description: `Falcon refused or failed the request for these devices, so their sensor health was not verified (${failure.error}).`,
    resourceType: 'falcon-tenant',
    resourceId: 'unreadable-devices',
    severity: 'high',
    remediation: remediationForReadFailure(failure, GRANT_REMEDIATION),
    evidence: { deviceCount: ids.length, deviceIds: ids, readError: failure.error },
  });
}

/** Ids absent from an otherwise successful response — a genuine decommission looks like this. */
export function reportUnreturned(
  ctx: CheckContext,
  unreturned: string[],
  falconErrors: Array<{ code: number; message: string }>,
): void {
  ctx.fail({
    title: `Falcon returned no details for ${unreturned.length} enrolled device(s)`,
    description:
      'These devices were listed as enrolled but Falcon returned no record for them, so their sensor health is unknown. A device decommissioned between the two calls looks exactly like this.',
    resourceType: 'falcon-tenant',
    resourceId: 'unreturned-devices',
    severity: 'medium',
    remediation:
      'Re-run the check. If the same devices are still missing, open them in Falcon → Host Management to confirm they exist and are visible to this API client.',
    evidence: { deviceCount: unreturned.length, deviceIds: unreturned, falconErrors },
  });
}

/**
 * Devices Falcon described too thinly to judge.
 *
 * Aggregated rather than one finding per device: if a missing field correlates
 * with a platform or sensor version, a large tenant would otherwise produce
 * thousands of findings in one run and leave Secure Devices permanently not-done.
 */
export function reportUnverifiedDevices(
  ctx: CheckContext,
  devices: Array<{ deviceId: string; hostname?: string; reason: string }>,
): void {
  ctx.fail({
    title: `Sensor health could not be verified for ${devices.length} device(s)`,
    description:
      'Falcon returned these devices without enough information to confirm their sensors are healthy, so they are neither passed nor failed.',
    resourceType: 'falcon-tenant',
    resourceId: 'unverified-devices',
    severity: 'medium',
    remediation:
      'Open the listed devices in Falcon → Host Management and confirm their sensors are reporting, then re-run the check.',
    evidence: { deviceCount: devices.length, devices },
  });
}

export type { ReadFailure };
