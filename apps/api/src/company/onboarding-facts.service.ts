import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import {
  buildProfileClaimDraftSpecs,
  synthesizeProfileClaimDrafts,
} from '../claim/profile-claim-drafts';
import { OnboardingFactsDto } from './dto/onboarding-facts.dto';
import { resolveIndustrySelection } from './industry-selection';
import { withSelectionMarker } from './offering-selection';

type CompanyRow = Prisma.CompanyProfileGetPayload<Record<string, never>>;

/**
 * 注册引导完成（注册即建档第 1 步，2026-11-10）：把理解预览里勾选的事实写回
 * **同一份档案**（预览启动时就已创建的 DRAFT/REVIEW 草稿），并把卖家事实转成
 * 可审批的 Claim 草稿。零模型调用、不出网、不消费 Grant。
 *
 * 状态门：DRAFT（无官网/理解失败后手填）与 REVIEW（预览就绪）可写；ENRICHING
 * 拒绝——理解回填（extract_profile 写 industry）还在路上，先写会被稍后覆盖。
 */
@Injectable()
export class OnboardingFactsService {
  constructor(private readonly prisma: PrismaService) {}

  async apply(
    ctx: RequestContext,
    companyId: string,
    dto: OnboardingFactsDto,
  ): Promise<CompanyRow> {
    // class-validator 的 @IsOptional 放行 JSON null；null 落到 map/findUnique 会变成 500。
    for (const [key, value] of Object.entries(dto)) {
      if (value === null) {
        throw new BadRequestException({
          error: { code: 'VALIDATION_ERROR', message: `${key} 不能为 null` },
        });
      }
    }
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id: companyId } });
      if (!company || company.deletedAt) {
        throw new NotFoundException({
          error: { code: 'NOT_FOUND', message: 'company not found' },
        });
      }
      if (company.status !== 'DRAFT' && company.status !== 'REVIEW') {
        throw new ConflictException({
          error: {
            code: 'ONBOARDING_FACTS_NOT_ALLOWED',
            message: `company is ${company.status}; onboarding facts 只写 DRAFT/REVIEW`,
          },
        });
      }
      // DRAFT + 官网 + 无失败标记 = 理解已排队/刚被接受还没置 ENRICHING：
      // extract_profile 稍后可能改写 industry，与客户选的 industryCode 不同源，拒绝。
      if (company.status === 'DRAFT' && company.website && company.understandingFailedAt === null) {
        throw new ConflictException({
          error: {
            code: 'ONBOARDING_FACTS_NOT_ALLOWED',
            message: 'understanding is queued or running; confirm after the preview is ready',
          },
        });
      }

      const industry = await resolveIndustrySelection(tx, {
        industry: dto.industry,
        industryCode: dto.industryCode,
      });
      const data: Prisma.CompanyProfileUpdateInput = { version: { increment: 1 } };
      if (dto.name !== undefined) data.name = dto.name.trim();
      if (industry.industry !== undefined) data.industry = industry.industry;
      if (dto.industryCode !== undefined) {
        data.industryCode = industry.industryCode;
      } else if (dto.industry !== undefined) {
        // 客户回填自由文本时清掉旧受控码，避免两列不同源。
        data.industryCode = null;
      }
      if (dto.targetMarkets !== undefined) data.targetMarkets = dto.targetMarkets;
      if (dto.businessEmail !== undefined) data.businessEmail = dto.businessEmail.trim();

      // withWorkspace 是交互式事务，行锁由随后的 update 持有；理解回填路径在本状态门
      // 之外（ENRICHING 才会写 industry），REVIEW/DRAFT 没有并发写者。
      const updated = await tx.companyProfile.update({ where: { id: companyId }, data });

      let offeringNames: string[];
      if (dto.products !== undefined) {
        offeringNames = [
          ...new Set(dto.products.map((name) => name.trim()).filter(Boolean)),
        ];
        // 空白项≠「取消全部」：显式 [] 才是取消全部，空白名称是客户端输入错误。
        if (dto.products.length > 0 && offeringNames.length === 0) {
          throw new BadRequestException({
            error: { code: 'VALIDATION_ERROR', message: 'products 不能只有空白名称' },
          });
        }
        // 选择标记写在 Offering.attributes（现有 JSON 列，无迁移）：
        // - 勾选=selectedByUser:true；未勾选=selectedByUser:false；
        // - 显式空数组=取消全部；与「本次未提交 products（缺省）」区分；
        // - 不改 source、不删除抽取行：理解抽取仍可审计，但不再进入 ICP。
        const at = new Date().toISOString();
        const existing = await tx.offering.findMany({
          where: { companyId },
          select: { id: true, name: true, attributes: true },
        });
        const selected = new Set(offeringNames);
        for (const name of offeringNames) {
          const previous = existing.find((row) => row.name === name);
          const attributes = withSelectionMarker(
            previous?.attributes,
            true,
            at,
          ) as Prisma.InputJsonValue;
          await tx.offering.upsert({
            where: { companyId_name: { companyId, name } },
            update: { attributes },
            create: {
              workspaceId: ctx.workspaceId,
              companyId,
              name,
              source: 'onboarding',
              attributes,
            },
          });
        }
        for (const offering of existing) {
          if (selected.has(offering.name)) continue;
          await tx.offering.update({
            where: { id: offering.id },
            data: {
              attributes: withSelectionMarker(
                offering.attributes,
                false,
                at,
              ) as Prisma.InputJsonValue,
            },
          });
        }
      } else {
        const existing = await tx.offering.findMany({
          where: { companyId },
          select: { name: true },
        });
        offeringNames = existing.map((row) => row.name);
      }

      // 与 POST /companies 的 P5 逻辑同源：卖家事实 → NEEDS_REVIEW Claim 草稿，
      // 人工审批后才进入 ICP/寻源，不是自动事实。
      const draftSpecs = buildProfileClaimDraftSpecs({
        industry: updated.industry,
        targetMarkets: updated.targetMarkets,
        offeringNames,
      });
      if (draftSpecs.length > 0) {
        await synthesizeProfileClaimDrafts(tx, {
          workspaceId: ctx.workspaceId,
          companyId,
          specs: draftSpecs,
        });
      }
      return updated;
    });
  }
}
