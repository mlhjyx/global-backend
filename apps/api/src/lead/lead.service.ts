import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import {
  buildLeadQualifiedSnapshot,
  classifyLeadQualified,
  LEAD_QUALIFIED_SCHEMA_VERSION,
} from './lead-qualified-snapshot';
import { DataRightsService } from '../compliance/data-rights.service';
import { storageRightsContextForLead } from '../compliance/data-rights.context';
import { SanctionsScreeningService, reconcileReviewState, matchesFromJson } from '../sanctions/sanctions-screening.service';

@Injectable()
export class LeadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataRights: DataRightsService,
    private readonly sanctions: SanctionsScreeningService,
  ) {}

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
        // 🔴 Art.17 竞态闸（Codex PR #72）：交棒前**先对公司行加行锁**（SELECT … FOR UPDATE），
        // 与 freezeSubject 的 `status=SUPPRESSED` updateMany 串行化。两种交错都被关死：
        //  ① freeze 先提交 → 本锁在其提交后才拿到，READ COMMITTED 下随后 findUnique 读到 SUPPRESSED
        //     → 下方 rights=DENY 挡下交棒；
        //  ② 本 decide 先拿锁 → freeze 阻塞到 handoff 提交后才 suppress（合法的「冻结之前」序）。
        // 纯 findUnique 无锁：freeze 可在「读之后、本事务提交之前」落定 SUPPRESSED，旧代码仍据陈旧
        // ENRICHED 交棒——正是本 guard 要堵的 Art.17 漏网。锁行是关闭该窗口的唯一手段（重读只窄化不关闭）。
        // 行不存在（FK 保证不会）→ 返 0 行、无锁，下方 findUnique 得 null 走 NOT_FOUND 守卫。
        await tx.$queryRaw`SELECT id FROM canonical_company WHERE id = ${lead.canonicalCompanyId}::uuid FOR UPDATE`;
        // 收口③：payload = LeadQualified 快照 v1（decide 事务当刻取数的不可变副本，
        // 之后 lead/company 变化不回写）。契约 lead-qualified.v1.schema.json。
        // 加锁后再读——company.status 此刻反映 freeze 是否已提交的最新状态，快照+权利判定同基于此读。
        const company = await tx.canonicalCompany.findUnique({
          where: { id: lead.canonicalCompanyId },
          include: { contacts: { include: { contactPoints: true } } },
        });
        // FK（Lead→CanonicalCompany onDelete:Cascade）保证同事务内公司存在；此守卫仅防御性。
        if (!company) {
          throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'canonical company not found' } });
        }
        // 🔴 第五门制裁筛查硬 re-check（decide 不可绕的终极安全网）：live 重筛（catch 名单自 qualify 后的更新）
        // + reconcile 既有复核态。命中且未被人工清（open/confirmed）→ 抛 SANCTIONS_HOLD_UNRESOLVED，
        // **回滚整个 decide、绝不建/发快照**（绝不把被制裁公司交付客户）。未启用(DISABLED)→ not_screened、不拦。
        const screen = this.sanctions.screen(company.name, company.country);
        // 🔴 持久化命中（qualify 写）**独立于 live 索引新鲜度**读取——闭合跨进程 fail-open 窗口（复审 #1）：
        // 即便 live screen 因 API 索引空/陈旧/构建失败返 not_screened，只要库里有未清的命中就硬拦。
        const prior = await tx.sanctionsScreeningResult.findFirst({
          where: { canonicalCompanyId: company.id },
          orderBy: { screenedAt: 'desc' },
          select: { status: true, reviewState: true, matches: true, listVersions: true },
        });
        const priorBlocking = !!prior && prior.status === 'potential_match' && prior.reviewState !== 'cleared_false_positive';
        let liveBlocking = false;
        if (screen.status === 'potential_match') {
          const reviewState = reconcileReviewState(
            prior ? { reviewState: prior.reviewState, matches: matchesFromJson(prior.matches) } : null,
            screen.matches,
          );
          liveBlocking = reviewState !== 'cleared_false_positive';
        }
        if (priorBlocking || liveBlocking) {
          throw new ConflictException({
            error: {
              code: 'SANCTIONS_HOLD_UNRESOLVED',
              message: 'sanctions screening hit — handoff blocked pending human review (fifth gate)',
            },
          });
        }
        // 未拦 → 合规结论（诚实）：曾被真实筛过（live 索引 active，或 qualify 已筛并留有记录）→ clear；
        // 从未筛过（门 DISABLED 且无历史记录）→ not_screened（SaaS 不得据此对外触达）。
        const wasScreened = screen.status !== 'not_screened' || !!prior;
        const sanctionsScreening: { status: 'clear' | 'not_screened'; screenedAt: string; listVersions: Record<string, string> } = {
          status: wasScreened ? 'clear' : 'not_screened',
          screenedAt: new Date().toISOString(),
          listVersions:
            screen.status !== 'not_screened'
              ? screen.listVersions
              : ((prior?.listVersions as Record<string, string> | null) ?? {}),
        };
        const icp = await tx.icpDefinition.findUnique({
          where: { id: lead.icpId },
          select: { version: true },
        });
        // 鲜度模型（v2）：取本公司 + 其联系人 field_evidence **每个分级的最早抓取时刻**算 valid_until。
        // groupBy 有界（每分级 1 行，≤3~4 条）——同一分级 TTL 恒定 → 最早抓取即该级最早失效；
        // 避免把一家公司累积的全部证据行拉进 decide 写事务。entity_id 全局唯一 uuid + withWorkspace(RLS) 双重作用域。
        const evidenceByClass = await tx.fieldEvidence.groupBy({
          by: ['dataClass'],
          where: { entityId: { in: [company.id, ...company.contacts.map((c) => c.id)] } },
          _min: { fetchedAt: true },
        });
        const evidence = evidenceByClass
          .filter((g) => g._min.fetchedAt != null)
          .map((g) => ({ dataClass: g.dataClass, fetchedAt: g._min.fetchedAt as Date }));
        // 收口⑥：存储权利判定 + **强制**（不只标注，确定性纯引擎、缓存规则同步无 await）。
        // 具名决策人 → red；公司国别 → 主体法域；公司 SUPPRESSED → DENY。
        const rightsCtx = storageRightsContextForLead({
          country: company.country,
          status: company.status,
          hasNamedContacts: company.contacts.length > 0,
        });
        const rights = this.dataRights.evaluate(rightsCtx);
        // 🔴 !allowed 一律**不交棒**——统一挡住：① 禁联/Art.17 冻结（freezeSubject 置
        // company.status=SUPPRESSED，而 Lead 状态异步才更新，存在竞态窗口）② 跨境人审
        // REQUIRE_APPROVAL（EU/UK 主体→CN 处理地）③ 无合法性基础 ALLOW_WITH_BASIS（如 PIPL CN 主体）。
        // 防「storage_rights=DENY 却仍 handoff_to_campaign + 具名 refs」的自相矛盾输出流向 SaaS。
        // 规则未加载时引擎对 red 数据 fail-closed（DENY）→ 同样挡下（安全）。
        if (!rights.allowed) {
          throw new ConflictException({
            error: {
              code: 'STORAGE_RIGHTS_NOT_GRANTED',
              message: `storage rights ${rights.effect} — handoff blocked pending approval/lawful basis`,
            },
          });
        }
        // #72 P2：存储权利判定的审计留痕（policy_decision_log，append-only）——与 LeadQualified 交棒**同事务**
        // 原子（日志与交棒共存亡，不会交棒无日志/日志无交棒）。DENY 路径上方已 throw 回滚，故此处只记**成功交棒**
        // 的 STORE 判定（含 effect/rule/actor/subject/Art.14 标记），补齐合规审计对"为何允许具名 refs 离开后端"的证据。
        await this.dataRights.logDecision(tx, ctx.workspaceId, rightsCtx, rights, {
          subjectType: 'lead',
          subjectId: leadId,
          actorId: ctx.userId,
        });
        const snapshot = buildLeadQualifiedSnapshot({
          lead,
          company,
          icpVersion: icp?.version ?? null,
          storageRightsDecision: rights.effect,
          evidence,
          sanctionsScreening, // 第五门合规结论（clear/not_screened；命中 hold 上方已 throw 到不了这里）
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
      const summary: Record<string, number> = { recommended: 0, needs_review: 0, rejected: 0, suppressed: 0, sanctions_hold: 0 };
      for (const r of rows) summary[r.queue] = r._count._all;
      return summary;
    });
  }

  /**
   * 制裁筛查复核裁决（第五门人审）：`cleared_false_positive`（误报——回落正常队列，reconcile 抑制复发）
   * 或 `confirmed_true_hit`（真命中——留 sanctions_hold，永不交付）。按 lead 找公司最新筛查结果更新复核态。
   * 误报清白 → 该公司**全部**被 hold 的 lead 回落 needs_review（下次 qualify 重评据 reconcile 不再 hold）。
   */
  async reviewSanctions(
    ctx: RequestContext,
    leadId: string,
    decision: 'cleared_false_positive' | 'confirmed_true_hit',
    note?: string,
  ) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id: leadId }, select: { id: true, canonicalCompanyId: true } });
      if (!lead) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'lead not found' } });
      const result = await tx.sanctionsScreeningResult.findFirst({
        where: { canonicalCompanyId: lead.canonicalCompanyId },
        orderBy: { screenedAt: 'desc' },
        select: { id: true, reviewState: true },
      });
      if (!result) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'no sanctions screening result for this lead' } });
      }
      // 🔴 复审 #3：confirmed_true_hit 不可经本端点翻成 cleared——真命中不可轻易解除（需更高流程/人，非单次 API 调用）。
      if (result.reviewState === 'confirmed_true_hit' && decision === 'cleared_false_positive') {
        throw new ConflictException({
          error: { code: 'SANCTIONS_CONFIRMED_IMMUTABLE', message: 'a confirmed sanctions hit cannot be cleared via this endpoint' },
        });
      }
      await tx.sanctionsScreeningResult.update({
        where: { id: result.id },
        data: { reviewState: decision, reviewedBy: ctx.userId, reviewNote: note ?? null },
      });
      if (decision === 'cleared_false_positive') {
        await tx.lead.updateMany({
          where: { canonicalCompanyId: lead.canonicalCompanyId, queue: 'sanctions_hold' },
          data: { queue: 'needs_review' },
        });
      }
      return { leadId, reviewState: decision };
    });
  }
}
