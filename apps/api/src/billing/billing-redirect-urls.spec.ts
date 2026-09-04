import { BadRequestException } from '@nestjs/common';
import { validateBillingRedirectUrl } from './billing-redirect-urls';

describe('validateBillingRedirectUrl', () => {
  it('allows http only for local development hosts', () => {
    expect(() =>
      validateBillingRedirectUrl('http://localhost:3000/org_1/billing'),
    ).not.toThrow();

    expect(() =>
      validateBillingRedirectUrl('http://app.trycomp.ai/org_1/billing'),
    ).toThrow(BadRequestException);
  });
});

// Operative: NEXT_PUBLIC_APP_URL is read once at module load, so this scenario needs its own
// module instance (jest.resetModules() + isolateModules) — see billing-redirect-urls.ts.
describe('validateBillingRedirectUrl with NEXT_PUBLIC_APP_URL set', () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.resetModules();
  });

  it('trusts the exact host derived from NEXT_PUBLIC_APP_URL', () => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, NEXT_PUBLIC_APP_URL: 'https://comp.example.com' };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { validateBillingRedirectUrl: validate } = require('./billing-redirect-urls');

    expect(() =>
      validate('https://comp.example.com/org_1/billing'),
    ).not.toThrow();
    // Unrelated hosts, including subdomains, are still rejected — no wildcard.
    expect(() =>
      validate('https://evil.comp.example.com/org_1/billing'),
    ).toThrow(BadRequestException);
    // The upstream hosts remain trusted alongside the new one, not replaced by it.
    expect(() =>
      validate('https://app.trycomp.ai/org_1/billing'),
    ).not.toThrow();
  });
});
