import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

const APP_AWS_REGION = process.env.APP_AWS_REGION;
const APP_AWS_ACCESS_KEY_ID = process.env.APP_AWS_ACCESS_KEY_ID;
const APP_AWS_SECRET_ACCESS_KEY = process.env.APP_AWS_SECRET_ACCESS_KEY;
const APP_AWS_ENDPOINT = process.env.APP_AWS_ENDPOINT;

// Operative: host of the configured S3-compatible endpoint (e.g. GCS), used to allow-list URLs
// produced with a non-AWS endpoint/forcePathStyle. Undefined (and inert) when unset.
const APP_AWS_ENDPOINT_HOST = (() => {
  if (!APP_AWS_ENDPOINT) return undefined;
  try {
    return new URL(APP_AWS_ENDPOINT).host.toLowerCase();
  } catch {
    return undefined;
  }
})();

export const BUCKET_NAME = process.env.APP_AWS_BUCKET_NAME;
export const APP_AWS_QUESTIONNAIRE_UPLOAD_BUCKET = process.env.APP_AWS_QUESTIONNAIRE_UPLOAD_BUCKET;
export const APP_AWS_KNOWLEDGE_BASE_BUCKET = process.env.APP_AWS_KNOWLEDGE_BASE_BUCKET;
export const APP_AWS_ORG_ASSETS_BUCKET = process.env.APP_AWS_ORG_ASSETS_BUCKET;

let s3ClientInstance: S3Client;

try {
  if (!APP_AWS_ACCESS_KEY_ID || !APP_AWS_SECRET_ACCESS_KEY || !BUCKET_NAME || !APP_AWS_REGION) {
    console.error('[S3] AWS S3 credentials or configuration missing. Check environment variables.');
    throw new Error('AWS S3 credentials or configuration missing. Check environment variables.');
  }

  s3ClientInstance = new S3Client({
    endpoint: APP_AWS_ENDPOINT || undefined,
    region: APP_AWS_REGION,
    credentials: {
      accessKeyId: APP_AWS_ACCESS_KEY_ID,
      secretAccessKey: APP_AWS_SECRET_ACCESS_KEY,
    },
    forcePathStyle: !!APP_AWS_ENDPOINT,
  });
} catch (error) {
  console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
  console.error('!!! FAILED TO INITIALIZE S3 CLIENT !!!');
  console.error('!!! This is likely due to missing or invalid environment variables. !!!');
  console.error('Error:', error);
  console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');

  // Create a dummy client that will fail gracefully at runtime instead of crashing during initialization
  s3ClientInstance = null as any;
  console.error(
    '[S3] Creating dummy S3 client - file uploads will fail until credentials are fixed',
  );
}

export const s3Client = s3ClientInstance;

/**
 * Validates if a hostname is a valid AWS S3 endpoint
 */
function isValidS3Host(host: string): boolean {
  const normalizedHost = host.toLowerCase();

  // Check against known AWS S3 patterns
  if (normalizedHost.endsWith('.amazonaws.com')) {
    return /^([\w.-]+\.)?(s3|s3-[\w-]+|s3-website[\w.-]+|s3-accesspoint|s3-control)(\.[\w-]+)?\.amazonaws\.com$/.test(
      normalizedHost,
    );
  }

  // Operative: also accept the configured custom S3-compatible endpoint (e.g. GCS via
  // storage.googleapis.com), in both path-style (<endpoint-host>) and virtual-hosted
  // (<bucket>.<endpoint-host>) form. Only active when APP_AWS_ENDPOINT is set, so
  // upstream/AWS-only behaviour is unchanged when it isn't.
  if (!APP_AWS_ENDPOINT_HOST) {
    return false;
  }
  return (
    normalizedHost === APP_AWS_ENDPOINT_HOST ||
    normalizedHost.endsWith(`.${APP_AWS_ENDPOINT_HOST}`)
  );
}

/**
 * Extracts S3 object key from either a full S3 URL or a plain key
 * @throws {Error} If the input is invalid or potentially malicious
 */
export function extractS3KeyFromUrl(url: string): string {
  if (!url || typeof url !== 'string') {
    throw new Error('Invalid input: URL must be a non-empty string');
  }

  // Try to parse as URL
  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(url);
  } catch {
    // Not a valid URL - will handle as S3 key below
  }

  if (parsedUrl) {
    // Validate it's an S3 URL
    if (!isValidS3Host(parsedUrl.host)) {
      throw new Error('Invalid URL: Not a valid S3 endpoint');
    }

    // Extract and validate the key
    let key = decodeURIComponent(parsedUrl.pathname.substring(1));

    // Operative: path-style URLs against the configured endpoint
    // (https://<endpoint-host>/<bucket>/<key>) put the bucket name as the first path segment;
    // strip it so only the object key remains. Virtual-hosted URLs
    // (https://<bucket>.<endpoint-host>/<key>) already have the bucket in the host, so the
    // full path is the key, same as AWS's virtual-hosted-style — don't strip there.
    // NOTE: this split happens after decodeURIComponent, so a key containing an encoded '%2F'
    // (a literal slash inside the key) will be split incorrectly. Pre-existing limitation,
    // not introduced by this change.
    const normalizedHost = parsedUrl.host.toLowerCase();
    if (APP_AWS_ENDPOINT_HOST && normalizedHost === APP_AWS_ENDPOINT_HOST) {
      const slashIndex = key.indexOf('/');
      key = slashIndex === -1 ? '' : key.substring(slashIndex + 1);
    }

    // Security: Check for path traversal
    if (key.includes('../') || key.includes('..\\')) {
      throw new Error('Invalid S3 key: Path traversal detected');
    }

    // Validate key is not empty
    if (!key) {
      throw new Error('Invalid S3 key: Key cannot be empty');
    }

    return key;
  }

  // Not a URL - treat as S3 key
  // Security: Ensure it's not a malformed URL attempting to bypass validation
  const lowerInput = url.toLowerCase();
  if (lowerInput.includes('://') || lowerInput.includes('amazonaws.com')) {
    throw new Error('Invalid input: Malformed URL detected');
  }

  // Security: Check for path traversal
  if (url.includes('../') || url.includes('..\\')) {
    throw new Error('Invalid S3 key: Path traversal detected');
  }

  // Remove leading slash if present
  const key = url.startsWith('/') ? url.substring(1) : url;

  // Validate key is not empty
  if (!key) {
    throw new Error('Invalid S3 key: Key cannot be empty');
  }

  return key;
}

export async function getFleetAgent({ os }: { os: 'macos' | 'windows' | 'linux' }) {
  const fleetBucketName = process.env.FLEET_AGENT_BUCKET_NAME;
  const fleetAgentFileName = 'Comp AI Agent-1.0.0-arm64.dmg';

  if (!fleetBucketName) {
    throw new Error('FLEET_AGENT_BUCKET_NAME is not defined.');
  }

  const getFleetAgentCommand = new GetObjectCommand({
    Bucket: fleetBucketName,
    Key: `${os}/${fleetAgentFileName}`,
  });

  const response = await s3Client.send(getFleetAgentCommand);
  return response.Body;
}
