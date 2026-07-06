import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { CreateCompanyDto } from './dto/create-company.dto';

@Injectable()
export class CompanyService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a DRAFT profile and append the event that will drive understanding. */
  async create(ctx: RequestContext, dto: CreateCompanyDto) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
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

      return company;
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
