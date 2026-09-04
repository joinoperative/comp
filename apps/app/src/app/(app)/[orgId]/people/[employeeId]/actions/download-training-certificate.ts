'use server';

import { authActionClient } from '@/actions/safe-action';
import { getApiBaseUrl } from '@/lib/api-server';
import { headers } from 'next/headers';
import { z } from 'zod';

const downloadCertificateSchema = z.object({
  memberId: z.string(),
  organizationId: z.string(),
});

/**
 * Downloads a training certificate PDF for a member by calling the API
 */
export const downloadTrainingCertificate = authActionClient
  .inputSchema(downloadCertificateSchema)
  .metadata({
    name: 'downloadTrainingCertificate',
    track: {
      event: 'downloadTrainingCertificate',
      channel: 'server',
    },
  })
  .action(async ({ parsedInput, ctx }) => {
    const { memberId, organizationId } = parsedInput;
    const { session } = ctx;

    // Verify the caller has access to this organization
    if (session.activeOrganizationId !== organizationId) {
      throw new Error(
        'Unauthorized: You do not have access to this organization',
      );
    }

    // Operative: shared with apps/app/src/lib/api-server.ts so this also honours BACKEND_API_URL
    const apiUrl = getApiBaseUrl();

    // Forward session cookies for authentication
    const headerStore = await headers();
    const cookieHeader = headerStore.get('cookie');

    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (cookieHeader) {
      requestHeaders['Cookie'] = cookieHeader;
    }

    const response = await fetch(`${apiUrl}/v1/training/generate-certificate`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        memberId,
        organizationId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to generate certificate: ${errorText}`);
    }

    // Get the PDF as a buffer and convert to base64
    const pdfBuffer = await response.arrayBuffer();
    const pdfBase64 = Buffer.from(pdfBuffer).toString('base64');

    return pdfBase64;
  });
