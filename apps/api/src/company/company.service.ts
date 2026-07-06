import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { CreateCompanyDto } from './dto/create-company.dto';
import { assertPublicHttpUrl } from '../adapters/url-guard';

type CompanyRow = Prisma.CompanyProfileGetPayload<Record<string, never>>;

@Injectable()
export class CompanyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a DRAFT profile and append the event that will drive understanding.
   * website 先过我方侧 SSRF 守卫（PRD 10.7.3）；Idempotency-Key 重放返回首个结果
   * （PRD 11.16）。
   */
  async create(
    ctx: RequestContext,
    dto: CreateCompanyDto,
    idempotencyKey?: string,
  ): Promise<{ company: CompanyRow; replayed: boolean }> {
    await assertPublicHttpUrl(dto.website);

    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      if (idempotencyKey) {
        const prior = await tx.idempotencyKey.findUnique({
          where: {
            workspaceId_endpoint_key: {
              workspaceId: ctx.workspaceId,
              endpoint: 'POST /companies',
              key: idempotencyKey,
            },
          },
        });
        if (prior) {
          const stored = prior.response as unknown as CompanyRow & { createdAt: string; updatedAt: string };
          return {
            company: { ...stored, createdAt: new Date(stored.createdAt), updatedAt: new Date(stored.updatedAt) },
            replayed: true,
          };
        }
      }

      // JIT-provision the tenant anchor so domain FKs resolve.
      await tx.workspace.upsert({
        where: { id: ctx.workspaceId },
        update: {},
        create: { id: ctx.workspaceId },
      });

      const company = await tx.companyProfile.create({
        data: {
          workspaceId: ctx.workspaceId,
          name: dto.name ?? new URL(dto.website).hostname,
          website: dto.website,
          status: 'DRAFT',
        },
      });

      // Transactional outbox (ADR-009): understanding pipeline consumes this.
      await tx.outboxEvent.create({
        data: {
          workspaceId: ctx.workspaceId,
          eventType: 'CompanyProfileCreated',
          aggregateType: 'CompanyProfile',
          aggregateId: company.id,
          payload: { website: dto.website },
        },
      });

      if (idempotencyKey) {
        await tx.idempotencyKey.create({
          data: {
            workspaceId: ctx.workspaceId,
            endpoint: 'POST /companies',
            key: idempotencyKey,
            response: company as unknown as Prisma.InputJsonValue,
          },
        });
      }

      return { company, replayed: false };
    });
  }

  async list(ctx: RequestContext, limit: number, cursor?: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = await tx.companyProfile.findMany({
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      return {
        data,
        nextCursor: hasMore ? data[data.length - 1].id : null,
        hasMore,
      };
    });
  }

  async get(ctx: RequestContext, id: string) {
    // RLS confines findUnique to this workspace → cross-tenant reads return null → 404.
    const company = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.companyProfile.findUnique({ where: { id } }),
    );
    if (!company) {
      throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
    }
    return company;
  }

  /** 完整度视图（5.2.7）：企业当前可用性的量化依据。 */
  async completeness(ctx: RequestContext, id: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!company) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      }
      const [approved, pending, offerings, conflictsOpen] = await Promise.all([
        tx.claim.count({ where: { companyId: id, status: 'APPROVED' } }),
        tx.claim.count({ where: { companyId: id, status: 'NEEDS_REVIEW' } }),
        tx.offering.count({ where: { companyId: id } }),
        tx.knowledgeConflict.count({ where: { companyId: id, status: 'OPEN' } }),
      ]);
      return { status: company.status, approvedClaims: approved, pendingClaims: pending, offerings, conflictsOpen };
    });
  }

  /** 人工确认（5.2.4 Gate 的显式出口）：REVIEW → ACTIVE，不等审批阈值。 */
  async confirm(ctx: RequestContext, id: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id } });
      if (!company) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      }
      if (company.status !== 'REVIEW') {
        throw new ConflictException({
          error: { code: 'INVALID_STATE', message: `company is ${company.status}; only REVIEW can be confirmed` },
        });
      }
      return tx.companyProfile.update({ where: { id }, data: { status: 'ACTIVE', version: { increment: 1 } } });
    });
  }

  /** 结构化产品/服务（理解工作流抽取，带溯源）。company 不存在时 404。 */
  async listOfferings(ctx: RequestContext, companyId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id: companyId }, select: { id: true } });
      if (!company) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      }
      return tx.offering.findMany({
        where: { companyId },
        orderBy: [{ confidence: 'desc' }, { name: 'asc' }],
      });
    });
  }
}
