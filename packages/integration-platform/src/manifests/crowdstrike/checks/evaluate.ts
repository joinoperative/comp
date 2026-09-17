/**
 * Deciding whether one Falcon-enrolled device is healthy.
 *
 * Split from sensor-health.ts so the decision rules can be read and tested
 * independently of how devices are collected or how findings are written.
 */

import type { FalconDevice } from '../types';

export const DEFAULT_STALE_AFTER_DAYS = 30;

export type HealthVerdict =
  /** Sensor reporting, not degraded. */
  | { kind: 'healthy'; staleDays: number }
  /** Reduced functionality mode — installed but prevention is degraded. */
  | { kind: 'degraded' }
  /** Has not checked in within the configured window. */
  | { kind: 'stale'; staleDays: number }
  /** Falcon did not report enough to decide either way. */
  | { kind: 'unverified'; reason: string };

export interface DeviceEvaluation {
  verdict: HealthVerdict;
  label: string;
  evidence: Record<string, unknown>;
}

/**
 * Days since an ISO timestamp, or undefined when it is missing/unparseable.
 *
 * Clamped at zero: a device whose clock runs ahead reports a future `last_seen`,
 * and a negative age otherwise renders as "-1 day(s) ago".
 */
export function daysSince(timestamp: string | undefined, now: number): number | undefined {
  if (!timestamp) return undefined;
  const seen = Date.parse(timestamp);
  if (Number.isNaN(seen)) return undefined;
  return Math.max(0, (now - seen) / 86_400_000);
}

export function evaluateDevice(
  device: FalconDevice,
  now: number,
  staleAfterDays: number,
): DeviceEvaluation {
  const rfm = device.reduced_functionality_mode;
  const staleDays = daysSince(device.last_seen, now);

  const evidence: Record<string, unknown> = {
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

  const label = device.hostname || device.device_id;

  // Known failures are reported before unknown metadata. Evaluating in the other
  // order downgraded a device that was BOTH degraded and missing a check-in time
  // to a medium "could not verify", hiding a high-severity failure behind a
  // gap in the same record.
  if (rfm === 'yes') {
    return { verdict: { kind: 'degraded' }, label, evidence };
  }

  if (staleDays !== undefined && staleDays > staleAfterDays) {
    return { verdict: { kind: 'stale', staleDays }, label, evidence };
  }

  // Unknown beats a guess in both directions: asserting a healthy sensor hides a
  // real gap, and asserting a degraded one sends people chasing a machine that
  // is fine. Falcon sends this field as the string 'yes' or 'no' — never a
  // boolean, so `Boolean(rfm)` treats the healthy 'no' as degraded.
  if (rfm !== 'no') {
    return {
      verdict: {
        kind: 'unverified',
        reason: 'Falcon did not report whether the sensor is in reduced functionality mode',
      },
      label,
      evidence,
    };
  }

  if (staleDays === undefined) {
    return {
      verdict: {
        kind: 'unverified',
        reason: 'Falcon reported no usable last check-in time',
      },
      label,
      evidence,
    };
  }

  return { verdict: { kind: 'healthy', staleDays }, label, evidence };
}
