/**
 * CrowdStrike Falcon integration manifest.
 *
 * Auth is `custom` rather than `oauth2` on purpose: Falcon uses the OAuth
 * client-credentials grant, a server-to-server exchange with no browser
 * redirect. The user supplies a Client ID and Secret; helpers/api-client.ts
 * trades them for a bearer token on each run.
 */

import type { IntegrationManifest } from '../../types';
import { sensorCoverageCheck } from './checks';

export const crowdstrikeManifest: IntegrationManifest = {
  id: 'crowdstrike',
  name: 'CrowdStrike Falcon',
  description:
    'Monitor endpoint protection coverage and sensor health across managed devices.',
  category: 'Security',
  logoUrl: 'https://img.logo.dev/crowdstrike.com?token=pk_AZatYxV5QDSfWpRDaBxzRQ',
  docsUrl: 'https://falcon.crowdstrike.com/documentation',

  // Per-connection: the real host is chosen from the selected cloud region in
  // helpers/api-client.ts and passed to each ctx.fetch as `baseUrl`.
  baseUrl: 'https://api.crowdstrike.com',
  defaultHeaders: {
    Accept: 'application/json',
  },

  auth: {
    type: 'custom',
    config: {
      description: 'CrowdStrike Falcon API client (OAuth2 client credentials)',
      credentialFields: [
        {
          id: 'client_id',
          label: 'Client ID',
          type: 'text' as const,
          required: true,
          helpText: 'From Falcon → Support and resources → API clients and keys',
        },
        {
          id: 'client_secret',
          label: 'Client Secret',
          type: 'password' as const,
          required: true,
          helpText: 'Shown only once when the API client is created',
        },
        {
          id: 'cloud',
          label: 'Falcon cloud',
          type: 'select' as const,
          required: true,
          helpText: 'Shown in the Falcon console URL. Most US tenants are US-1.',
          options: [
            { value: 'us-1', label: 'US-1 (api.crowdstrike.com)' },
            { value: 'us-2', label: 'US-2 (api.us-2.crowdstrike.com)' },
            { value: 'eu-1', label: 'EU-1 (api.eu-1.crowdstrike.com)' },
            { value: 'us-gov-1', label: 'US-GOV-1 (api.laggar.gcw.crowdstrike.com)' },
          ],
        },
      ],
      setupInstructions: `## Create a read-only Falcon API client

1. In the Falcon console, go to **Support and resources → API clients and keys**
2. Click **Create API client**
3. Name it \`CompAI Compliance (read-only)\`
4. Grant **read** scopes only:
   - **Hosts: Read** — required for sensor coverage
   - **Prevention policies: Read** — for the prevention policy check
   - **Spotlight vulnerabilities: Read** — for vulnerability reporting
   - **User management: Read** — for the console access review
5. Click **Create**, then copy the **Client ID** and **Client Secret**

The secret is shown once. Store it in a password manager before closing the dialog.

Do not grant any write scope. These checks only read.`,
    },
  },

  capabilities: ['checks'],
  checks: [sensorCoverageCheck],

  isActive: true,
};

export default crowdstrikeManifest;
export * from './types';
