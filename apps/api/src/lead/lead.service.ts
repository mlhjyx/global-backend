import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';

@Injectable()
export class LeadService {
  constructor(private readonly prisma: PrismaService) {}

  /** 触发对某 ACTIVE ICP 的评分（异步，Temporal）。 */
  async qualify(ctx: RequestContext, icpId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const icp = await tx.icpDefinition.findUnique({ where: { id: icpId }, select: { id: true, status: true } });
      if (!icp) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'icp not found' } });
      if (icp.status !== 'ACTIVE') {
        throw new ConflictException({
          error: { code: 'INVALID_STATE', message: `icp is ${icp.status}; qualify requires ACTIVE` },
        });
      }
      const ev = await tx.outboxEvent.create({
        data: {
          workspaceId: ctx.workspaceId,
          eventType: 'QualifyRequested',
          aggregateType: 'ICP',
          aggregateId: icpId,
          payload: {},
        },
      });
      return { accepted: true, eventId: ev.eventId };
    });
  }

  list(
    ctx: RequestContext,
    opts: { icpId?: string; queue?: string; status?: string; limit: number; cursor?: string },
  ) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = await tx.lead.findMany({
        where: {
          ...(opts.icpId ? { icpId: opts.icpId } : {}),
          ...(opts.queue ? { queue: opts.queue } : {}),
          ...(opts.status ? { status: opts.status as never } : {}),
        },
        take: opts.limit + 1,
        ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
        // nulls last：fit 门先建的 Lead 尚无分（totalScore=null），PG 默认 DESC NULLS FIRST 会把
        // 未评分行顶到列表最前——显式压到最后，评分完成后自然按分排。
        orderBy: [{ totalScore: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
      });
      const hasMore = rows.length > opts.limit;
      const data = hasMore ? rows.slice(0, opts.limit) : rows;
      // 附公司摘要（跨表查询而非 include：lead 与 canonical 无 Prisma relation）
      const companies = await tx.canonicalCompany.findMany({
        where: { id: { in: data.map((l) => l.canonicalCompanyId) } },
        select: { id: true, name: true, domain: true, country: true, industry: true, employeeCount: true },
      });
      const byId = new Map(companies.map((c) => [c.id, c]));
      return {
        data: data.map((l) => ({ ...l, company: byId.get(l.canonicalCompanyId) ?? null })),
        nextCursor: hasMore ? data[data.length - 1].id : null,
        hasMore,
      };
    });
  }

  async get(ctx: RequestContext, leadId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id: leadId }, include: { decisions: true } });
      if (!lead) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'lead not found' } });
      const company = await tx.canonicalCompany.findUnique({
        where: { id: lead.canonicalCompanyId },
        include: { contacts: { include: { contactPoints: true } } },
      });
      return { ...lead, company };
    });
  }

  /**
   * 人工裁决（LED-009）：accept → QUALIFIED（发 LeadQualified，Campaign 的入口）；
   * reject → REJECTED。裁决记录留痕，重评分不覆盖人工终态。
   */
  async decide(ctx: RequestContext, leadId: string, action: 'accept' | 'reject', reason?: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id: leadId } });
      if (!lead) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'lead not found' } });
      if (lead.status === 'SUPPRESSED') {
        throw new ConflictException({ error: { code: 'SUPPRESSED', message: 'suppressed lead cannot be decided' } });
      }
      if (['CONTACTED', 'CONVERTED'].includes(lead.status)) {
        throw new ConflictException({
          error: { code: 'INVALID_STATE', message: `lead is ${lead.status}; already past decision` },
        });
      }
      const status = action === 'accept' ? 'QUALIFIED' : 'REJECTED';
      const updated = await tx.lead.update({
        where: { id: leadId },
        data: {
          status: status as never,
          queue: action === 'accept' ? 'recommended' : 'rejected',
          version: { increment: 1 },
        },
      });
      await tx.leadDecision.create({
        data: {
          workspaceId: ctx.workspaceId,
          leadId,
          action,
          reason: reason ?? null,
          decidedBy: ctx.userId,
        },
      });
      if (action === 'accept') {
        await tx.outboxEvent.create({
          data: {
            workspaceId: ctx.workspaceId,
            eventType: 'LeadQualified',
            aggregateType: 'Lead',
            aggregateId: leadId,
            payload: { icpId: lead.icpId, canonicalCompanyId: lead.canonicalCompanyId, totalScore: lead.totalScore },
          },
        });
      }
      return updated;
    });
  }

  /** 四队列计数（LED-008 的工作台视图数据）。 */
  queueSummary(ctx: RequestContext, icpId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = await tx.lead.groupBy({
        by: ['queue'],
        where: { icpId },
        _count: { _all: true },
      });
      const summary: Record<string, number> = { recommended: 0, needs_review: 0, rejected: 0, suppressed: 0 };
      for (const r of rows) summary[r.queue] = r._count._all;
      return summary;
    });
  }
}
