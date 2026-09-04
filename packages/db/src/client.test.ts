import { describe, it, expect, spyOn } from 'bun:test';
import { resolveSslConfig } from './ssl-config';
import { parsePositiveIntEnv, resolvePoolConfig } from './client';

describe('resolveSslConfig', () => {
  it('returns undefined for localhost', () => {
    expect(resolveSslConfig('postgresql://u:p@localhost:5432/x', {})).toBeUndefined();
  });

  it('returns undefined for 127.0.0.1', () => {
    expect(resolveSslConfig('postgresql://u:p@127.0.0.1:5432/x', {})).toBeUndefined();
  });

  it('returns undefined for ::1', () => {
    expect(resolveSslConfig('postgresql://u:p@[::1]:5432/x', {})).toBeUndefined();
  });

  it('returns rejectUnauthorized:false when PRISMA_ALLOW_INSECURE_TLS=1', () => {
    expect(
      resolveSslConfig('postgresql://u:p@db.prod.example.com:5432/x', {
        PRISMA_ALLOW_INSECURE_TLS: '1',
      }),
    ).toEqual({ rejectUnauthorized: false });
  });

  it('returns checkServerIdentity-noop for remote URLs (verified TLS via Node defaults)', () => {
    const result = resolveSslConfig('postgresql://u:p@db.prod.example.com:5432/x', {});
    expect(result).toBeDefined();
    expect(typeof (result as { checkServerIdentity: unknown }).checkServerIdentity).toBe('function');
    expect((result as { checkServerIdentity: () => undefined }).checkServerIdentity()).toBeUndefined();
  });

  it('treats malformed URLs as remote (defensive)', () => {
    const result = resolveSslConfig('not-a-valid-url', {});
    expect(result).toBeDefined();
    expect(typeof (result as { checkServerIdentity: unknown }).checkServerIdentity).toBe('function');
  });
});

describe('parsePositiveIntEnv', () => {
  it('returns the fallback when unset', () => {
    expect(parsePositiveIntEnv({}, 'DB_POOL_MAX', 10)).toBe(10);
  });

  it('returns the fallback when set to an empty string', () => {
    expect(parsePositiveIntEnv({ DB_POOL_MAX: '' }, 'DB_POOL_MAX', 10)).toBe(10);
  });

  it('returns the parsed value when a valid positive integer', () => {
    expect(parsePositiveIntEnv({ DB_POOL_MAX: '25' }, 'DB_POOL_MAX', 10)).toBe(25);
  });

  it.each([
    ['non-numeric', 'not-a-number'],
    ['zero', '0'],
    ['negative', '-5'],
    ['a decimal', '2.5'],
  ])('ignores %s values and warns, falling back to the default', (_label, raw) => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parsePositiveIntEnv({ DB_POOL_MAX: raw }, 'DB_POOL_MAX', 10)).toBe(10);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain('DB_POOL_MAX');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('resolvePoolConfig', () => {
  it('uses pg.Pool-matching defaults when both vars are unset', () => {
    expect(resolvePoolConfig({})).toEqual({ max: 10, idleTimeoutMillis: 10000 });
  });

  it('honours both vars when valid', () => {
    expect(
      resolvePoolConfig({ DB_POOL_MAX: '3', DB_POOL_IDLE_MS: '5000' }),
    ).toEqual({ max: 3, idleTimeoutMillis: 5000 });
  });

  it('falls back to defaults for invalid values without throwing', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        resolvePoolConfig({ DB_POOL_MAX: 'nope', DB_POOL_IDLE_MS: '-1' }),
      ).toEqual({ max: 10, idleTimeoutMillis: 10000 });
    } finally {
      warnSpy.mockRestore();
    }
  });
});
