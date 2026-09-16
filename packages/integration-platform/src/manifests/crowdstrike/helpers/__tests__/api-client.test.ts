import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { CheckContext } from '../../../../types';
import {
  clearFalconTokenCache,
  falconBaseUrl,
  getFalconToken,
  invalidateFalconToken,
  isFalconAuthError,
  isFalconConfigError,
} from '../api-client';

const originalFetch = globalThis.fetch;

interface Call {
  url: string;
  body: string;
}

/** Queue of responses; the last one repeats once exhausted. */
function stubFetch(responses: Array<() => Response>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? '') });
    const make = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return make();
  }) as typeof globalThis.fetch;
  return calls;
}

const ok = (token = 'tok', expiresIn = 1799) =>
  new Response(JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: 'bearer' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const status = (code: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ errors: [{ message: 'client_id 1234secret is invalid' }] }), {
    status: code,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const ctxWith = (credentials: Record<string, string | string[]>): CheckContext =>
  ({ credentials, connectionId: 'conn_1' }) as unknown as CheckContext;

const validCtx = (overrides: Record<string, string> = {}) =>
  ctxWith({ client_id: 'id', client_secret: 'secret', cloud: 'us-2', ...overrides });

beforeEach(() => clearFalconTokenCache());
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearFalconTokenCache();
});

describe('credential validation', () => {
  it('rejects a missing Falcon cloud rather than defaulting to US-1', async () => {
    // The old default sent a US-2 tenant's credentials to the US-1 host and
    // surfaced as an unexplained 401 on every device read.
    await expect(
      getFalconToken(ctxWith({ client_id: 'a', client_secret: 'b' })),
    ).rejects.toThrow(/Falcon cloud is not set/);
  });

  it('rejects an unrecognised region', async () => {
    await expect(getFalconToken(validCtx({ cloud: 'mars-1' }))).rejects.toThrow(
      /not a recognised region/,
    );
  });

  it('rejects a prototype key as a region', async () => {
    await expect(getFalconToken(validCtx({ cloud: 'constructor' }))).rejects.toThrow(
      /not a recognised region/,
    );
  });

  it('does not echo the submitted region back into the error', async () => {
    // That message reaches stored finding evidence; reflecting a raw
    // credential-record value there is the wrong default.
    await expect(getFalconToken(validCtx({ cloud: 'sneaky-value' }))).rejects.toThrow(
      expect.not.stringContaining('sneaky-value'),
    );
  });

  it('rejects a list-valued credential instead of throwing a TypeError', async () => {
    await expect(
      getFalconToken(ctxWith({ client_id: ['a', 'b'], client_secret: 'b', cloud: 'us-2' })),
    ).rejects.toThrow(/is a list/);
  });

  it('brands config errors so a double-bundled class still matches', async () => {
    const err = await getFalconToken(validCtx({ cloud: 'nope' })).catch((e) => e);
    expect(isFalconConfigError(err)).toBe(true);
    expect(isFalconConfigError({ isFalconConfigError: true })).toBe(true);
  });
});

describe('region routing', () => {
  it.each([
    ['us-1', 'https://api.crowdstrike.com'],
    ['us-2', 'https://api.us-2.crowdstrike.com'],
    ['us-3', 'https://api.us-3.crowdstrike.com'],
    ['eu-1', 'https://api.eu-1.crowdstrike.com'],
    ['us-gov-1', 'https://api.laggar.gcw.crowdstrike.com'],
    ['us-gov-2', 'https://api.us-gov-2.crowdstrike.mil'],
  ])('maps %s to its own host', (cloud, host) => {
    expect(falconBaseUrl(validCtx({ cloud }))).toBe(host);
  });

  it('mints the token against the tenant region, not a default', async () => {
    const calls = stubFetch([() => ok()]);
    await getFalconToken(validCtx({ cloud: 'eu-1' }));
    expect(calls[0]!.url).toBe('https://api.eu-1.crowdstrike.com/oauth2/token');
  });

  it('sends the client credentials grant', async () => {
    const calls = stubFetch([() => ok()]);
    await getFalconToken(validCtx());
    expect(calls[0]!.body).toContain('grant_type=client_credentials');
  });
});

