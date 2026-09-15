/**
 * API Types for CrowdStrike Falcon
 *
 * These mirror the shapes returned by the Falcon API and cover what the checks
 * in this folder read, not the full response.
 *
 * Every field on `FalconDevice` below was observed on a live US-2 tenant
 * (2026-09-14) by dumping a real device from GET /devices/entities/devices/v2.
 * Reference: https://developer.crowdstrike.com/api-reference/collections/hosts/
 */

/** Credentials collected from the user (see `credentialFields` in index.ts). */
export interface FalconCredentials {
  client_id: string;
  client_secret: string;
  /** Falcon cloud region — determines which API host to call. */
  cloud: FalconCloud;
}

export type FalconCloud = 'us-1' | 'us-2' | 'eu-1' | 'us-gov-1' | 'us-gov-2';

/** Response from POST /oauth2/token */
export interface FalconTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Falcon wraps every response in an envelope.
 *
 * `resources` is optional on purpose: an error envelope can arrive with HTTP
 * 200 and no `resources` key at all, with `errors` carrying per-id failures.
 * Callers must treat a non-empty `errors` as a failed read rather than an empty
 * success — see the reconcile handling in checks/sensor-health.ts.
 */
export interface FalconEnvelope<T> {
  resources?: T;
  errors?: Array<{ code: number; message: string }>;
  meta?: {
    pagination?: {
      /**
       * A number on the offset endpoint, an opaque cursor string on
       * devices-scroll. Only the string form is a usable cursor.
       */
      offset?: number | string;
      limit?: number;
      total?: number;
      /** Opaque cursor returned by /devices/queries/devices-scroll/v1. */
      offset_string?: string;
    };
  };
}

/**
 * A managed endpoint, from GET /devices/entities/devices/v2.
 */
export interface FalconDevice {
  device_id: string;
  hostname?: string;
  platform_name?: string;
  os_version?: string;
  agent_version?: string;
  /** Hardware serial, used to join Falcon hosts to Comp's own Device records. */
  serial_number?: string;
  /**
   * Containment state — `normal`, `containment_pending`, `contained` or
   * `lift_containment_pending`. This is NOT sensor health: a host deliberately
   * network-contained during incident response reports a non-`normal` status
   * while its sensor is perfectly healthy. Recorded as evidence only.
   */
  status?: string;
  /** ISO timestamp of the sensor's last check-in. Drives the staleness test. */
  last_seen?: string;
  first_seen?: string;
  /**
   * 'yes' when the sensor is running in reduced functionality mode (prevention
   * degraded), 'no' when healthy. Falcon sends this as a string, never a
   * boolean — `Boolean('no')` is true, so it must be compared explicitly.
   * The field can also be absent, which is treated as unknown rather than
   * healthy.
   */
  reduced_functionality_mode?: string;
}
