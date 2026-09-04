import { db } from '@db/server';
import { logger, task } from '@trigger.dev/sdk';
import { createFleetLabelForOrg } from './create-fleet-label-for-org';

export const createFleetLabelForAllOrgs = task({
  id: 'create-fleet-label-for-all-orgs',
  run: async () => {
    if (!process.env.FLEET_URL || !process.env.FLEET_TOKEN) {
      // Operative: no Fleet (device management) server in this deployment.
      logger.info('Fleet is not configured (FLEET_URL/FLEET_TOKEN unset) — skipping fleet label creation');
      return;
    }
    const organizations = await db.organization.findMany({
      where: {
        isFleetSetupCompleted: false,
      },
    });

    logger.info(`Found ${organizations.length} organizations to create fleet label for`);

    const batchItems = organizations.map((organization) => ({
      payload: {
        organizationId: organization.id,
      },
    }));

    logger.info(`Triggering batch job for ${batchItems.length} organizations`);
    await createFleetLabelForOrg.batchTrigger(batchItems);
  },
});
