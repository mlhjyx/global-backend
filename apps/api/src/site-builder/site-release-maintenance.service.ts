import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

import type { StorageService } from './storage.service';
import {
  isSiteReleaseGcEligible,
  siteReleaseGcEnabled,
} from './site-release-gc';

const GC_LEASE_MS = 15 * 60_000;

export class SiteReleaseMaintenanceService {
  constructor(
    private readonly ownerDb: PrismaClient,
    private readonly storage: Pick<StorageService, 'deletePrefix'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async sweep(limit = 25): Promise<{ examined: number; deleted: number }> {
    if (!siteReleaseGcEnabled()) return { examined: 0, deleted: 0 };
    const candidates = await this.ownerDb.siteRelease.findMany({
      where: { status: { in: ['candidate', 'failed', 'ready', 'deleting'] } },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(100, limit)),
    });
    let deleted = 0;
    for (const candidate of candidates) {
      const token = randomUUID();
      const claimed = await this.ownerDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-release-pointer-${candidate.siteId}`}))`;
        let release = await tx.siteRelease.findUnique({
          where: { id: candidate.id },
        });
        if (!release) return null;
        const site = await tx.site.findUnique({
          where: { id: release.siteId },
          select: { activeVersionId: true },
        });
        const now = this.now();
        const resuming =
          release.status === 'deleting' &&
          (!release.gcLeaseUntil || release.gcLeaseUntil <= now);
        if (!resuming) {
          const newerReadyCount = await tx.siteRelease.count({
            where: {
              siteId: release.siteId,
              status: 'ready',
              releaseNumber: { gt: release.releaseNumber },
            },
          });
          if (
            (release.status === 'candidate' && release.leaseUntil > now) ||
            !isSiteReleaseGcEligible({
              status: release.status,
              createdAt: release.createdAt,
              readyAt: release.readyAt,
              active: site?.activeVersionId === release.siteVersionId,
              newerReadyCount,
              now,
            })
          ) {
            return null;
          }
          if (release.status === 'candidate') {
            await tx.siteRelease.update({
              where: { id: release.id },
              data: { status: 'failed', error: 'abandoned candidate retention expired' },
            });
            release = { ...release, status: 'failed' };
          }
        }
        const claim = await tx.siteRelease.updateMany({
          where: {
            id: release.id,
            status: release.status,
            ...(resuming
              ? { OR: [{ gcLeaseUntil: null }, { gcLeaseUntil: { lte: now } }] }
              : {}),
          },
          data: {
            status: 'deleting',
            gcToken: token,
            gcLeaseUntil: new Date(now.getTime() + GC_LEASE_MS),
          },
        });
        return claim.count === 1 ? release : null;
      });
      if (!claimed) continue;
      await this.storage.deletePrefix(`${claimed.artifactPrefix}/`);
      const settled = await this.ownerDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`site-release-pointer-${claimed.siteId}`}))`;
        return tx.siteRelease.updateMany({
          where: { id: claimed.id, status: 'deleting', gcToken: token },
          data: {
            status: 'deleted',
            deletedAt: this.now(),
            gcLeaseUntil: null,
          },
        });
      });
      if (settled.count !== 1) throw new Error('SITE_RELEASE_GC_SETTLE_FENCED');
      deleted += 1;
    }
    return { examined: candidates.length, deleted };
  }
}
