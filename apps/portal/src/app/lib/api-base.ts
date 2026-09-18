/**
 * Operative: base URL for server-side calls from the portal to the API.
 *
 * Prefer BACKEND_API_URL (the API's internal address, reached over the VPC)
 * over NEXT_PUBLIC_API_URL (the public hostname, which sits behind Cloudflare
 * Access and would answer a server-side fetch with a login page). Same order
 * as ./auth.ts and api/device-agent/proxy.ts.
 */
export function getServerApiBaseUrl(): string {
  return (
    process.env.BACKEND_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333'
  );
}
