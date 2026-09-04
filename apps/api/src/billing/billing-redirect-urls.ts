import { BadRequestException } from '@nestjs/common';

// Operative: derive the exact host from NEXT_PUBLIC_APP_URL (no wildcards) so a self-hosted
// deployment's own app host is trusted for Stripe checkout/portal redirects, alongside — not
// instead of — the upstream hosts above. Inert (undefined, filtered out) when unset.
function hostFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

const allowedHosts = new Set(
  [
    'localhost',
    '127.0.0.1',
    'app.trycomp.ai',
    'app.staging.trycomp.ai',
    hostFromUrl(process.env.NEXT_PUBLIC_APP_URL),
  ].filter((host): host is string => !!host),
);
const localDevelopmentHosts = new Set(['localhost', '127.0.0.1']);

export function validateBillingRedirectUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException('Billing redirect URL is invalid.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BadRequestException('Billing redirect URL is invalid.');
  }

  if (!allowedHosts.has(url.hostname)) {
    throw new BadRequestException('Billing redirect URL is not allowed.');
  }

  if (url.protocol === 'http:' && !localDevelopmentHosts.has(url.hostname)) {
    throw new BadRequestException('Billing redirect URL must use HTTPS.');
  }
}
