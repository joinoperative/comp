import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

function stripSslMode(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  return url.toString();
}

function isLocalhostUrl(connectionString: string): boolean {
  try {
    const { hostname } = new URL(connectionString);
    const stripped = hostname.replace(/^\[/, '').replace(/\]$/, '');
    return LOCAL_HOSTNAMES.has(stripped);
  } catch {
    return false;
  }
}

// Operative: parse a positive-integer pool-size env var, ignoring (with a console warning)
// anything that isn't one instead of passing NaN/0/a negative number through to pg.Pool.
function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `[db] Ignoring invalid ${name}="${raw}" (must be a positive integer); using default ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
}

function createPrismaClient(): PrismaClient {
  const rawUrl = process.env.DATABASE_URL!;
  const isLocalhost = isLocalhostUrl(rawUrl);
  const allowInsecure = process.env.PRISMA_ALLOW_INSECURE_TLS === '1';

  // Verified TLS via Node's default trust store, which includes Amazon Root
  // CA 1 — where AWS RDS Proxy chains terminate. Hostname check is skipped
  // because connections traverse an AWS NLB whose hostname isn't in the RDS
  // Proxy cert's SAN list; the chain check still rejects forged or wrong-CA
  // certs. PRISMA_ALLOW_INSECURE_TLS=1 is an explicit opt-out (no silent
  // fallback to unverified TLS).
  //
  // Previously this passed `ca: RDS_CA_BUNDLE` — but `ssl.ca` *replaces*
  // Node's trust store rather than augmenting it, and our bundle only
  // contains regional RDS CAs (not Amazon Root CA 1), so the RDS Proxy
  // chain failed to validate. Surfaced as P1011 TlsConnectionError /
  // "unable to get local issuer certificate" at runtime.
  const ssl: undefined | { checkServerIdentity: () => undefined } | { rejectUnauthorized: false } =
    isLocalhost
      ? undefined
      : allowInsecure
        ? { rejectUnauthorized: false }
        : { checkServerIdentity: () => undefined };

  const url = ssl !== undefined ? stripSslMode(rawUrl) : rawUrl;
  // Operative: cap the pg pool for small Cloud SQL tiers (e.g. db-g1-small). Defaults
  // (10, 10s) match pg.Pool's own built-in defaults, so behaviour is unchanged when unset.
  const adapter = new PrismaPg({
    connectionString: url,
    ssl,
    max: parsePositiveIntEnv('DB_POOL_MAX', 10),
    idleTimeoutMillis: parsePositiveIntEnv('DB_POOL_IDLE_MS', 10000),
  });
  return new PrismaClient({
    adapter,
    transactionOptions: {
      timeout: 60000,
    },
  });
}

function getClient(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }
  return globalForPrisma.prisma;
}

export const db = new Proxy({} as PrismaClient, {
  get(_target, prop, _receiver) {
    const client = getClient();
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
