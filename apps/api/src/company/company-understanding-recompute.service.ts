import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestContext } from '../auth/request-context';
import {
  buildProfileClaimDraftSpecs,
  synthesizeProfileClaimDrafts,
} from '../claim/profile-claim-drafts';
import { PrismaService } from '../prisma/prisma.service';
import { SellerDocumentClaimsService } from '../seller-knowledge/seller-document-claims.service';
import type {
  RecomputeUnderstandingDto,
  RecomputeUnderstandingResponseDto,
} from './dto/recompute-understanding.dto';
import { readSelectionMarker } from './offering-selection';

/**
 * 零成本企业理解重算：把档案字段（industry / targetMarkets / active offerings）与
 * 尚未抽取（或 force=true）的 ready 卖家资料确定性转为 NEEDS_REVIEW Claim 草稿，
 * 并标记 seller_document.facts_extracted_at。不触发网页抓取、不调模型、不消费 Grant，
 * 且绝不将已激活（ACTIVE）档案降级。
 */
@Injectable()
export class CompanyUnderstandingRecomputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documentClaims: SellerDocumentClaimsService,
  ) {}

  async recompute(
    ctx: RequestContext,
    companyId: string,
    dto: RecomputeUnderstandingDto = {},
  ): Promise<RecomputeUnderstandingResponseDto> {
    if (dto.documentIds === null || dto.force === null) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'documentIds 与 force 不能为 null',
        },
      });
    }

    const prep = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({
        where: { id: companyId },
        select: {
          id: true,
          status: true,
          deletedAt: true,
          industry: true,
          targetMarkets: true,
        },
      });
      if (!company || company.deletedAt) {
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'company not found' },
        });
      }
      if (company.status === 'ENRICHING') {
        throw new ConflictException({
          error: {
            code: 'UNDERSTANDING_IN_PROGRESS',
            message: '企业理解正在进行中，请稍后重试',
          },
        });
      }

      await tx.$queryRaw(Prisma.sql`
        SELECT "id" FROM "company_profile"
        WHERE "id" = ${companyId}::uuid AND "workspace_id" = ${ctx.workspaceId}::uuid
        FOR UPDATE
      `);

      const [offerings, docs] = await Promise.all([
        tx.offering.findMany({
          where: { companyId },
          select: { name: true, attributes: true },
        }),
        tx.sellerDocument.findMany({
          where: {
            companyId,
            deletedAt: null,
            status: 'ready',
            ...(dto.documentIds !== undefined
              ? { id: { in: dto.documentIds } }
              : {}),
            ...(dto.force ? {} : { factsExtractedAt: null }),
          },
          select: { id: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      ]);

      const activeOfferings = offerings
        .filter((o) => readSelectionMarker(o.attributes)?.selectedByUser !== false)
        .map((o) => o.name);
      const draftSpecs = buildProfileClaimDraftSpecs({
        industry: company.industry,
        targetMarkets: company.targetMarkets,
        offeringNames: activeOfferings,
      });
      const profileResult =
        draftSpecs.length > 0
          ? await synthesizeProfileClaimDrafts(tx, {
              workspaceId: ctx.workspaceId,
              companyId,
              specs: draftSpecs,
            })
          : { created: 0, skipped: 0, createdClaimIds: [] };

      return {
        status: company.status,
        docIds: docs.map((d) => d.id),
        profileDraftsCreated: profileResult.created,
      };
    });

    let draftsCreated = 0;
    for (const docId of prep.docIds) {
      const res = await this.documentClaims.createAssistedDrafts(
        ctx,
        companyId,
        docId,
      );
      draftsCreated += res.drafts.filter((d) => !d.replayed).length;
      await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
        tx.sellerDocument.updateMany({
          where: {
            id: docId,
            companyId,
            status: 'ready',
            deletedAt: null,
          },
          data: { factsExtractedAt: new Date() },
        }),
      );
    }

    return {
      companyId,
      status: prep.status,
      documentsScanned: prep.docIds.length,
      draftsCreated,
      profileDraftsCreated: prep.profileDraftsCreated,
    };
  }
}
