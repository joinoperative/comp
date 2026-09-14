/**
 * API Types for CrowdStrike Falcon
 *
 * These mirror the shapes returned by the Falcon API. Verify each field
 * against https://falcon.crowdstrike.com/documentation before relying on it —
 * the fields below cover what the checks in this folder read, not the full
 * response.
 */

/** Credentials collected from the user (see `credentialFields` in index.ts). */
export interface FalconCredentials {
  client_id: string;
  client_secret: string;
  /** Falcon cloud region — determines which API host to call. */
  cloud: FalconCloud;
}

export type FalconCloud = 'us-1' | 'us-2' | 'eu-1' | 'us-gov-1';

/** Response from POST /oauth2/token */
export interface FalconTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Falcon wraps every response in an envelope. `resources` holds the payload,
 * `errors` is empty on success.
 */
export interface FalconEnvelope<T> {
  resources: T;
  errors?: Array<{ code: number; message: string }>;
  meta?: {
    pagination?: {
      offset: number;
      limit: number;
      total: number;
    };
  };
}

/**
 * A managed endpoint, from GET /devices/entities/devices/v2.
 *
 * TODO(verify): confirm field names against the Falcon docs once you have
 * credentials — dump one real device and compare.
 */
export interface FalconDevice {
  device_id: string;
  hostname?: string;
  platform_name?: string;
  os_version?: string;
  agent_version?: string;
  /** 'normal' means the sensor is healthy and reporting. */
  status?: string;
  last_seen?: string;
  first_seen?: string;
  /** Set when the sensor is running degraded (RFM). */
  reduced_functionality_mode?: string;
}
