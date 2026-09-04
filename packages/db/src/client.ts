import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { resolveSslConfig } from './ssl-config';

export type { SslConfig } from './ssl-config';
export { resolveSslConfig } from './ssl-config';

const globalForPrisma = global as unknown as { prisma?: PrismaClient };

function stripSslMode(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  return url.toString();
}

/**
 * Operative: parse a positive-integer pool-size env var, ignoring (with a console warning)
 * anything that isn't one instead of passing NaN/0/a negative number through to pg.Pool.
 * Exported (and env passed as a parameter) so it's unit-testable without touching process.env.
 */
export function parsePositiveIntEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
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

/**
 * Operative: pg pool size, capped for small Cloud SQL tiers (e.g. db-g1-small). Defaults (10,
 * 10s) match pg.Pool's own built-in defaults, so behaviour is unchanged when these are unset.
 */
export function resolvePoolConfig(env: Record<string, string | undefined>): {
  max: number;
  idleTimeoutMillis: number;
} {
  return {
    max: parsePositiveIntEnv(env, 'DB_POOL_MAX', 10),
    idleTimeoutMillis: parsePositiveIntEnv(env, 'DB_POOL_IDLE_MS', 10000),
  };
}

function createPrismaClient(): PrismaClient {
  const rawUrl = process.env.DATABASE_URL!;
  const ssl = resolveSslConfig(rawUrl);
  const url = ssl !== undefined ? stripSslMode(rawUrl) : rawUrl;
  const pool = resolvePoolConfig(process.env);
  const adapter = new PrismaPg({
    connectionString: url,
    ssl,
    max: pool.max,
    idleTimeoutMillis: pool.idleTimeoutMillis,
  });
  return new PrismaClient({
    adapter,
    transactionOptions: { timeout: 60000 },
  });
}

// Lazy initialization. Importing this module does NOT construct a Prisma client
// — that only happens on first property access on `db`. Critical so that
// Next.js `next build` (which imports every route handler to analyze it) does
// not trigger the strict TLS check at build time when no actual queries run.
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
