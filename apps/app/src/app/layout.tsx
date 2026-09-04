import '@trycompai/design-system/globals.css';

import { env } from '@/env.mjs';
import { auth } from '@/utils/auth';
import { Analytics as DubAnalytics } from '@dub/analytics/react';
import { cn } from '@trycompai/ui/cn';
import { Analytics as VercelAnalytics } from '@vercel/analytics/next';
import { GeistMono } from 'geist/font/mono';
import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { headers } from 'next/headers';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { Toaster } from 'sonner';
import { Providers } from './providers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  // Operative: self-hosted deployments shouldn't advertise/canonicalize to app.trycomp.ai.
  // Reads process.env directly (not env.mjs) to match the existing NEXT_PUBLIC_APP_URL
  // convention elsewhere in the app (e.g. lib/unsubscribe.ts, trigger/tasks/task/*).
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'https://app.trycomp.ai'),
  title: 'Comp AI | Automate SOC 2, ISO 27001 and GDPR compliance with AI.',
  description: 'Automate SOC 2, ISO 27001 and GDPR compliance with AI.',
  twitter: {
    title: 'Comp AI | Automate SOC 2, ISO 27001 and GDPR compliance with AI.',
    description: 'Automate SOC 2, ISO 27001 and GDPR compliance with AI.',
    images: [
      {
        url: 'https://cdn.trycomp.ai/opengraph-image.jpg',
        width: 800,
        height: 600,
      },
      {
        url: 'https://cdn.trycomp.ai/opengraph-image.jpg',
        width: 1800,
        height: 1600,
      },
    ],
  },
  openGraph: {
    title: 'Comp AI | Automate SOC 2, ISO 27001 and GDPR compliance with AI.',
    description: 'Automate SOC 2, ISO 27001 and GDPR compliance with AI.',
    // Operative: consistent with metadataBase above
    url: process.env.NEXT_PUBLIC_APP_URL || 'https://app.trycomp.ai',
    siteName: 'Comp AI',
    images: [
      {
        url: 'https://cdn.trycomp.ai/opengraph-image.jpg',
        width: 800,
        height: 600,
      },
      {
        url: 'https://cdn.trycomp.ai/opengraph-image.jpg',
        width: 1800,
        height: 1600,
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: '(prefers-color-scheme: light)' },
    { media: '(prefers-color-scheme: dark)' },
  ],
};

const font = localFont({
  src: '/../../public/fonts/GeneralSans-Variable.ttf',
  display: 'swap',
  variable: '--font-general-sans',
});

export default async function Layout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  const dubIsEnabled = env.DUB_API_KEY !== undefined;
  const dubReferUrl = env.DUB_REFER_URL;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {dubIsEnabled && dubReferUrl && (
          <DubAnalytics
            domainsConfig={{
              refer: dubReferUrl,
            }}
          />
        )}
      </head>
      <body className={cn(`${GeistMono.variable} ${font.variable}`, 'antialiased')}>
        <NuqsAdapter>
          <Providers session={session}>{children}</Providers>
        </NuqsAdapter>
        <Toaster richColors />
        <VercelAnalytics />
      </body>
    </html>
  );
}
