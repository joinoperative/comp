'use server';

import { authActionClient } from '@/actions/safe-action';
import { getApiBaseUrl } from '@/lib/api-server';
import { headers } from 'next/headers';
import { z } from 'zod';

const downloadHipaaCertificateSchema = z.object({
  memberId: z.string(),
  organizationId: z.string(),
});

export const downloadHipaaCertificate = authActionClient
  .inputSchema(downloadHipaaCertificateSchema)
  .metadata({
    name: 'downloadHipaaCertificate',
    track: {
      event: 'downloadHipaaCertificate',
      channel: 'server',
    },
  })
  .action(async ({ parsedInput, ctx }) => {
    const { memberId, organizationId } = parsedInput;
    const { session } = ctx;

    if (session.activeOrganizationId !== organizationId) {
      throw new Error(
        'Unauthorized: You do not have access to this organization',
      );
    }

    // Operative: shared with apps/app/src/lib/api-server.ts so this also honours BACKEND_API_URL
    const apiUrl = getApiBaseUrl();

    const headerStore = await headers();
    const cookieHeader = headerStore.get('cookie');

    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (cookieHeader) {
      requestHeaders['Cookie'] = cookieHeader;
    }

    const response = await fetch(
      `${apiUrl}/v1/training/generate-hipaa-certificate`,
      {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({ memberId, organizationId }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to generate HIPAA certificate: ${errorText}`);
    }

    const pdfBuffer = await response.arrayBuffer();
    return Buffer.from(pdfBuffer).toString('base64');
  });
