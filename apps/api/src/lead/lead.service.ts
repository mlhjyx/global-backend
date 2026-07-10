import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import {
  buildLeadQualifiedSnapshot,
  classifyLeadQualified,
  LEAD_QUALIFIED_SCHEMA_VERSION,
} from './lead-qualified-snapshot';

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
      // 幂等短路（C）：已是目标状态（双击/HTTP 重试）→ 返回现状，不建第二条 decision、
      // 不发第二条 LeadQualified——重发的 event_id 不同，消费端按 event_id 的去重会失效
      // （SaaS 收到两次 handoff）。QUALIFIED→reject 的人工改判仍允许（不落在此分支）。
      if (lead.status === status) return lead;
      // CAS 乐观锁（C）：带读时 version 条件更新。并发 decide 后者 count=0 → 409，
      // 客户端重读再决定——防双写 decision + 双发事件。
      const cas = await tx.lead.updateMany({
        where: { id: leadId, version: lead.version },
        data: {
          status: status as never,
          queue: action === 'accept' ? 'recommended' : 'rejected',
          version: { increment: 1 },
        },
      });
      if (cas.count === 0) {
        throw new ConflictException({
          error: { code: 'CONFLICT', message: 'lead was modified concurrently; retry' },
        });
      }
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
        // 收口③：payload = LeadQualified 快照 v1（decide 事务当刻取数的不可变副本，
        // 之后 lead/company 变化不回写）。契约 lead-qualified.v1.schema.json。
        const company = await tx.canonicalCompany.findUnique({
          where: { id: lead.canonicalCompanyId },
          include: { contacts: { include: { contactPoints: true } } },
        });
        // FK（Lead→CanonicalCompany onDelete:Cascade）保证同事务内公司存在；此守卫仅防御性。
        if (!company) {
          throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'canonical company not found' } });
        }
        const icp = await tx.icpDefinition.findUnique({
          where: { id: lead.icpId },
          select: { version: true },
        });
        const snapshot = buildLeadQualifiedSnapshot({
          lead,
          company,
          icpVersion: icp?.version ?? null,
        });
        await tx.outboxEvent.create({
          data: {
            workspaceId: ctx.workspaceId,
            eventType: 'LeadQualified',
            aggregateType: 'Lead',
            aggregateId: leadId,
            schemaVersion: LEAD_QUALIFIED_SCHEMA_VERSION,
            // 分级按内容定（H）：含具名人 refs → RESTRICTED（后续保留/删除策略挂此级）。
            privacyClassification: classifyLeadQualified(snapshot),
            payload: snapshot as unknown as Prisma.InputJsonValue,
          },
        });
      }
      // updateMany 不返回行 → 重取 CAS 后的 lead 作为响应（同事务内读，状态一致）。
      const updated = await tx.lead.findUnique({ where: { id: leadId } });
      return updated ?? lead;
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
