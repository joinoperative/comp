/**
 * CrowdStrike Falcon token exchange.
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
 *   const devices = await ctx.fetch('/devices/queries/devices-scroll/v1', {
 *     baseUrl: falconBaseUrl(ctx),
 *     headers: falconAuthHeaders(token),
 *   });
 *
 * This mirrors the pattern in manifests/azure/helpers/azure-client.ts.
 *
 * The token exchange cannot go through `ctx.fetch` (that prepends the manifest
 * baseUrl and is shaped for JSON), so the retry/timeout behaviour `ctx.fetch`
 * provides is reimplemented here rather than skipped.
 *
 * Credential validation lives in credentials.ts, error kinds in errors.ts.
 */

import { createHash } from 'crypto';
import type { CheckContext } from '../../../types';
import type { FalconCredentials, FalconTokenResponse } from '../types';
import { falconBaseUrl, readCredentials } from './credentials';
import { FalconAuthError } from './errors';

export { FALCON_CLOUDS, falconBaseUrl, readCredentials } from './credentials';
export {
  FalconAuthError,
  FalconConfigError,
  isFalconAuthError,
  isFalconConfigError,
} from './errors';

/** Token requests get their own deadline; a check run should not hang on auth. */
const TOKEN_TIMEOUT_MS = 15_000;
const TOKEN_MAX_RETRIES = 2;
const TOKEN_INITIAL_RETRY_DELAY_MS = 500;

/**
 * Falcon's token rate-limit window is tens of seconds and it advertises the
 * wait. Honour it, but never sleep longer than this — a check run should fail
 * with a diagnosable finding rather than hang for minutes.
 */
const TOKEN_MAX_RETRY_AFTER_MS = 30_000;

/** Refresh this far before real expiry so a long run cannot use a dead token. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One token per credential per run. Falcon rate-limits token creation, so
 * minting a fresh token for every check in a run is a good way to get throttled.
 *
 * Keyed by a digest of the credentials, NOT by connection id: credentials are
 * rotated in place (PUT /v1/integrations/connections/:id/credentials), and a
 * connection-keyed cache would keep serving a revoked token for the rest of its
 * lifetime — or, if the rotation points at a different Falcon tenant in the same
 * cloud, read the previous tenant's hosts and store them as this org's evidence.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function cacheKey(credentials: FalconCredentials): string {
  const digest = createHash('sha256')
    .update(`${credentials.client_id}:${credentials.client_secret}`)
    .digest('hex')
    .slice(0, 32);
  return `${credentials.cloud}:${digest}`;
}

/** Drop expired entries so a long-lived process does not accumulate them. */
function evictExpired(now: number): void {
  for (const [key, entry] of tokenCache) {
    if (entry.expiresAt <= now) tokenCache.delete(key);
  }
}

/**
 * Drop the cached token for this connection's credentials.
 *
 * Call this when Falcon rejects a call with 401 mid-run: the cached token is
 * either revoked or was minted against credentials that have since been
 * rotated, and keeping it poisons every later call in the process.
 */
export function invalidateFalconToken(ctx: CheckContext): void {
  try {
    tokenCache.delete(cacheKey(readCredentials(ctx)));
  } catch {
    // Unreadable credentials mean there is nothing cached to drop.
  }
}

/** Test seam — the cache is module state shared across runs in one process. */
export function clearFalconTokenCache(): void {
  tokenCache.clear();
}

/** Milliseconds to wait, from whichever rate-limit header Falcon sent. */
function retryAfterMs(response: Response, now: number): number | undefined {
  // Falcon's documented header for the token endpoint is an epoch seconds value.
  const falcon = response.headers.get('X-RateLimit-RetryAfter');
  if (falcon) {
    const epochSeconds = Number(falcon);
    if (Number.isFinite(epochSeconds)) {
      const waitMs = epochSeconds * 1000 - now;
      if (waitMs > 0) return Math.min(waitMs, TOKEN_MAX_RETRY_AFTER_MS);
    }
  }

  const standard = response.headers.get('Retry-After');
  if (standard) {
    const seconds = Number(standard);
    const waitMs = Number.isFinite(seconds) ? seconds * 1000 : new Date(standard).getTime() - now;
    if (waitMs > 0) return Math.min(waitMs, TOKEN_MAX_RETRY_AFTER_MS);
  }

  return undefined;
}

/**
 * Exchange the Client ID and Secret for a bearer token.
 *
 * Retries 429/5xx and transport blips with backoff, honouring Falcon's
 * rate-limit headers. Tokens are reused for the rest of the run, honouring
 * `expires_in` less a safety margin.
 *
 * Throws FalconAuthError for 400/401/403 — a rejected exchange means bad
 * credentials or the wrong region, and no scope change fixes it.
 */
export async function getFalconToken(ctx: CheckContext): Promise<string> {
  const credentials = readCredentials(ctx);
  const { client_id, client_secret } = credentials;

  const now = Date.now();
  evictExpired(now);

  const key = cacheKey(credentials);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > now) {
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
      if (attempt < TOKEN_MAX_RETRIES) {
        await sleep(TOKEN_INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt));
      }
      continue;
    }

    if (response.status === 400 || response.status === 401 || response.status === 403) {
      // Deliberately does not echo the response body — a Falcon auth error can
      // repeat the client_id back, and check logs are stored and shown in the UI.
      throw new FalconAuthError(
        `CrowdStrike rejected these credentials (HTTP ${response.status}). ` +
          'Check the Client ID and Secret, and that the selected Falcon cloud matches ' +
          'the region in your Falcon console URL.',
        response.status,
      );
    }

    if (!response.ok) {
      const error = new Error(`CrowdStrike authentication failed (HTTP ${response.status}).`);
      (error as Error & { status: number }).status = response.status;
      lastError = error;

      // Only throttling and server faults are worth another attempt. Retrying
      // a permanent 404/405/422 burns the budget and delays the diagnosis.
      const retryable = response.status === 429 || response.status >= 500;

      if (retryable && attempt < TOKEN_MAX_RETRIES) {
        const advised = retryAfterMs(response, Date.now());
        await sleep(advised ?? TOKEN_INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      throw error;
    }

    const data = (await response.json()) as FalconTokenResponse;

    if (!data.access_token) {
      throw new Error('CrowdStrike returned no access token.');
    }

    const lifetimeMs = (data.expires_in ?? 0) * 1000;
    tokenCache.set(key, {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(0, lifetimeMs - TOKEN_EXPIRY_SKEW_MS),
    });

    return data.access_token;
  }

  throw lastError ?? new Error('CrowdStrike authentication failed.');
}

/** Headers to pass to `ctx.fetch` for an authenticated Falcon call. */
export function falconAuthHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
