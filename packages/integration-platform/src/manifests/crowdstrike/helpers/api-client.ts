/**
 * CrowdStrike Falcon API client helpers.
 *
 * Falcon uses OAuth 2.0 *client credentials* — a machine-to-machine exchange,
 * not the browser redirect flow. The user pastes a Client ID and Secret, and we
 * trade those for a short-lived bearer token on every run.
 *
 * That is why this manifest declares `auth: { type: 'custom' }`. The platform
 * only attaches an Authorization header automatically for `oauth2`, `api_key`
 * and `basic` auth (see runtime/check-context.ts), so checks here must pass the
 * token themselves:
 *
 *   const token = await getFalconToken(ctx);
 *   const devices = await ctx.fetch('/devices/queries/devices/v1', {
 *     baseUrl: falconBaseUrl(ctx),
 *     headers: falconAuthHeaders(token),
 *   });
 *
 * This mirrors the pattern in manifests/azure/helpers/azure-client.ts.
 */

import type { CheckContext } from '../../../types';
import type { FalconCloud, FalconCredentials, FalconTokenResponse } from '../types';

/**
 * Falcon is region-partitioned: a token issued in one cloud is not valid in
 * another, and each cloud has its own API host.
 *
 * TODO(verify): confirm these hosts for your tenant. The Falcon console shows
 * the correct one under Support → API Clients and Keys.
 */
const FALCON_HOSTS: Record<FalconCloud, string> = {
  'us-1': 'https://api.crowdstrike.com',
  'us-2': 'https://api.us-2.crowdstrike.com',
  'eu-1': 'https://api.eu-1.crowdstrike.com',
  'us-gov-1': 'https://api.laggar.gcw.crowdstrike.com',
};

export const DEFAULT_FALCON_CLOUD: FalconCloud = 'us-1';

function readCredentials(ctx: CheckContext): FalconCredentials {
  const credentials = (ctx.credentials ?? {}) as Partial<FalconCredentials>;

  const client_id = credentials.client_id?.trim();
  const client_secret = credentials.client_secret?.trim();

  if (!client_id || !client_secret) {
    throw new Error(
      'CrowdStrike credentials are incomplete — both Client ID and Client Secret are required.',
    );
  }

  return {
    client_id,
    client_secret,
    cloud: (credentials.cloud as FalconCloud) || DEFAULT_FALCON_CLOUD,
  };
}

/** The API host for this connection's Falcon cloud. */
export function falconBaseUrl(ctx: CheckContext): string {
  const { cloud } = readCredentials(ctx);
  return FALCON_HOSTS[cloud] ?? FALCON_HOSTS[DEFAULT_FALCON_CLOUD];
}

/**
 * Exchange the Client ID and Secret for a bearer token.
 *
 * Tokens are short-lived (~30 minutes). A check run is far shorter than that,
 * so we fetch once per check rather than caching across runs.
 */
export async function getFalconToken(ctx: CheckContext): Promise<string> {
  const { client_id, client_secret } = readCredentials(ctx);
  const tokenUrl = `${falconBaseUrl(ctx)}/oauth2/token`;

  const body = new URLSearchParams({ client_id, client_secret });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    // Deliberately does not echo the response body — a Falcon auth error can
    // repeat the client_id back, and check logs are stored and shown in the UI.
    throw new Error(
      `CrowdStrike authentication failed (HTTP ${response.status}). ` +
        'Check the Client ID, Secret, and that the API client has the required read scopes.',
    );
  }

  const data = (await response.json()) as FalconTokenResponse;

  if (!data.access_token) {
    throw new Error('CrowdStrike returned no access token.');
  }

  return data.access_token;
}

/** Headers to pass to `ctx.fetch` for an authenticated Falcon call. */
export function falconAuthHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
