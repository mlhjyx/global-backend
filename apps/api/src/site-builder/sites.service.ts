import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, Site } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { mergeProfile, Profile } from './profile-merge';
import {
  assertValidProfileState,
  nextProfileVersionId,
  ProfilePrecondition,
  ProfileResult,
  ProfileVersionConflictException,
} from './profile-contract';

/** 站点列表/详情/建站向导档案（07 §2）。租户隔离由 withWorkspace + RLS 兜底。 */
@Injectable()
export class SitesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: RequestContext): Promise<Site[]> {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.site.findMany({ orderBy: { createdAt: 'asc' } }),
    );
  }

  async get(ctx: RequestContext, siteId: string): Promise<Site> {
    const site = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.site.findUnique({ where: { id: siteId } }),
    );
    if (!site) throw new NotFoundException('site not found');
    return site;
  }

  async getProfile(
    ctx: RequestContext,
    siteId: string,
  ): Promise<ProfileResult> {
    const site = await this.get(ctx, siteId);
    return {
      ...(((site.profile as Profile | null) ?? {}) as Profile),
      versionId: site.profileVersionId,
    };
  }

  /** 向导分步保存：严格 DTO 后组级替换，以独立 Profile token 做 DB 原子 CAS。 */
  async patchProfile(
    ctx: RequestContext,
    siteId: string,
    patch: Profile,
    precondition: ProfilePrecondition,
  ): Promise<ProfileResult> {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const site = await tx.site.findUnique({
        where: { id: siteId },
        select: { id: true, profile: true, profileVersionId: true },
      });
      if (!site) throw new NotFoundException('site not found');
      if (site.profileVersionId !== precondition.expectedVersionId) {
        throw new ProfileVersionConflictException(
          site.profileVersionId,
          siteId,
          precondition,
        );
      }

      const merged = mergeProfile(
        site.profile as Record<string, unknown> | null,
        patch,
      );
      assertValidProfileState(merged);
      await this.assertAssetReferences(tx, siteId, merged);

      const nextVersionId = nextProfileVersionId();
      const changed = await tx.site.updateMany({
        where: { id: siteId, profileVersionId: precondition.expectedVersionId },
        data: {
          profile: merged as Prisma.InputJsonValue,
          profileVersionId: nextVersionId,
          updatedAt: new Date(),
        },
      });
      if (changed.count !== 1) {
        const current = await tx.site.findUnique({
          where: { id: siteId },
          select: { profileVersionId: true },
        });
        if (!current) throw new NotFoundException('site not found');
        throw new ProfileVersionConflictException(
          current.profileVersionId,
          siteId,
          precondition,
        );
      }
      return { ...merged, versionId: nextVersionId };
    });
  }

  /** Asset UUIDs are not capabilities: all references must resolve through current workspace RLS and site. */
  private async assertAssetReferences(
    tx: Prisma.TransactionClient,
    siteId: string,
    patch: Profile,
  ): Promise<void> {
    const references: Array<{ id: string; kind?: string; path: string }> = [];
    const brand = patch.brand as { logoAssetId?: string } | null | undefined;
    if (brand?.logoAssetId) {
      references.push({
        id: brand.logoAssetId,
        kind: 'logo',
        path: '/brand/logoAssetId',
      });
    }

    const trust = patch.trustAssets as
      | {
          certifications?: Array<{ certificateAssetIds?: string[] }>;
          customerCases?: Array<{ assetIds?: string[] }>;
        }
      | null
      | undefined;
    for (const [certificationIndex, certification] of (
      trust?.certifications ?? []
    ).entries()) {
      for (const [assetIndex, id] of (
        certification.certificateAssetIds ?? []
      ).entries()) {
        references.push({
          id,
          kind: 'cert',
          path: `/trustAssets/certifications/${certificationIndex}/certificateAssetIds/${assetIndex}`,
        });
      }
    }
    for (const [caseIndex, customerCase] of (
      trust?.customerCases ?? []
    ).entries()) {
      for (const [assetIndex, id] of (customerCase.assetIds ?? []).entries()) {
        references.push({
          id,
          path: `/trustAssets/customerCases/${caseIndex}/assetIds/${assetIndex}`,
        });
      }
    }
    if (references.length === 0) return;

    const assets = await tx.asset.findMany({
      where: {
        id: { in: [...new Set(references.map((reference) => reference.id))] },
        siteId,
        deletedAt: null,
      },
      select: { id: true, kind: true },
    });
    const found = new Map(assets.map((asset) => [asset.id, asset.kind]));
    for (const reference of references) {
      if (
        !found.has(reference.id) ||
        (reference.kind && found.get(reference.id) !== reference.kind)
      ) {
        throw new UnprocessableEntityException({
          error: {
            code: 'PROFILE_VALIDATION_FAILED',
            message: 'profile asset reference is invalid',
            details: {
              field: 'assetId',
              path: reference.path,
              assetId: reference.id,
              expectedKind: reference.kind ?? 'any',
            },
          },
        });
      }
    }
  }
}
