import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AssetReferenceScanError,
  AssetReferenceUsage,
  profileUsagesForAsset,
  scanSiteSpecAssetReferences,
} from './asset-reference';
import { assertValidProfileState } from './profile-contract';
import type { Profile } from './profile-merge';

type ScannerTx = Pick<Prisma.TransactionClient, 'site' | 'siteVersion'>;

/** Current MF0-B implementation; MF-1 may replace its internals with AssetUsage. */
@Injectable()
export class SiteSpecAssetReferenceScanner {
  async scan(tx: ScannerTx, input: { siteId: string; assetId: string }): Promise<AssetReferenceUsage[]> {
    const site = await tx.site.findUnique({
      where: { id: input.siteId },
      select: { profile: true, activeVersionId: true },
    });
    if (!site) return [];

    if (site.profile !== null) {
      try {
        assertValidProfileState(site.profile as Profile);
      } catch {
        throw new AssetReferenceScanError('stored Profile reference surface is malformed');
      }
    }
    const usages = profileUsagesForAsset(site.profile, input.assetId);
    if (site.activeVersionId) {
      const active = await tx.siteVersion.findFirst({
        where: { id: site.activeVersionId, siteId: input.siteId },
        select: { id: true, spec: true, specVersion: true },
      });
      if (!active) {
        throw new AssetReferenceScanError('active SiteVersion pointer is missing or outside the current site');
      }
      if (active.specVersion !== '1.0.0') {
        throw new AssetReferenceScanError('active SiteVersion specVersion is unsupported');
      }
      usages.push(...scanSiteSpecAssetReferences(active.spec, input.assetId, active.id));
    }
    return usages.sort((left, right) =>
      [left.source, left.siteVersionId ?? '', left.page, left.component, left.fieldPath]
        .join('\0')
        .localeCompare(
          [right.source, right.siteVersionId ?? '', right.page, right.component, right.fieldPath].join('\0'),
        ),
    );
  }
}