describe('rejected credentials', () => {
  it.each([400, 401, 403])('raises an auth error on %i without retrying', async (code) => {
    const calls = stubFetch([() => status(code)]);
    const err = await getFalconToken(validCtx()).catch((e) => e);

    expect(isFalconAuthError(err)).toBe(true);
    // No scope change fixes a rejected exchange, so it must not be retried or
    // dressed up as a permissions problem.
    expect(calls).toHaveLength(1);
    expect(err.message).toMatch(/Client ID and Secret/);
  });

  it('never echoes the response body, which can repeat the client id back', async () => {
    stubFetch([() => status(401)]);
    const err = await getFalconToken(validCtx()).catch((e) => e);
    expect(err.message).not.toContain('1234secret');
  });
});

describe('retry', () => {
  it('retries a 429 and succeeds', async () => {
    const calls = stubFetch([() => status(429), () => ok()]);
    expect(await getFalconToken(validCtx())).toBe('tok');
    expect(calls).toHaveLength(2);
  });

  it('retries a 5xx and succeeds', async () => {
    const calls = stubFetch([() => status(503), () => ok()]);
    expect(await getFalconToken(validCtx())).toBe('tok');
    expect(calls).toHaveLength(2);
  });

  it("honours Falcon's rate-limit header instead of the default backoff", async () => {
    // Falcon advertises the wait as epoch seconds. Ignoring it burned all three
    // attempts inside 1.5s against a window measured in tens of seconds.
    const soon = String(Date.now() / 1000 + 0.05);
    stubFetch([() => status(429, { 'X-RateLimit-RetryAfter': soon }), () => ok()]);

    const started = Date.now();
    await getFalconToken(validCtx());
    // The default first backoff is 500ms; honouring the header is much shorter.
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('gives up after the retry budget', async () => {
    const calls = stubFetch([() => status(503)]);
    await expect(getFalconToken(validCtx())).rejects.toThrow(/HTTP 503/);
    expect(calls).toHaveLength(3);
  });
});

describe('token cache', () => {
  it('reuses a token rather than re-minting per check', async () => {
    const calls = stubFetch([() => ok()]);
    await getFalconToken(validCtx());
    await getFalconToken(validCtx());
    // Falcon rate-limits token creation, so a run must not mint per check.
    expect(calls).toHaveLength(1);
  });

  it('re-mints when the credentials change, not just the connection', async () => {
    // Keyed by connection id, a rotated secret kept serving the old token for
    // its whole lifetime — and a rotation pointing at another Falcon tenant in
    // the same cloud would read that tenant's hosts as this org's evidence.
    const calls = stubFetch([() => ok('first'), () => ok('second')]);

    expect(await getFalconToken(validCtx({ client_secret: 'original' }))).toBe('first');
    expect(await getFalconToken(validCtx({ client_secret: 'rotated' }))).toBe('second');
    expect(calls).toHaveLength(2);
  });

  it('re-mints after invalidation', async () => {
    const calls = stubFetch([() => ok('first'), () => ok('second')]);
    const ctx = validCtx();

    await getFalconToken(ctx);
    invalidateFalconToken(ctx);
    expect(await getFalconToken(ctx)).toBe('second');
    expect(calls).toHaveLength(2);
  });

  it('does not cache a token that is already within the expiry skew', async () => {
    // expires_in below the 60s safety margin must not be served to a later call.
    const calls = stubFetch([() => ok('short', 30), () => ok('fresh', 1799)]);
    await getFalconToken(validCtx());
    await getFalconToken(validCtx());
    expect(calls).toHaveLength(2);
  });
});
