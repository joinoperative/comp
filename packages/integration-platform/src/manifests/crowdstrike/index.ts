/**
 * CrowdStrike Falcon integration manifest.
 *
 * Auth is `custom` rather than `oauth2` on purpose: Falcon uses the OAuth
 * client-credentials grant, a server-to-server exchange with no browser
 * redirect. The user supplies a Client ID and Secret; helpers/api-client.ts
 * trades them for a bearer token.
 *
 * NOTE — the registry is code-wins: `registerDynamic` returns early and
 * `refreshDynamic` skips any id owned by a code manifest (registry/index.ts).
 * So if Comp AI's hosted `crowdstrike` definition is ever imported through the
 * dynamic-integrations API, this manifest shadows it permanently — its five
 * check slugs would be replaced by the single check here, and its stored
 * credentials (which carry an "API Base URL" rather than a `cloud` field) would
 * not satisfy `readCredentials`. Deactivate the dynamic row, or teach
 * `readCredentials` to derive the cloud from a stored base URL, before allowing
 * both to exist.
 */

import type { IntegrationManifest } from '../../types';
import { sensorHealthCheck } from './checks';

export const crowdstrikeManifest: IntegrationManifest = {
  id: 'crowdstrike',
  name: 'CrowdStrike Falcon',
  description:
    'Monitor sensor health across the endpoints enrolled in CrowdStrike Falcon.',
  category: 'Security',
  logoUrl: 'https://img.logo.dev/crowdstrike.com?token=pk_AZatYxV5QDSfWpRDaBxzRQ',
  docsUrl: 'https://developer.crowdstrike.com/',

  // Empty on purpose, as in the AWS manifest. Falcon is region-partitioned, so
  // there is no correct default host: a check that forgets to pass `baseUrl`
  // must fail loudly rather than quietly querying US-1 for a US-2 tenant.
  // The real host comes from the selected cloud via falconBaseUrl(ctx).
  baseUrl: '',
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
          helpText:
            'Must match the region shown in your Falcon console URL — a key issued in one region is rejected by every other region.',
          options: [
            { value: 'us-1', label: 'US-1 (api.crowdstrike.com)' },
            { value: 'us-2', label: 'US-2 (api.us-2.crowdstrike.com)' },
            { value: 'us-3', label: 'US-3 (api.us-3.crowdstrike.com)' },
            { value: 'eu-1', label: 'EU-1 (api.eu-1.crowdstrike.com)' },
            { value: 'us-gov-1', label: 'US-GOV-1 (api.laggar.gcw.crowdstrike.com)' },
            { value: 'us-gov-2', label: 'US-GOV-2 (api.us-gov-2.crowdstrike.mil)' },
          ],
        },
      ],
      setupInstructions: `## Create a read-only Falcon API client

1. In the Falcon console, go to **Support and resources → API clients and keys**
2. Click **Create API client**
3. Name it \`CompAI Compliance (read-only)\`
4. Grant one scope: **Hosts: Read**
5. Click **Create**, then copy the **Client ID** and **Client Secret**
6. Note the region in your Falcon console URL and select the matching Falcon cloud below

The secret is shown once. Store it in a password manager before closing the dialog.

Leave every **Write** box unchecked — this integration only reads. Further scopes
will be requested here if and when checks that need them are added.`,
    },
  },

  capabilities: ['checks'],
  checks: [sensorHealthCheck],

  isActive: true,
};

export default crowdstrikeManifest;
export * from './types';
