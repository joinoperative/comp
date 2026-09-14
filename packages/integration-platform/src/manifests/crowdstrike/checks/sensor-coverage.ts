/**
 * Check: every managed endpoint is running a healthy Falcon sensor.
 *
 * This is the evidence behind the "endpoint protection is deployed" claim in
 * the Secure Devices task. A device that Falcon knows about but that is not
 * reporting normally is not protected, so it fails here.
 */

import { TASK_TEMPLATES } from '../../../task-mappings';
import type { CheckContext, IntegrationCheck } from '../../../types';
import { falconAuthHeaders, falconBaseUrl, getFalconToken } from '../helpers/api-client';
import type { FalconDevice, FalconEnvelope } from '../types';

/** Falcon caps `ids` lookups; 100 per request is well inside the limit. */
const DEVICE_DETAIL_BATCH_SIZE = 100;

/** Page size for the device ID query. */
const DEVICE_QUERY_LIMIT = 500;

export const sensorCoverageCheck: IntegrationCheck = {
  id: 'sensor-coverage',
  name: 'Falcon sensor deployed and healthy',
  description:
    'Verify every endpoint known to CrowdStrike Falcon is running the sensor and reporting normally.',
  taskMapping: TASK_TEMPLATES.secureDevices,
  defaultSeverity: 'high',

  run: async (ctx: CheckContext) => {
    ctx.log('Starting CrowdStrike sensor coverage check');

    const token = await getFalconToken(ctx);
    const baseUrl = falconBaseUrl(ctx);
    const headers = falconAuthHeaders(token);

    // Falcon splits list and detail: the query endpoint returns IDs, then the
    // entities endpoint returns the records for those IDs.
    const deviceIds: string[] = [];
    let offset = 0;

    for (;;) {
      const page = await ctx.fetch<FalconEnvelope<string[]>>('/devices/queries/devices/v1', {
        baseUrl,
        headers,
        params: { limit: String(DEVICE_QUERY_LIMIT), offset: String(offset) },
      });

      const ids = page.resources ?? [];
      deviceIds.push(...ids);

      const total = page.meta?.pagination?.total ?? deviceIds.length;
      offset += ids.length;

      if (ids.length === 0 || deviceIds.length >= total) {
        break;
      }
    }

    ctx.log(`Found ${deviceIds.length} devices in Falcon`);

    if (deviceIds.length === 0) {
      // An empty tenant is not a pass. Reporting it as a finding surfaces the
      // far more likely explanation: the API client cannot see the hosts.
      ctx.fail({
        title: 'No devices found in CrowdStrike Falcon',
        description:
          'Falcon returned no managed devices. Either no sensors are deployed, or the API client lacks the Hosts read scope.',
        resourceType: 'falcon-tenant',
        resourceId: 'tenant',
        severity: 'high',
        remediation:
          '1. Confirm the Falcon API client has the "Hosts: Read" scope\n' +
          '2. In the Falcon console, check Host Management for enrolled devices\n' +
          '3. Deploy the sensor to any company device that is missing it',
        evidence: { deviceCount: 0 },
      });
      return;
    }

    for (let i = 0; i < deviceIds.length; i += DEVICE_DETAIL_BATCH_SIZE) {
      const batch = deviceIds.slice(i, i + DEVICE_DETAIL_BATCH_SIZE);

      const details = await ctx.fetch<FalconEnvelope<FalconDevice[]>>(
        '/devices/entities/devices/v2',
        {
          baseUrl,
          headers,
          params: { ids: batch.join(',') },
        },
      );

      for (const device of details.resources ?? []) {
        const label = device.hostname || device.device_id;
        const inReducedMode = Boolean(device.reduced_functionality_mode);
        const isHealthy = device.status === 'normal' && !inReducedMode;

        const evidence = {
          hostname: device.hostname,
          platform: device.platform_name,
          osVersion: device.os_version,
          agentVersion: device.agent_version,
          status: device.status,
          reducedFunctionalityMode: device.reduced_functionality_mode ?? null,
          lastSeen: device.last_seen,
        };

        if (isHealthy) {
          ctx.pass({
            title: `${label} is protected`,
            description: `Falcon sensor ${device.agent_version ?? '(unknown version)'} is installed and reporting normally.`,
            resourceType: 'device',
            resourceId: device.device_id,
            evidence,
          });
        } else {
          ctx.fail({
            title: `${label} is not fully protected`,
            description: inReducedMode
              ? 'The Falcon sensor is running in reduced functionality mode, so prevention is degraded.'
              : `The Falcon sensor is not reporting normally (status: ${device.status ?? 'unknown'}).`,
            resourceType: 'device',
            resourceId: device.device_id,
            severity: 'high',
            remediation:
              '1. Open the device in Falcon → Host Management\n' +
              '2. Confirm the sensor is installed and the host is online\n' +
              '3. Upgrade the sensor if it is running an unsupported version\n' +
              '4. If the host is decommissioned, remove it from Falcon so it stops counting against coverage',
            evidence,
          });
        }
      }
    }

    ctx.log('CrowdStrike sensor coverage check complete');
  },
};
