const DEFAULT_TRUSTED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3002',
  'http://localhost:3333',
  'http://localhost:3004',
  'http://localhost:3008',
  'https://app.trycomp.ai',
  'https://portal.trycomp.ai',
  'https://api.trycomp.ai',
  'https://app.staging.trycomp.ai',
  'https://portal.staging.trycomp.ai',
  'https://api.staging.trycomp.ai',
  'https://dev.trycomp.ai',
  'https://framework-editor.trycomp.ai',
];

const COMP_EXTENSION_ALLOWED_ROUTES = [
  { method: 'GET', path: '/api/auth/get-session' },
  { method: 'GET', path: '/v1/auth/me' },
  { method: 'POST', path: '/api/auth/organization/set-active' },
  { method: 'POST', path: '/v1/questionnaire/answer-single' },
];

function parseOriginList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function normalizePath(path: string): string {
  if (path.length <= 1) return path;
  return path.replace(/\/+$/, '');
}

export function getTrustedOrigins(): string[] {
  const origins = parseOriginList(process.env.AUTH_TRUSTED_ORIGINS);
  return origins.length > 0 ? origins : [...DEFAULT_TRUSTED_ORIGINS];
}

export function getCompExtensionTrustedOrigins(): string[] {
  return parseOriginList(process.env.COMP_EXTENSION_TRUSTED_ORIGINS);
}

export function getBetterAuthTrustedOrigins(): string[] {
  return [...getTrustedOrigins(), ...getCompExtensionTrustedOrigins()];
}

export function isCompExtensionOrigin(origin: string): boolean {
  return getCompExtensionTrustedOrigins().includes(origin);
}

export function isChromeExtensionOrigin(origin: string): boolean {
  try {
    return new URL(origin).protocol === 'chrome-extension:';
  } catch {
    return false;
  }
}

export function isCompExtensionAllowedRoute(params: {
  method: string;
  path: string;
}): boolean {
  const method = params.method.toUpperCase();
  const path = normalizePath(params.path);
  return COMP_EXTENSION_ALLOWED_ROUTES.some(
    (route) => route.method === method && route.path === path,
  );
}

export function isCompExtensionOriginAllowedForRequest(params: {
  method: string;
  origin: string;
  path: string;
}): boolean {
  return (
    isCompExtensionOrigin(params.origin) &&
    isCompExtensionAllowedRoute({ method: params.method, path: params.path })
  );
}

// Operative: AUTH_TRUSTED_ORIGINS entries are matched with Array.includes() (exact string
// match) above, which never matches a documented wildcard entry like 'https://*.example.com'.
// Parse and match those explicitly: same protocol, hostname is exactly the suffix or a
// subdomain of it. (An Origin header never has a path, so there's nothing to match there.)
function isWildcardOriginMatch(pattern: string, origin: string): boolean {
  const patternMatch = pattern.match(/^(https?):\/\/\*\.(.+)$/);
  if (!patternMatch) return false;
  const [, protocol, suffixHost] = patternMatch;

  try {
    const url = new URL(origin);
    if (url.protocol !== `${protocol}:`) return false;
    return url.hostname === suffixHost || url.hostname.endsWith(`.${suffixHost}`);
  } catch {
    return false;
  }
}

export function isStaticTrustedOrigin(origin: string): boolean {
  const trustedOrigins = getTrustedOrigins();
  if (trustedOrigins.includes(origin)) {
    return true;
  }

  if (trustedOrigins.some((entry) => isWildcardOriginMatch(entry, origin))) {
    return true;
  }

  // Operative: once AUTH_TRUSTED_ORIGINS is configured (self-hosted forks), only the entries
  // above (including any wildcards among them, matched just above) are trusted — skip the
  // hardcoded trycomp.ai/trust.inc suffix match below, which only makes sense for the
  // unconfigured (upstream) default list.
  if (process.env.AUTH_TRUSTED_ORIGINS) {
    return false;
  }

  try {
    const url = new URL(origin);
    // Only the explicit DEFAULT_TRUSTED_ORIGINS entries above may be plain
    // HTTP (localhost). The wildcard suffix match is HTTPS-only.
    if (url.protocol !== 'https:') return false;
    return (
      url.hostname.endsWith('.trycomp.ai') ||
      url.hostname.endsWith('.staging.trycomp.ai') ||
      url.hostname.endsWith('.trust.inc') ||
      url.hostname === 'trust.inc'
    );
  } catch {
    return false;
  }
}

export function isStaticTrustedOriginForRequest(params: {
  method: string;
  origin: string;
  path: string;
}): boolean {
  return (
    isStaticTrustedOrigin(params.origin) ||
    isCompExtensionOriginAllowedForRequest(params)
  );
}
