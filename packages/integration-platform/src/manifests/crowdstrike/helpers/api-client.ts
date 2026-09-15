/**
 * CrowdStrike Falcon API client helpers.
 *
 * Falcon uses OAuth 2.0 *client credentials* — a machine-to-machine exchange,
 * not the browser redirect flow. The user pastes a Client ID and Secret, and we
 * trade those for a short-lived bearer token.
 *
 * That is why this manifest declares `auth: { type: 'custom' }`. The platform
 * only attaches an Authorization header automatically for `oauth2`, `api_key`
 * and `basic` auth (see runtime/check-context.ts `buildHeaders`), so checks here
 * must pass the token themselves:
 *
 *   const token = await getFalconToken(ctx);
 *   const devices = await ctx.fetch('/devices/queries/devices/v1', {
 *     baseUrl: falconBaseUrl(ctx),
 *     headers: falconAuthHeaders(token),
 *   });
 *
 * This mirrors the pattern in manifests/azure/helpers/azure-client.ts.
 *
 * The token exchange cannot go through `ctx.fetch` (that prepends the manifest
 * baseUrl and is shaped for JSON), so the retry/timeout behaviour `ctx.fetch`
 * provides is reimplemented here rather than skipped.
 */

import type { CheckContext } from '../../../types';
import type { FalconCloud, FalconCredentials, FalconTokenResponse } from '../types';

/**
 * Falcon is region-partitioned: a token issued in one cloud is not valid in
 * another, and each cloud has its own API host. Confirmed against a live US-2
 * tenant; the rest are from
 * https://developer.crowdstrike.com/api-reference/introduction/#base-urls
 *
 * A Map (rather than an object literal) so a credential value like
 * "constructor" or "__proto__" cannot index into Object.prototype and yield a
 * bogus host.
 */
const FALCON_HOSTS = new Map<FalconCloud, string>([
  ['us-1', 'https://api.crowdstrike.com'],
  ['us-2', 'https://api.us-2.crowdstrike.com'],
  ['eu-1', 'https://api.eu-1.crowdstrike.com'],
  ['us-gov-1', 'https://api.laggar.gcw.crowdstrike.com'],
  ['us-gov-2', 'https://api.us-gov-2.crowdstrike.mil'],
]);

/** Token requests get their own deadline; a check run should not hang on auth. */
const TOKEN_TIMEOUT_MS = 15_000;
const TOKEN_MAX_RETRIES = 2;
const TOKEN_INITIAL_RETRY_DELAY_MS = 500;

/** Refresh this far before real expiry so a long run cannot use a dead token. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One token per connection per run. Falcon rate-limits token creation, so
 * minting a fresh token for every check in a run is a good way to get throttled.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function credentialString(
  credentials: Record<string, string | string[]> | undefined,
  key: string,
): string | undefined {
  const raw = credentials?.[key];
  // ctx.credentials is Record<string, string | string[]>. A stored array would
  // otherwise reach .trim() and throw a TypeError that reads like a Falcon bug.
  if (Array.isArray(raw)) {
    throw new Error(
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
    throw new Error(
      'CrowdStrike credentials are incomplete — both Client ID and Client Secret are required.',
    );
  }

  // Deliberately no default. Falcon rejects a token minted in the wrong cloud,
  // and silently falling back to US-1 sent a US-2 tenant's credentials to the
  // wrong host and surfaced as an unexplained 401 on every device read.
  if (!cloud) {
    throw new Error(
      'CrowdStrike Falcon cloud is not set on this connection. ' +
        'Reconnect and choose the region shown in your Falcon console URL.',
    );
  }

  if (!FALCON_HOSTS.has(cloud as FalconCloud)) {
    throw new Error(
      `Unknown CrowdStrike Falcon cloud "${cloud}". ` +
        `Expected one of: ${[...FALCON_HOSTS.keys()].join(', ')}.`,
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

function isRetryableTokenStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Exchange the Client ID and Secret for a bearer token.
 *
 * Retries 429/5xx and transport blips with backoff, mirroring the policy
 * `ctx.fetch` applies (runtime/check-context.ts). Tokens are reused for the rest
 * of the run, honouring `expires_in` less a safety margin.
 */
export async function getFalconToken(ctx: CheckContext): Promise<string> {
  const { client_id, client_secret, cloud } = readCredentials(ctx);

  const cacheKey = `${ctx.connectionId}:${cloud}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const tokenUrl = `${falconBaseUrl(ctx)}/oauth2/token`;
  const body = new URLSearchParams({
    client_id,
    client_secret,
    grant_type: 'client_credentials',
  });

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= TOKEN_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(TOKEN_INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1));
    }

    let response: Response;
    try {
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch (err) {
      // Transport-level only — fetch resolves for any HTTP status.
      lastError = new Error(
        `CrowdStrike authentication could not reach ${new URL(tokenUrl).host} ` +
          `(${err instanceof Error ? err.name : 'network error'}).`,
      );
      continue;
    }

    if (!response.ok) {
      // Deliberately does not echo the response body — a Falcon auth error can
      // repeat the client_id back, and check logs are stored and shown in the UI.
      const error = new Error(
        `CrowdStrike authentication failed (HTTP ${response.status}). ` +
          'Check the Client ID, Secret, the selected Falcon cloud, and that the ' +
          'API client has the Hosts: Read scope.',
      );
      (error as Error & { status: number }).status = response.status;

      if (isRetryableTokenStatus(response.status) && attempt < TOKEN_MAX_RETRIES) {
        lastError = error;
        continue;
      }
      throw error;
    }

    const data = (await response.json()) as FalconTokenResponse;

    if (!data.access_token) {
      throw new Error('CrowdStrike returned no access token.');
    }

    const lifetimeMs = (data.expires_in ?? 0) * 1000;
    tokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(0, lifetimeMs - TOKEN_EXPIRY_SKEW_MS),
    });

    return data.access_token;
  }

  throw lastError ?? new Error('CrowdStrike authentication failed.');
}

/** Drop any cached token for this connection (used by tests). */
export function clearFalconTokenCache(): void {
  tokenCache.clear();
}

/** Headers to pass to `ctx.fetch` for an authenticated Falcon call. */
export function falconAuthHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
