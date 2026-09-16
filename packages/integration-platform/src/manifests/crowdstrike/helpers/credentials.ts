/**
 * Reading and validating what the user stored on the connection.
 *
 * Split from api-client.ts to keep both inside the repo's 300-line ceiling.
 */

import type { CheckContext } from '../../../types';
import type { FalconCloud, FalconCredentials } from '../types';
import { FalconConfigError } from './errors';

/**
 * Falcon is region-partitioned: a token issued in one cloud is not valid in
 * another, and each cloud has its own API host. US-2 confirmed against a live
 * tenant; the rest from
 * https://developer.crowdstrike.com/api-reference/introduction/#base-urls
 *
 * A Map (rather than an object literal) so a credential value like
 * "constructor" or "__proto__" cannot index into Object.prototype and yield a
 * bogus host.
 */
const FALCON_HOSTS = new Map<FalconCloud, string>([
  ['us-1', 'https://api.crowdstrike.com'],
  ['us-2', 'https://api.us-2.crowdstrike.com'],
  ['us-3', 'https://api.us-3.crowdstrike.com'],
  ['eu-1', 'https://api.eu-1.crowdstrike.com'],
  ['us-gov-1', 'https://api.laggar.gcw.crowdstrike.com'],
  ['us-gov-2', 'https://api.us-gov-2.crowdstrike.mil'],
]);

/** The regions this integration accepts, for error messages and the selector. */
export const FALCON_CLOUDS: readonly FalconCloud[] = [...FALCON_HOSTS.keys()];

function credentialString(
  credentials: Record<string, string | string[]> | undefined,
  key: string,
): string | undefined {
  const raw = credentials?.[key];
  // ctx.credentials is Record<string, string | string[]>. A stored array would
  // otherwise reach .trim() and throw a TypeError that reads like a Falcon bug.
  if (Array.isArray(raw)) {
    throw new FalconConfigError(
      `CrowdStrike credential "${key}" is a list, but a single value is required. ` +
        'Reconnect the integration and enter the value once.',
    );
  }
  return typeof raw === 'string' ? raw.trim() : undefined;
}

export function readCredentials(ctx: CheckContext): FalconCredentials {
  const credentials = ctx.credentials ?? {};

  const client_id = credentialString(credentials, 'client_id');
  const client_secret = credentialString(credentials, 'client_secret');
  const cloud = credentialString(credentials, 'cloud');

  if (!client_id || !client_secret) {
    throw new FalconConfigError(
      'CrowdStrike credentials are incomplete — both Client ID and Client Secret are required.',
    );
  }

  // Deliberately no default. Falcon rejects a token minted in the wrong cloud,
  // and silently falling back to US-1 sent a US-2 tenant's credentials to the
  // wrong host and surfaced as an unexplained 401 on every device read.
  if (!cloud) {
    throw new FalconConfigError(
      'CrowdStrike Falcon cloud is not set on this connection. ' +
        'Reconnect and choose the region shown in your Falcon console URL.',
    );
  }

  if (!FALCON_HOSTS.has(cloud as FalconCloud)) {
    // The submitted value is deliberately not echoed: this message reaches
    // stored finding evidence, and reflecting a raw credential-record value
    // there is the wrong default even when the field is a select today.
    throw new FalconConfigError(
      'The CrowdStrike Falcon cloud on this connection is not a recognised region. ' +
        `Reconnect and choose one of: ${FALCON_CLOUDS.join(', ')}.`,
    );
  }

  return { client_id, client_secret, cloud: cloud as FalconCloud };
}

/** The API host for this connection's Falcon cloud. */
export function falconBaseUrl(ctx: CheckContext): string {
  const { cloud } = readCredentials(ctx);
  // Non-null: readCredentials has already rejected unknown clouds.
  return FALCON_HOSTS.get(cloud)!;
}
