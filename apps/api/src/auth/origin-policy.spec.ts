import { isStaticTrustedOrigin } from './origin-policy';

describe('isStaticTrustedOrigin', () => {
  const originalTrustedOrigins = process.env.AUTH_TRUSTED_ORIGINS;

  beforeEach(() => {
    delete process.env.AUTH_TRUSTED_ORIGINS;
  });

  afterAll(() => {
    if (originalTrustedOrigins === undefined) {
      delete process.env.AUTH_TRUSTED_ORIGINS;
      return;
    }
    process.env.AUTH_TRUSTED_ORIGINS = originalTrustedOrigins;
  });

  it('trusts HTTPS subdomains of the wildcard domains', () => {
    expect(isStaticTrustedOrigin('https://anything.trycomp.ai')).toBe(true);
    expect(isStaticTrustedOrigin('https://anything.staging.trycomp.ai')).toBe(true);
    expect(isStaticTrustedOrigin('https://anything.trust.inc')).toBe(true);
    expect(isStaticTrustedOrigin('https://trust.inc')).toBe(true);
  });

  it('does not extend the wildcard match to plain HTTP', () => {
    expect(isStaticTrustedOrigin('http://anything.trycomp.ai')).toBe(false);
    expect(isStaticTrustedOrigin('http://anything.staging.trycomp.ai')).toBe(false);
    expect(isStaticTrustedOrigin('http://anything.trust.inc')).toBe(false);
    expect(isStaticTrustedOrigin('http://trust.inc')).toBe(false);
  });

  it('still trusts the explicitly listed http localhost origins', () => {
    expect(isStaticTrustedOrigin('http://localhost:3000')).toBe(true);
    expect(isStaticTrustedOrigin('http://localhost:3333')).toBe(true);
  });

  it('honours an explicit AUTH_TRUSTED_ORIGINS list', () => {
    process.env.AUTH_TRUSTED_ORIGINS = 'http://localhost:4000';
    expect(isStaticTrustedOrigin('http://localhost:4000')).toBe(true);
    expect(isStaticTrustedOrigin('http://localhost:3000')).toBe(false);
  });

  // Operative: once a self-host sets AUTH_TRUSTED_ORIGINS, the hardcoded trycomp.ai/trust.inc
  // wildcard must not still trust origins that were never explicitly listed — but a wildcard
  // entry *within* AUTH_TRUSTED_ORIGINS itself (upstream's own documented example value, see
  // .env.example) must still work, since Array.includes() alone never matches it.
  it('honours a wildcard entry within AUTH_TRUSTED_ORIGINS but drops the hardcoded wildcard', () => {
    process.env.AUTH_TRUSTED_ORIGINS = 'http://localhost:3000,https://*.trycomp.ai,http://localhost:3002';
    expect(isStaticTrustedOrigin('http://localhost:3000')).toBe(true);
    expect(isStaticTrustedOrigin('https://anything.trycomp.ai')).toBe(true);
    expect(isStaticTrustedOrigin('http://anything.trycomp.ai')).toBe(false); // wrong protocol
    expect(isStaticTrustedOrigin('https://anything.trust.inc')).toBe(false); // not in the list
  });

  it('does not fall back to the trycomp.ai/trust.inc wildcard once AUTH_TRUSTED_ORIGINS is set (no wildcard entry)', () => {
    process.env.AUTH_TRUSTED_ORIGINS = 'https://comp.example.com';
    expect(isStaticTrustedOrigin('https://comp.example.com')).toBe(true);
    expect(isStaticTrustedOrigin('https://anything.trycomp.ai')).toBe(false);
    expect(isStaticTrustedOrigin('https://anything.trust.inc')).toBe(false);
  });

  it('rejects unrelated and malformed origins', () => {
    expect(isStaticTrustedOrigin('https://trycomp.ai.untrusted.example')).toBe(false);
    expect(isStaticTrustedOrigin('https://nottrust.inc')).toBe(false);
    expect(isStaticTrustedOrigin('not-a-url')).toBe(false);
    expect(isStaticTrustedOrigin('')).toBe(false);
  });
});
