// Operative: s3.ts imports '../config/load-env' for its side effect, which — if a developer
// has a local .env file — calls dotenv.config({ override: true }) and would silently overwrite
// the very env vars each scenario below sets before loading the module. Mock it out entirely so
// these tests only ever see the env this file sets, never a developer's local .env.
jest.mock('../config/load-env', () => ({
  ensureEnvLoaded: jest.fn(),
}));

// Operative: capture S3Client's constructor args so we can assert on the actual client
// configuration (endpoint/forcePathStyle/region), not just extractS3KeyFromUrl()'s behaviour.
jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation((config: unknown) => ({ __mockConfig: config })),
  };
});

// isValidS3Host() and APP_AWS_ENDPOINT_HOST are module-private; APP_AWS_ENDPOINT_HOST is also
// computed once at import time, so each scenario below loads a fresh module instance (via
// jest.resetModules()) after setting process.env, and exercises the private host-validation
// logic indirectly through the exported extractS3KeyFromUrl().
describe('s3.ts extractS3KeyFromUrl', () => {
  const ORIGINAL_ENV = process.env;

  function loadModule(env: Record<string, string | undefined>) {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, ...env };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./s3') as typeof import('./s3');
  }

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('without APP_AWS_ENDPOINT (AWS-only, upstream behaviour)', () => {
    const { extractS3KeyFromUrl } = loadModule({ APP_AWS_ENDPOINT: undefined });

    it.each([
      [
        'virtual-hosted AWS URL',
        'https://my-bucket.s3.us-east-1.amazonaws.com/org/logo.png',
        'org/logo.png',
      ],
      [
        'virtual-hosted AWS URL with spaces (encoded)',
        'https://my-bucket.s3.amazonaws.com/org/file%20name.pdf',
        'org/file name.pdf',
      ],
      [
        'presigned AWS URL with a query string',
        'https://my-bucket.s3.amazonaws.com/org/doc.pdf?X-Amz-Signature=abc&X-Amz-Expires=900',
        'org/doc.pdf',
      ],
    ])('accepts %s', (_label, url, expectedKey) => {
      expect(extractS3KeyFromUrl(url)).toBe(expectedKey);
    });

    it.each([
      ['an unrelated host', 'https://evil.example.com/org/logo.png'],
      [
        // A literal "../" segment gets collapsed by the URL parser itself before this code
        // ever sees it; encoding just the slash (not the dots) survives parsing intact and
        // becomes a literal "../" after decodeURIComponent, which is what's actually rejected.
        'a path-traversal key (slash-encoded ".." segment)',
        'https://my-bucket.s3.amazonaws.com/org/..%2Fsecret',
      ],
      ['an empty key', 'https://my-bucket.s3.amazonaws.com/'],
    ])('rejects %s', (_label, url) => {
      expect(() => extractS3KeyFromUrl(url)).toThrow();
    });

    it('does not accept a non-AWS endpoint host when APP_AWS_ENDPOINT is unset', () => {
      expect(() =>
        extractS3KeyFromUrl('https://storage.googleapis.com/comp-files/org/logo.png'),
      ).toThrow();
    });
  });

  describe('with APP_AWS_ENDPOINT set (self-hosted / GCS)', () => {
    const { extractS3KeyFromUrl } = loadModule({
      APP_AWS_ENDPOINT: 'https://storage.googleapis.com',
    });

    it.each([
      [
        'path-style URL (bucket as first path segment)',
        'https://storage.googleapis.com/comp-files/org/logo.png',
        'org/logo.png',
      ],
      [
        'path-style URL with spaces (encoded)',
        'https://storage.googleapis.com/comp-files/org/file%20name.pdf',
        'org/file name.pdf',
      ],
      [
        'path-style presigned URL with a query string',
        'https://storage.googleapis.com/comp-files/org/doc.pdf?X-Goog-Signature=abc',
        'org/doc.pdf',
      ],
      [
        'virtual-hosted endpoint URL (bucket in the host, not stripped from the path)',
        'https://comp-files.storage.googleapis.com/org/logo.png',
        'org/logo.png',
      ],
    ])('accepts %s', (_label, url, expectedKey) => {
      expect(extractS3KeyFromUrl(url)).toBe(expectedKey);
    });

    it.each([
      ['an unrelated host', 'https://evil.example.com/comp-files/org/logo.png'],
      [
        'a path-traversal key (slash-encoded ".." segment)',
        'https://storage.googleapis.com/comp-files/org/..%2Fsecret',
      ],
      ['an empty key', 'https://storage.googleapis.com/comp-files/'],
    ])('rejects %s', (_label, url) => {
      expect(() => extractS3KeyFromUrl(url)).toThrow();
    });
  });
});

describe('s3.ts s3Client construction', () => {
  const ORIGINAL_ENV = process.env;

  const BASE_ENV = {
    APP_AWS_ACCESS_KEY_ID: 'test-access-key',
    APP_AWS_SECRET_ACCESS_KEY: 'test-secret-key',
    APP_AWS_BUCKET_NAME: 'test-bucket',
    APP_AWS_REGION: 'us-east-1',
  };

  function loadModule(env: Record<string, string | undefined>) {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, ...BASE_ENV, ...env };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./s3') as typeof import('./s3');
  }

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('constructs with endpoint/forcePathStyle when APP_AWS_ENDPOINT is set', () => {
    const { s3Client } = loadModule({ APP_AWS_ENDPOINT: 'https://storage.googleapis.com' });
    expect(s3Client).not.toBeNull();
    const config = (s3Client as unknown as { __mockConfig: Record<string, unknown> })
      .__mockConfig;
    expect(config.endpoint).toBe('https://storage.googleapis.com');
    expect(config.forcePathStyle).toBe(true);
    expect(config.region).toBe('us-east-1');
  });

  it('constructs without endpoint/forcePathStyle when APP_AWS_ENDPOINT is unset (AWS defaults)', () => {
    const { s3Client } = loadModule({ APP_AWS_ENDPOINT: undefined });
    expect(s3Client).not.toBeNull();
    const config = (s3Client as unknown as { __mockConfig: Record<string, unknown> })
      .__mockConfig;
    expect(config.endpoint).toBeUndefined();
    expect(config.forcePathStyle).toBe(false);
    expect(config.region).toBe('us-east-1');
  });

  it('falls back to a null client (not throwing) when required config is missing', () => {
    const { s3Client } = loadModule({ APP_AWS_ACCESS_KEY_ID: undefined });
    expect(s3Client).toBeNull();
  });
});
