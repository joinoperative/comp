// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import { initBotId } from 'botid/client/core';
import * as Sentry from '@sentry/nextjs';

initBotId({
  protect: [{ path: '/api/chat', method: 'POST' }],
});

// Operative: an omitted Docker build ARG materialises NEXT_PUBLIC_SENTRY_DSN as '' (empty
// string), not undefined. An omitted build arg must behave exactly like upstream (i.e. NOT
// disable Sentry) — so empty and unset are treated identically here (`||`, not `??`) and both
// fall back to upstream's DSN. To actually disable Sentry for a deployment that doesn't want
// it, set the explicit NEXT_PUBLIC_SENTRY_DISABLED="true" build arg/env var instead of relying
// on an empty DSN to do it implicitly.
const sentryDisabled = process.env.NEXT_PUBLIC_SENTRY_DISABLED === 'true';

Sentry.init({
  dsn:
    process.env.NEXT_PUBLIC_SENTRY_DSN ||
    'https://331f1c3d4b08e9352dd1a2621e1ae845@o4509214247813120.ingest.us.sentry.io/4511304630927360',

  // Only report from production. NEXT_PUBLIC_VERCEL_ENV is inlined at build time
  // per Vercel deployment; preview/dev builds (or a missing var) keep Sentry
  // disabled — a no-op, never an error — to avoid noise and quota burn.
  enabled: !sentryDisabled && process.env.NEXT_PUBLIC_VERCEL_ENV === 'production',

  integrations: [
    // Add `data-sentry-mask` (or `.sentry-mask`) to any element rendering
    // customer-confidential data; `data-sentry-block` to drop whole sections.
    Sentry.replayIntegration({
      maskAllText: false,
      blockAllMedia: false,
      mask: ['.sentry-mask', '[data-sentry-mask]'],
      block: ['[data-sentry-block]'],
    }),
  ],

  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,

  enableLogs: true,

  // 10% of all sessions; 100% of sessions where an error occurs.
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
