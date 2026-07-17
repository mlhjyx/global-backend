import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, Site } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { mergeProfile, Profile } from './profile-merge';
import {
  assertReadableProfileState,
  assertValidProfileState,
  nextProfileVersionId,
  ProfilePrecondition,
  ProfileResult,
  ProfileVersionConflictException,
} from './profile-contract';
import { extractProfileAssetReferences } from './asset-reference';
import { AssetReferenceGateError, lockLiveAssetsForReference } from './asset-reference-gate';

/** 站点列表/详情/建站向导档案（07 §2）。租户隔离由 withWorkspace + RLS 兜底。 */
@Injectable()
export class SitesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: RequestContext): Promise<Site[]> {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) => tx.site.findMany({ orderBy: { createdAt: 'asc' } }));
  }

  async get(ctx: RequestContext, siteId: string): Promise<Site> {
    const site = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.site.findUnique({ where: { id: siteId } }),
    );
    if (!site) throw new NotFoundException('site not found');
    return site;
  }

  async getProfile(ctx: RequestContext, siteId: string): Promise<ProfileResult> {
    const site = await this.get(ctx, siteId);
    const profile = ((site.profile as Profile | null) ?? {}) as Profile;
    assertReadableProfileState(profile, site.profileVersionId);
    return {
      ...profile,
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
        throw new ProfileVersionConflictException(site.profileVersionId, siteId, precondition);
      }

      const merged = mergeProfile(site.profile as Record<string, unknown> | null, patch);
      assertValidProfileState(merged);
      await this.assertAssetReferences(tx, ctx.workspaceId, siteId, merged);

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
        throw new ProfileVersionConflictException(current.profileVersionId, siteId, precondition);
      }
      return { ...merged, versionId: nextVersionId };
    });
  }

  /** Asset UUIDs are not capabilities: all references must resolve through current workspace RLS and site. */
  private async assertAssetReferences(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    siteId: string,
    patch: Profile,
  ): Promise<void> {
    const references = extractProfileAssetReferences(patch);
    if (references.length === 0) return;
    let assets: Awaited<ReturnType<typeof lockLiveAssetsForReference>>;
    try {
      assets = await lockLiveAssetsForReference(tx, {
        workspaceId,
        siteId,
        assetIds: references.map((reference) => reference.assetId),
      });
    } catch (error) {
      if (!(error instanceof AssetReferenceGateError)) throw error;
      const missing = references.find((reference) => error.assetIds.includes(reference.assetId))!;
      throw this.invalidProfileAssetReference(missing);
    }
    const found = new Map(assets.map((asset) => [asset.id, asset.kind]));
    for (const reference of references) {
      if (
        !found.has(reference.assetId) ||
        (reference.expectedKind && found.get(reference.assetId) !== reference.expectedKind)
      ) {
        throw this.invalidProfileAssetReference(reference);
      }
    }
  }

  private invalidProfileAssetReference(reference: {
    assetId: string;
    expectedKind?: string;
    fieldPath: string;
  }): UnprocessableEntityException {
    return new UnprocessableEntityException({
      error: {
        code: 'PROFILE_VALIDATION_FAILED',
        message: 'profile asset reference is invalid',
        details: {
          field: 'assetId',
          path: reference.fieldPath,
          assetId: reference.assetId,
          expectedKind: reference.expectedKind ?? 'any',
        },
      },
    });
  }
}
