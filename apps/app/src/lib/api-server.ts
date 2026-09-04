import { env } from '@/env.mjs';
import { headers } from 'next/headers';

export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  status: number;
}

interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

/**
 * Operative: base URL for server-side calls to the internal NestJS API. Prefers
 * BACKEND_API_URL (a private/internal URL, e.g. behind IAP) over the public
 * NEXT_PUBLIC_API_URL, and preserves API_BASE_URL — a second, unrelated fallback some
 * server-only callers (certificate/export routes) already used — as the last fallback
 * before localhost, so deployments that only set API_BASE_URL keep working. Shared by
 * every server-only caller under apps/app/src (route handlers, 'use server' actions,
 * files importing next/headers) — do not use this from client components; see
 * apps/app/src/lib/api-client.ts instead.
 */
export function getApiBaseUrl(): string {
  return (
    process.env.BACKEND_API_URL ||
    env.NEXT_PUBLIC_API_URL ||
    process.env.API_BASE_URL ||
    'http://localhost:3333'
  );
}

/**
 * Server-side API client for calling our internal NestJS API from server components.
 * Forwards cookies for authentication — API resolves the session (including
 * activeOrganizationId) via better-auth, so no X-Organization-Id header is needed.
 */
async function call<T = unknown>(
  endpoint: string,
  options: CallOptions = {},
): Promise<ApiResponse<T>> {
  const { method = 'GET', body } = options;
  const baseUrl = getApiBaseUrl();

  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Forward cookies for auth - better-auth handles session validation
  const headerStore = await headers();
  const cookieHeader = headerStore.get('cookie');
  if (cookieHeader) {
    requestHeaders['Cookie'] = cookieHeader;
  }

  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers: requestHeaders,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });

    let data = null;
    if (response.status !== 204) {
      const text = await response.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { message: text };
        }
      }
    }

    return {
      data: response.ok ? data : undefined,
      error: !response.ok ? data?.message || `HTTP ${response.status}` : undefined,
      status: response.status,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'Network error',
      status: 0,
    };
  }
}

export const serverApi = {
  get: <T = unknown>(endpoint: string) =>
    call<T>(endpoint, { method: 'GET' }),

  post: <T = unknown>(endpoint: string, body?: unknown) =>
    call<T>(endpoint, { method: 'POST', body }),

  put: <T = unknown>(endpoint: string, body?: unknown) =>
    call<T>(endpoint, { method: 'PUT', body }),

  patch: <T = unknown>(endpoint: string, body?: unknown) =>
    call<T>(endpoint, { method: 'PATCH', body }),

  delete: <T = unknown>(endpoint: string, body?: unknown) =>
    call<T>(endpoint, { method: 'DELETE', body }),
};
