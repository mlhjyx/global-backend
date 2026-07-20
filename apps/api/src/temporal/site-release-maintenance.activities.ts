import type { PrismaClient } from '@prisma/client';
import type { StorageService } from '../site-builder/storage.service';
import { SiteReleaseMaintenanceService } from '../site-builder/site-release-maintenance.service';

export function createSiteReleaseMaintenanceActivities(input: {
  ownerDb: PrismaClient;
  storage: Pick<StorageService, 'deletePrefix'>;
}) {
  const maintenance = new SiteReleaseMaintenanceService(
    input.ownerDb,
    input.storage,
  );
  return {
    sweepSiteReleases: ({ limit = 25 }: { limit?: number } = {}) =>
      maintenance.sweep(limit),
  };
}
