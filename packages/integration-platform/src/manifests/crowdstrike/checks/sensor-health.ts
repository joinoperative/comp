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
 * task, not in a vendor connector. Until then, every result carries `hostname`
 * and `serialNumber` so a future coverage feature can join on them.
 *
 * Collection lives in collect.ts, the per-device decision in evaluate.ts.
 */

import { TASK_TEMPLATES } from '../../../task-mappings';
import type { CheckContext, CheckVariable, IntegrationCheck } from '../../../types';
import { remediationForReadFailure, toHttpReadFailure } from '../../http-read-failure';
import {
  falconAuthHeaders,
  falconBaseUrl,
  getFalconToken,
  invalidateFalconToken,
  isFalconAuthError,
  isFalconConfigError,
} from '../helpers/api-client';
import { fetchDeviceDetails, listEnrolledDeviceIds, MAX_DEVICE_PAGES } from './collect';
import { DEFAULT_STALE_AFTER_DAYS, evaluateDevice } from './evaluate';
import {
  failUnverified,
  GRANT_REMEDIATION,
  RECONNECT_REMEDIATION,
  reportNoDevices,
  reportTruncated,
  reportUnreadable,
  reportUnreturned,
  reportUnverifiedDevices,
} from './findings';

const staleAfterDaysVariable: CheckVariable = {
  id: 'stale_after_days',
  label: 'Treat a device as stale after (days)',
  type: 'number',
  required: false,
  default: DEFAULT_STALE_AFTER_DAYS,
  helpText:
    'A sensor that has not checked in within this many days is reported as not protecting the device. 30 days avoids flagging laptops that are simply switched off during leave.',
};

async function runSensorHealth(ctx: CheckContext): Promise<void> {
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

    // A malformed connection, or credentials Falcon itself rejected, is not a
    // permissions problem. Routing either through remediationForReadFailure
    // tells the customer to grant "Hosts: Read" or to re-run and contact
    // support — neither of which can fix a wrong region or a revoked key.
    if (isFalconConfigError(err) || isFalconAuthError(err)) {
      failUnverified(
        ctx,
        `CrowdStrike could not be authenticated, so no device was evaluated (${err.message})`,
        RECONNECT_REMEDIATION,
        { configError: err.message },
      );
      return;
    }

    const failure = toHttpReadFailure(err);
    failUnverified(
      ctx,
      `CrowdStrike could not be authenticated, so no device was evaluated (${failure.error}).`,
      remediationForReadFailure(failure, GRANT_REMEDIATION),
      { readError: failure.error },
    );
    return;
  }

  const headers = falconAuthHeaders(token);

  const enrolled = await listEnrolledDeviceIds(ctx, baseUrl, headers);

  if (enrolled.readFailure) {
    // A 401/403 mid-run means the cached token is revoked or was minted against
    // credentials that have since been rotated. Drop it so the next run mints a
    // fresh one rather than replaying a dead token for its whole lifetime.
    if (enrolled.readFailure.denied) invalidateFalconToken(ctx);

    failUnverified(
      ctx,
      `The list of devices enrolled in Falcon could not be read, so sensor health was not verified (${enrolled.readFailure.error}).`,
      remediationForReadFailure(enrolled.readFailure, GRANT_REMEDIATION),
      { readError: enrolled.readFailure.error, devicesReadBeforeFailure: enrolled.ids.length },
    );
    return;
  }

  const deviceIds = enrolled.ids;
  ctx.log(`Found ${deviceIds.length} devices enrolled in Falcon`);

  if (enrolled.truncated) {
    reportTruncated(ctx, deviceIds.length, MAX_DEVICE_PAGES);
  }

  if (deviceIds.length === 0) {
    reportNoDevices(ctx);
    return;
  }

  const details = await fetchDeviceDetails(ctx, baseUrl, headers, deviceIds, async () => {
    // Falcon rejected a batch: the cached token may be revoked, or the
    // credentials rotated mid-run. Drop it and mint once before giving up.
    invalidateFalconToken(ctx);
    return falconAuthHeaders(await getFalconToken(ctx));
  });

  const now = Date.now();
  const unverified: Array<{ deviceId: string; hostname?: string; reason: string }> = [];

  for (const device of details.devices) {
    const { verdict, label, evidence } = evaluateDevice(device, now, staleAfterDays);

    if (verdict.kind === 'degraded') {
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

    if (verdict.kind === 'stale') {
      const days = Math.floor(verdict.staleDays);
      ctx.fail({
        title: `${label} has not checked in for ${days} days`,
        description: `The Falcon sensor last reported ${days} days ago, beyond the ${staleAfterDays}-day threshold, so this device is not currently known to be protected.`,
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

    if (verdict.kind === 'unverified') {
      // Aggregated rather than one finding per device: if a missing field
      // correlates with a platform or sensor version, a large tenant would
      // otherwise produce thousands of findings in a single run and leave
      // Secure Devices permanently not-done.
      unverified.push({
        deviceId: device.device_id,
        hostname: device.hostname,
        reason: verdict.reason,
      });
      continue;
    }

    ctx.pass({
      title: `${label} sensor is healthy`,
      description: `Falcon sensor ${device.agent_version ?? '(unknown version)'} is installed, not in reduced functionality mode, and last checked in ${Math.floor(verdict.staleDays)} day(s) ago.`,
      resourceType: 'device',
      resourceId: device.device_id,
      evidence,
    });
  }

  if (unverified.length) {
    reportUnverifiedDevices(ctx, unverified);
  }

  if (details.unreadable.length) {
    reportUnreadable(ctx, details.unreadable);
  }

  if (details.unreturned.length) {
    reportUnreturned(ctx, details.unreturned, details.envelopeErrors);
  } else if (details.envelopeErrors.length) {
    // Errors alongside a complete `resources` array are not about a specific
    // device, so there is nothing to title a finding after.
    ctx.warn(
      `Falcon reported ${details.envelopeErrors.length} error(s) alongside a complete device response.`,
    );
  }

  ctx.log('CrowdStrike sensor health check complete');
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
    try {
      await runSensorHealth(ctx);
    } catch (err) {
      // Last resort. Any escape from the guarded paths above would otherwise be
      // recorded as a zero-finding run, which the scheduler stores as success —
      // the false-green outcome this whole check is written to avoid.
      const failure = toHttpReadFailure(err);
      failUnverified(
        ctx,
        `The check did not complete, so sensor health was not verified (${failure.error}).`,
        remediationForReadFailure(failure, GRANT_REMEDIATION),
        { readError: failure.error },
      );
    }
  },
};
