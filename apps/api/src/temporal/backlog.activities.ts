import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import { DiscoveryProviderRegistry } from '../discovery/provider.registry';
import { EnrichmentResult, ExecutionContext, LawfulBasis, LawfulBasisKind, ProviderContactRecord } from '../discovery/provider-contract';
import { BudgetExceededError, budgetLedger, sweepBudgetCents } from '../tools/budget';
import type { ExecutionBroker } from '../tools/tool-contract';
import { judgeFitCompany, loadIcpBrief, upsertLeadFit } from '../discovery/fit-judge';
import { persistDiscoveredContacts } from '../discovery/contact-persist';
import { EmailGuesser, GuessResult } from '../discovery/email-guesser';
import { persistGuessedEmail } from '../discovery/email-guess-persist';
import { buildGuessTargets } from '../discovery/email-guess-targets';
import { LAWFUL_BASIS_KINDS } from '../discovery/compliance/email-verification-gate';
import { KnownEmailSample } from '../discovery/email-format-learning';
import { IntentProjectionService } from '../intent/intent-projection.service';
import { normalizeDomain } from '../discovery/identity';
import { WEB_WATCH_KEY } from '../intent/website-watch.service';
import { backlogEligibleWhere, backlogEligibleOrderBy } from './backlog.eligibility';

/**
 * 存量对账活动（backlog reconciliation）——漏斗总闸的解锁器。
 *
 * 为什么存在：qualifyFitForRun/enrichRun/enrichSignalsRun 都是 **run 前向取件**（只处理本 run
 * 归一出的公司）。经租户投影进来的公司（trade_fair/mapyourshow 平台采集→投影）从不属于任何 run，
 * 永远够不到 fit 门 → 实测 982/1040 家卡在 fitVerdict=null，漏斗断流。这组活动按 workspace 对
 * **存量**做同语义处理（判定/富集/信号/监控/联系人），由 backlogSweepWorkflow 编排 + Schedule 周期驱动。
 *
 * 工程纪律（与既有活动一致）：
 *  - 游标 = `id > cursor`（非 Prisma cursor）：行被处理后离开过滤集不影响分页，单 sweep 每行至多
 *    访问一次（防 LLM/抓取持续失败时的活锁）；跨 sweep 自然重试。
 *  - 网络调用（LLM/抓取）一律在事务外；每家命中单独短事务落库；单家失败不影响其余（§5 fail-safe）。
 *  - DAT-011：SUSPENDED 域名对抓取类（信号/联系人）一律跳过。
 *  - ownerDb 仅用于**平台级只读扫描**（跨租户列 ACTIVE ICP——RLS 下 app_user 不可见），
 *    与 OutboxRelayService 同一「受信系统扫描器」先例；租户数据读写仍走 withWorkspace。
 */

const SIGNAL_TTL_MS = 7 * 24 * 3600 * 1000; // 与 discovery.activities 的 SIGNAL_TTL_MS 对齐（信号时变，7 天刷新）

/** 引擎级 kill-switch 的 data_provider key（默认 DISABLED；见 provider.registry seed）。 */
const EMAIL_GUESS_KEY = 'email_guess';

/**
 * 从 `email_guess` provider 的 `config`（Json）解析已配置的 **interim 全局 LIA**（选项 B P0.4 §2）。
 * 形如 `{ lawfulBasis: { basis, ref?, note? } }`，`basis` 必须 ∈ {@link LAWFUL_BASIS_KINDS}；
 * 缺失/非法 → undefined（自动路径**一个都不探**，绝不用 allowPersonalWithoutBasis 兜底）。纯函数、可测。
 */
export function parseConfiguredLawfulBasis(config: unknown): LawfulBasis | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const raw = (config as Record<string, unknown>).lawfulBasis;
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.basis !== 'string' || !(LAWFUL_BASIS_KINDS as readonly string[]).includes(r.basis)) return undefined;
  return {
    basis: r.basis as LawfulBasisKind,
    ...(typeof r.ref === 'string' ? { ref: r.ref } : {}),
    ...(typeof r.note === 'string' ? { note: r.note } : {}),
  };
}

export interface BacklogPage {
  workspaceId: string;
  limit?: number;
  /** 上一批最后扫描到的公司 id；null/缺省 = 从头。 */
  cursor?: string | null;
}

export interface FitBacklogResult {
  scanned: number;
  judged: number;
  verdicts: Record<string, number>;
  nextCursor: string | null;
}
export interface EnrichBacklogResult {
  scanned: number;
  attempted: number;
  matched: number;
  nextCursor: string | null;
}
export interface WatchBacklogResult {
  scanned: number;
  registered: number;
  nextCursor: string | null;
}
export interface ContactBacklogResult {
  scanned: number;
  attempted: number;
  contactsCreated: number;
  nextCursor: string | null;
}
export interface GuessEmailsBacklogResult {
  scanned: number;
  attempted: number;
  guessed: number;
  /** 双闸未过（kill-switch/无 LIA）或无验证器 → 未探测。 */
  skipped?: boolean;
  reason?: string;
  nextCursor: string | null;
}

/** 邮箱猜测阶段的单个补全对象（缺 email contact_point 的具名决策人）。 */
interface EmaillessTarget {
  contactId: string;
  fullName: string;
}
/** 邮箱猜测阶段的单家公司（有域名 + 有界缺邮箱决策人 + 同域格式样本）。 */
interface GuessTargetCompany {
  id: string;
  domain: string;
  emailless: EmaillessTarget[];
  knownSamples: KnownEmailSample[];
}

export function createBacklogActivities(deps: {
  prisma: PrismaService;
  providers: DiscoveryProviderRegistry;
  gateway: ModelGateway;
  /** owner 连接（DATABASE_URL）：仅跨租户只读扫描（列 ACTIVE ICP）。 */
  ownerDb: PrismaClient;
  /** 收口②：registerWatch 的 sitemap 探测出网经此闸门。 */
  broker?: ExecutionBroker;
}) {
  const intentSvc = new IntentProjectionService({ prisma: deps.prisma, broker: deps.broker });

  /**
   * 收口② D：sweep 阶段预算——按「阶段×workspace」开账、**每页活动**结束配对 close
   * （BudgetLedger 引用计数：并发同键页共享同一 cap，先完成者 close 不误删他人在用的账）。
   * 语义如实：SWEEP_BUDGET_CENTS 是**单页×阶段**的硬上界（默认页 20-40 家 × est ≪ cap，正常
   * 打不到；打到即该页截断 + nextCursor=null 收手）。跨页的**整轮** sweep 硬上界需要持久化
   * 账本（进程内 Map 撑不起 workflow 级生命周期）——已记档随收口⑤/R2 预算基建收紧。
   */
  const openStageBudget = (stage: string, workspaceId: string): { key: string; close: () => void } => {
    const key = `sweep:${stage}:${workspaceId}`;
    budgetLedger.open(key, sweepBudgetCents());
    return { key, close: () => budgetLedger.close(key) };
  };

  /** DAT-011：SUSPENDED 域名黑名单（平台治理表，无 RLS）。 */
  async function suspendedDomains(): Promise<Set<string>> {
    const rows = await deps.prisma.sourcePolicy.findMany({ where: { reviewStatus: 'SUSPENDED' }, select: { domain: true } });
    return new Set(rows.map((r) => r.domain.toLowerCase()));
  }

  /**
   * 处理后写水位（无论命中与否，含 DAT-011/新鲜跳过）：让本批已处理的行离开当批过滤集，
   * 游标真正吞噬存量。ids 空 → no-op。updateMany 在 withWorkspace 内 → RLS 只触本租户行。
   */
  async function stampProcessed(
    workspaceId: string,
    ids: string[],
    data: Prisma.CanonicalCompanyUpdateManyMutationInput,
  ): Promise<void> {
    if (!ids.length) return;
    await deps.prisma.withWorkspace(workspaceId, (tx) =>
      tx.canonicalCompany.updateMany({ where: { id: { in: ids } }, data }),
    );
  }

  return {
    /** 跨租户列 ACTIVE ICP（owner 只读扫描）→ backlog sweep 的处理目标。 */
    async listBacklogTargets(): Promise<{ targets: { workspaceId: string; icpId: string }[] }> {
      const icps = await deps.ownerDb.icpDefinition.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, workspaceId: true },
        orderBy: { createdAt: 'asc' },
      });
      return { targets: icps.map((i) => ({ workspaceId: i.workspaceId, icpId: i.id })) };
    },

    /**
     * 存量资格门（**per-ICP**）：对「尚无本 ICP 已判 Lead」的 canonical 公司跑四门判别，写
     * Lead(本 ICP × 公司).fit_verdict（与 qualifyFitForRun 共享 upsertLeadFit 核心）。
     * 这是解锁 920+ 家投影公司进漏斗的总闸；listBacklogTargets 已按 ACTIVE ICP 枚举 → 每 ICP 独立判、互不覆盖。
     * 游标语义仍成立：判定后该公司获得本 ICP 的 Lead.fitVerdict≠null → 永久离开本 ICP 过滤集（集单调收缩、无冷却复活）。
     */
    async qualifyFitBacklog(args: BacklogPage & { icpId: string }): Promise<FitBacklogResult> {
      const limit = args.limit ?? 40;
      const { icpBrief, companies } = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const icpBrief = await loadIcpBrief(tx, args.icpId);
        const companies = await tx.canonicalCompany.findMany({
          where: {
            // 尚无「本 ICP」的已判 Lead（无 Lead 或该 Lead.fitVerdict 为 null）→ 才判定（per-ICP，非公司级）。
            NOT: { leads: { some: { icpId: args.icpId, fitVerdict: { not: null } } } },
            status: { not: 'SUPPRESSED' },
            ...(args.cursor ? { id: { gt: args.cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: limit,
          select: { id: true, name: true, domain: true, country: true, industry: true, attributes: true },
        });
        return { icpBrief, companies };
      });

      const verdicts: Record<string, number> = { match: 0, weak: 0, mismatch: 0 };
      let judged = 0;
      let skippedForBudget = 0;
      const budget = openStageBudget('fit', args.workspaceId);
      try {
        for (let i = 0; i < companies.length; i++) {
          const c = companies[i];
          let judgment;
          try {
            judgment = await judgeFitCompany(deps.gateway, args.workspaceId, icpBrief, c, { runId: budget.key });
          } catch (err) {
            if (err instanceof BudgetExceededError) {
              // 预算耗尽 → 中断本页并显性计数；游标**不**吞掉这些行（下轮 sweep 重判）
              skippedForBudget = companies.length - i;
              console.warn(`[backlog] fit 阶段预算耗尽（ws=${args.workspaceId}）：本页跳过余下 ${skippedForBudget} 家，下轮 sweep 重判`);
              break;
            }
            throw err;
          }
          if (!judgment) continue; // 单家判别失败不影响其余；本 sweep 不重试（游标只前进），下个 sweep 再来
          verdicts[judgment.verdict] += 1;
          judged += 1;
          await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
            upsertLeadFit(tx, args.workspaceId, args.icpId, c.id, judgment),
          );
        }
      } finally {
        budget.close();
      }
      if (skippedForBudget > 0) {
        // 预算截断的行未获 fitVerdict → 仍在过滤集内，nextCursor 置 null 让本 ICP 本轮就此收手
        // （继续翻页只会连环触发同一账户超限）。
        return { scanned: companies.length, judged, verdicts, nextCursor: null };
      }
      return {
        scanned: companies.length,
        judged,
        verdicts,
        nextCursor: companies.length === limit ? companies[companies.length - 1].id : null,
      };
    },

    /** 存量快事实富集（GLEIF/Wikidata）：fit=match 且缺任一源命名空间的公司（与 enrichRun 同语义）。 */
    async enrichBacklog(args: BacklogPage): Promise<EnrichBacklogResult> {
      const limit = args.limit ?? 25;
      const now = new Date();
      const enrichers = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        deps.providers.routeEnrichment(tx as never),
      );
      if (!enrichers.length) return { scanned: 0, attempted: 0, matched: 0, nextCursor: null };

      const companies = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.canonicalCompany.findMany({
          where: backlogEligibleWhere({ watermarkField: 'lastEnrichedAt', now }),
          orderBy: backlogEligibleOrderBy('lastEnrichedAt'),
          take: limit,
          select: { id: true, name: true, domain: true, country: true, region: true, attributes: true },
        }),
      );

      let attempted = 0;
      let matched = 0;
      for (const c of companies) {
        const existing = ((c.attributes as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
        const pending = enrichers.filter((e) => !existing[e.key]); // 已有该源命名空间 → 跳过（幂等）
        if (!pending.length) continue;
        attempted += 1;
        const hits: { key: string; result: EnrichmentResult }[] = [];
        const ctx: ExecutionContext = { workspaceId: args.workspaceId, correlationId: 'backlog-enrich' };
        for (const e of pending) {
          try {
            const r = await e.enrichCompany(
              {
                name: c.name,
                domain: c.domain ?? undefined,
                country: c.country ?? undefined,
                region: c.region ?? undefined,
              },
              ctx,
            );
            if (r.matched) hits.push({ key: e.key, result: r });
          } catch {
            /* 单富集源失败不影响其余 */
          }
        }
        if (!hits.length) continue;
        matched += 1;
        await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          const merged: Record<string, unknown> = { ...existing };
          for (const h of hits) merged[h.key] = h.result.attributes;
          // status=ENRICHED 在「真正富集成功」时写（与 enrichRun 一致）；SUPPRESSED 守护防竞态翻回。
          await tx.canonicalCompany.updateMany({
            where: { id: c.id, status: { not: 'SUPPRESSED' } },
            data: { attributes: merged as never, status: 'ENRICHED', version: { increment: 1 } },
          });
          for (const h of hits) {
            for (const [field, value] of Object.entries(h.result.attributes)) {
              if (value == null) continue;
              await tx.fieldEvidence.create({
                data: {
                  workspaceId: args.workspaceId,
                  entityType: 'company',
                  entityId: c.id,
                  field: `${h.key}.${field}`,
                  value: value as Prisma.InputJsonValue,
                  providerKey: h.key,
                  confidence: h.result.confidence,
                  license: 'public',
                  allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
                  ...(h.result.provenance ? { fetchedAt: new Date(h.result.provenance.fetchedAt) } : {}),
                },
              });
            }
          }
        });
      }
      // 水位：本批全部已处理（命中/未命中/已有命名空间跳过）→ 离开过滤集，游标吞噬存量。
      await stampProcessed(args.workspaceId, companies.map((c) => c.id), { lastEnrichedAt: now });
      return {
        scanned: companies.length,
        attempted,
        matched,
        nextCursor: companies.length === limit ? companies[companies.length - 1].id : null,
      };
    },

    /** 存量信号富集（digital_footprint/structured_harvest）：fit=match+域名，TTL 感知（与 enrichSignalsRun 同语义）。 */
    async enrichSignalsBacklog(args: BacklogPage): Promise<EnrichBacklogResult> {
      const limit = args.limit ?? 12;
      const now = new Date();
      const nowMs = now.getTime();
      const enrichers = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        deps.providers.routeSignalEnrichment(tx as never),
      );
      if (!enrichers.length) return { scanned: 0, attempted: 0, matched: 0, nextCursor: null };
      const suspended = await suspendedDomains();

      const companies = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.canonicalCompany.findMany({
          where: backlogEligibleWhere({ watermarkField: 'lastSignalAt', now, requireDomain: true }),
          orderBy: backlogEligibleOrderBy('lastSignalAt'),
          take: limit,
          select: { id: true, name: true, domain: true, country: true, region: true, attributes: true },
        }),
      );

      let attempted = 0;
      let matched = 0;
      for (const c of companies) {
        if (c.domain && suspended.has(c.domain.toLowerCase())) continue; // DAT-011
        const existing = ((c.attributes as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
        const pending = enrichers.filter((e) => {
          const prev = existing[e.key] as { _ts?: string } | undefined;
          return !(prev?._ts && nowMs - Date.parse(prev._ts) < SIGNAL_TTL_MS); // TTL 新鲜 → 跳过
        });
        if (!pending.length) continue;
        attempted += 1;
        const hits: { key: string; result: EnrichmentResult }[] = [];
        const ctx: ExecutionContext = { workspaceId: args.workspaceId, correlationId: 'backlog-signals' };
        for (const e of pending) {
          try {
            const r = await e.enrichCompany(
              {
                name: c.name,
                domain: c.domain ?? undefined,
                country: c.country ?? undefined,
                region: c.region ?? undefined,
              },
              ctx,
            );
            if (r.matched) hits.push({ key: e.key, result: r });
          } catch {
            /* 单信号源失败不影响其余 */
          }
        }
        if (!hits.length) continue;
        matched += 1;
        await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          const merged: Record<string, unknown> = { ...existing };
          for (const h of hits) merged[h.key] = { ...h.result.attributes, _ts: new Date(nowMs).toISOString() };
          await tx.canonicalCompany.update({
            where: { id: c.id },
            data: { attributes: merged as never, version: { increment: 1 } },
          });
          for (const h of hits) {
            for (const [field, value] of Object.entries(h.result.attributes)) {
              if (value == null) continue;
              await tx.fieldEvidence.create({
                data: {
                  workspaceId: args.workspaceId,
                  entityType: 'company',
                  entityId: c.id,
                  field: `${h.key}.${field}`,
                  value: value as Prisma.InputJsonValue,
                  providerKey: h.key,
                  confidence: h.result.confidence,
                  license: 'public',
                  allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
                  ...(h.result.provenance ? { fetchedAt: new Date(h.result.provenance.fetchedAt) } : {}),
                },
              });
            }
          }
        });
      }
      // 水位：本批全部已处理（命中/未命中/DAT-011/TTL 新鲜跳过）→ 离开过滤集，游标吞噬存量。
      await stampProcessed(args.workspaceId, companies.map((c) => c.id), { lastSignalAt: now });
      return {
        scanned: companies.length,
        attempted,
        matched,
        nextCursor: companies.length === limit ? companies[companies.length - 1].id : null,
      };
    },

    /**
     * 存量网站监控注册：fit=match+域名且**尚无 web_watch 源**的公司（sourceKey 预查省掉对已注册
     * 域名的重复 sitemap 探测）。registerWatch 本身按域名 upsert（多租户共享抓取）。
     */
    async registerWatchesBacklog(args: BacklogPage): Promise<WatchBacklogResult> {
      const limit = args.limit ?? 12;
      const now = new Date();
      const suspended = await suspendedDomains(); // DAT-011：SUSPENDED 域名连注册期 sitemap 探测都不发（与信号/联系人阶段一致）
      const companies = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        tx.canonicalCompany.findMany({
          where: backlogEligibleWhere({ watermarkField: 'lastWatchAt', now, requireDomain: true }),
          orderBy: backlogEligibleOrderBy('lastWatchAt'),
          take: limit,
          select: { id: true, domain: true },
        }),
      );
      if (!companies.length) return { scanned: 0, registered: 0, nextCursor: null };

      // 平台级预查（无 RLS）：已有 web_watch 源的域名跳过
      const keyOf = (d: string) => `${WEB_WATCH_KEY}:${normalizeDomain(d) ?? d.toLowerCase()}`;
      const keys = companies.filter((c) => c.domain).map((c) => keyOf(c.domain!));
      const existing = new Set(
        (
          await deps.prisma.monitoredSource.findMany({ where: { sourceKey: { in: keys } }, select: { sourceKey: true } })
        ).map((s) => s.sourceKey),
      );

      let registered = 0;
      for (const c of companies) {
        if (!c.domain || existing.has(keyOf(c.domain))) continue;
        if (suspended.has(c.domain.toLowerCase())) continue; // DAT-011：kill-switch 域名不注册、不探测 sitemap
        try {
          await intentSvc.registerWatch(args.workspaceId, c.id);
          registered += 1;
        } catch {
          /* 单家注册失败（sitemap 不可达/DAT-011）不影响其余 */
        }
      }
      // 水位：本批全部已处理（新注册/已注册跳过/DAT-011）→ 离开过滤集，游标吞噬存量。
      await stampProcessed(args.workspaceId, companies.map((c) => c.id), { lastWatchAt: now });
      return {
        scanned: companies.length,
        registered,
        nextCursor: companies.length === limit ? companies[companies.length - 1].id : null,
      };
    },

    /**
     * 存量联系人发现：fit=match+域名且**尚无任何联系人**的公司，走 registry 首选 adapter
     * （decision_maker：Impressum/管理层页具名决策人 → 买家角色分类）。🔴 具名人经
     * persistDiscoveredContacts 写 person.profile 证据（personal_data 标记，无 outreach 授权）。
     */
    async discoverContactsBacklog(args: BacklogPage & { icpId: string }): Promise<ContactBacklogResult> {
      const limit = args.limit ?? 8;
      const now = new Date();
      const suspended = await suspendedDomains();

      const { adapters, sellerCtx, suppressedEmails, companies } = await deps.prisma.withWorkspace(
        args.workspaceId,
        async (tx) => {
          const adapters = await deps.providers.routeContactDiscovery(tx as never);
          const icp = await tx.icpDefinition.findUnique({
            where: { id: args.icpId },
            include: { company: true, roles: true },
          });
          const sellerCtx = icp
            ? {
                seller: icp.company?.name ?? undefined,
                targetRoles: icp.roles.map((r) => r.title ?? r.role),
                offering: icp.company?.summary ?? undefined,
              }
            : undefined;
          const suppressedEmails = new Set(
            (await tx.suppressionRecord.findMany({ where: { type: 'email' } })).map((s) => s.value.toLowerCase()),
          );
          const companies = await tx.canonicalCompany.findMany({
            where: backlogEligibleWhere({
              watermarkField: 'contactDiscoveryAttemptedAt',
              now,
              requireDomain: true,
              requireNoPersonContact: true,
            }),
            orderBy: backlogEligibleOrderBy('contactDiscoveryAttemptedAt'),
            take: limit,
            select: { id: true, name: true, domain: true, country: true, dedupeKey: true },
          });
          return { adapters, sellerCtx, suppressedEmails, companies };
        },
      );
      if (!adapters.length || !companies.length) return { scanned: companies.length, attempted: 0, contactsCreated: 0, nextCursor: null };

      let attempted = 0;
      let contactsCreated = 0;
      // 只 stamp **真正处理过**的公司（含 DAT-011 跳过——不需抓，防每 sweep 重扫）；预算耗尽/未触达的
      // 尾部不入此表 → 保留水位、下轮 sweep 重试（与 qualifyFitBacklog 同纪律）。
      const processedIds: string[] = [];
      let budgetExhausted = false;
      const budget = openStageBudget('contact', args.workspaceId);
      try {
      for (const c of companies) {
        // 预算已打穿（本 sweep:contact 账户任一 reserve 失败）→ 停机：本家及后续不处理、不 stamp（下轮重试）。
        // 🔴 关键：adapter 的 fail-safe catch（decision_maker/public_web/companies_house 各自）会把
        // BudgetExceededError 吞成空结果，编排层区分不出「没决策人」还是「预算打穿被吞」——故用 BudgetLedger
        // 唯一真相点 wasExhausted 判，不靠源抛错（否则打穿后每家被误当「无决策人」stamp、离开水位永不重试）。
        if (budgetLedger.wasExhausted(budget.key)) {
          budgetExhausted = true;
          break;
        }
        if (c.domain && suspended.has(c.domain.toLowerCase())) {
          processedIds.push(c.id); // DAT-011：跳过抓取但仍已处理 → stamp（离开过滤集）
          continue;
        }
        // 事务外 fan-out：遍历全部 enabled 的联系人 adapter（decision_maker/public_web/companies_house…）。
        // 🔴 单 adapter 失败/闸门拒绝不阻断其余（fail-safe，含被 provider 吞掉的预算错——由 ledger 检出）。
        const perAdapter: { key: string; contacts: ProviderContactRecord[] }[] = [];
        for (const adapter of adapters) {
          try {
            const result = await adapter.discoverContacts(
              { name: c.name, domain: c.domain ?? undefined, country: c.country ?? undefined },
              { workspaceId: args.workspaceId, runId: budget.key, correlationId: 'backlog-contacts' },
              sellerCtx,
            );
            if (result.contacts.length) perAdapter.push({ key: adapter.key, contacts: result.contacts });
          } catch {
            // 单 adapter fail-safe：不阻断其余源
          }
        }
        // 本家处理过程中打穿预算 → 本家未真正处理完：不计 attempted、不 stamp、停机（下轮 sweep 重试）。
        if (budgetLedger.wasExhausted(budget.key)) {
          budgetExhausted = true;
          break;
        }
        attempted += 1;
        processedIds.push(c.id); // 本家已处理（建联系人/无具名决策人）
        if (!perAdapter.length) continue;
        // 同一 tx 内顺序 persist：同一人经 resolvePersonIdentity 跨 adapter 合并（email + officer_id 落同一条）。
        const created = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          let n = 0;
          for (const pa of perAdapter) {
            const res = await persistDiscoveredContacts(tx, {
              workspaceId: args.workspaceId,
              company: { id: c.id, dedupeKey: c.dedupeKey },
              adapterKey: pa.key,
              contacts: pa.contacts,
              suppressedEmails,
            });
            n += res.created;
          }
          return n;
        });
        contactsCreated += created;
      }
      } finally {
        budget.close();
      }
      // 水位：只对**已处理**的公司写 contactDiscoveryAttemptedAt（无具名决策人属常态，这条防「联系不上的
      // 公司」永占前排、每 sweep 重烧多页渲染+LLM——复审最尖锐的一条）。预算耗尽的尾部不 stamp、下轮重试。
      await stampProcessed(args.workspaceId, processedIds, { contactDiscoveryAttemptedAt: now });
      if (budgetExhausted) {
        // 预算耗尽即收手：nextCursor=null 停止翻页（继续只会连环触发同账户超限，与 qualifyFitBacklog 一致）。
        console.warn(
          `[backlog] contact 阶段预算耗尽（ws=${args.workspaceId}）：本页处理 ${processedIds.length} 家后停，未处理的保留水位下轮重试`,
        );
        return { scanned: companies.length, attempted, contactsCreated, nextCursor: null };
      }
      return {
        scanned: companies.length,
        attempted,
        contactsCreated,
        nextCursor: companies.length === limit ? companies[companies.length - 1].id : null,
      };
    },

    /**
     * 存量决策人邮箱猜测（选项 B · P0.4，阶段⑤b）：对 fit=match+域名 且**有缺邮箱具名决策人**的公司，
     * 自动补全决策人邮箱（EmailGuesser 排列/格式学习 + SMTP RCPT 验证 → persistGuessedEmail 落库）。
     * 复用 guessEmailsForCompany 的底层纯件，与 discoverContactsBacklog 同事务纪律。
     *
     * 🔴 双闸合规门（自动路径**永不** allowPersonalWithoutBasis，红线）：
     *   ① 全局 kill-switch：`email_guess` provider 必须 ENABLED（默认 DISABLED=关，需 ops 显式点）。
     *   ② 已记录 LIA：该 provider 的 `config.lawfulBasis` 有合法记录（basis ∈ LAWFUL_BASIS_KINDS）。
     *   两闸都过才探；未过 → 一个都不探（skipped，零触网）。此 `config.lawfulBasis` 是 **interim 全局**
     *   （对该实例所有租户套同一 LIA，仅适用当前单客户/dev）；per-tenant LIA 采集归收口⑥（设计 doc §2）。
     *
     * 事务纪律：短事务①载入 → **事务外** SMTP 猜测（可数分钟）→ 短事务②落库 → 水位 stamp-all
     * （命中/未命中/DAT-011 跳过都 stamp，30d TTL 防每 sweep 重锤 MX）。每公司缺邮箱决策人经 buildGuessTargets
     * 有界截断（默认 25）→ 单活动有界完成、收尾水位必 stamp（复审 MEDIUM）。
     *
     * 注：`icpId` 仅为与 workflow `{...t}` 调用对称（避免动 proxyActivities 类型）；函数体未用——猜测是公司级。
     */
    async guessEmailsBacklog(args: BacklogPage & { icpId: string }): Promise<GuessEmailsBacklogResult> {
      const limit = args.limit ?? 6;
      const now = new Date();

      // ── 双闸前置（零触网；未过直接 skip，绝不 allowPersonalWithoutBasis）──
      const provider = await deps.ownerDb.dataProvider.findFirst({
        where: { key: EMAIL_GUESS_KEY, status: 'ENABLED' },
        select: { config: true },
      });
      if (!provider) {
        return { scanned: 0, attempted: 0, guessed: 0, skipped: true, reason: 'kill_switch_disabled', nextCursor: null };
      }
      const lawfulBasis = parseConfiguredLawfulBasis(provider.config);
      if (!lawfulBasis) {
        return { scanned: 0, attempted: 0, guessed: 0, skipped: true, reason: 'no_lawful_basis_configured', nextCursor: null };
      }

      const suspended = await suspendedDomains();

      // ── 短事务①载入：首选验证器 + 目标公司 + 缺邮箱决策人 + 同域格式样本 + 禁联 ──
      const loaded = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const verifiers = await deps.providers.routeEmailVerification(tx as never);
        const verifier = verifiers[0];
        if (!verifier) {
          return { verifier: undefined, companyIds: [] as string[], guessCompanies: [] as GuessTargetCompany[], suppressedEmails: new Set<string>() };
        }
        const companies = await tx.canonicalCompany.findMany({
          where: backlogEligibleWhere({
            watermarkField: 'emailGuessAttemptedAt',
            now,
            requireDomain: true,
            requireEmaillessContact: true,
          }),
          orderBy: backlogEligibleOrderBy('emailGuessAttemptedAt'),
          take: limit,
          select: { id: true, domain: true }, // country/dedupeKey/name 未用（猜测走 buildGuessTargets 派生）
        });
        const suppressedEmails = new Set(
          (await tx.suppressionRecord.findMany({ where: { type: 'email' } })).map((s) => s.value.toLowerCase()),
        );
        const contacts = await tx.canonicalContact.findMany({
          where: { companyId: { in: companies.map((c) => c.id) } },
          include: { contactPoints: true },
        });
        const byCompany = new Map<string, typeof contacts>();
        for (const ct of contacts) {
          const arr = byCompany.get(ct.companyId) ?? [];
          arr.push(ct);
          byCompany.set(ct.companyId, arr);
        }
        const guessCompanies: GuessTargetCompany[] = [];
        for (const c of companies) {
          if (!c.domain) continue; // requireDomain 已保证；narrow 到 string
          // 共用纯件：同域非-RISKY 格式样本 + 缺邮箱决策人（默认 cap 25，与手动路径一致，防单活动超时）。
          const { knownSamples, emailless } = buildGuessTargets(byCompany.get(c.id) ?? [], c.domain);
          guessCompanies.push({ id: c.id, domain: c.domain, emailless, knownSamples });
        }
        return { verifier, companyIds: companies.map((c) => c.id), guessCompanies, suppressedEmails };
      });

      if (!loaded.verifier) {
        return { scanned: 0, attempted: 0, guessed: 0, skipped: true, reason: 'no_verifier', nextCursor: null };
      }
      const { verifier, companyIds, guessCompanies, suppressedEmails } = loaded;
      if (!companyIds.length) return { scanned: 0, attempted: 0, guessed: 0, nextCursor: null };

      // ── 事务外：逐公司逐缺邮箱决策人 SMTP 猜测（DAT-011 SUSPENDED 域跳过；单人失败 fail-safe）──
      const guesser = new EmailGuesser(verifier);
      const results: { contactId: string; result: GuessResult }[] = [];
      let attempted = 0;
      for (const gc of guessCompanies) {
        if (suspended.has(gc.domain.toLowerCase())) continue; // DAT-011：SUSPENDED 域连 MX/SMTP 都不探
        for (const t of gc.emailless) {
          attempted += 1;
          try {
            const result = await guesser.guess(
              { fullName: t.fullName, domain: gc.domain, knownSamples: gc.knownSamples },
              {
                workspaceId: args.workspaceId,
                lawfulBasis, // interim 全局 LIA（config 配置）；🔴 自动路径**绝不**传 allowPersonalWithoutBasis
                actor: 'backlog',
                suppressedEmails,
                maxProbe: undefined,
              },
            );
            results.push({ contactId: t.contactId, result });
          } catch {
            /* 单人猜测失败（SMTP 异常等）不影响其余 */
          }
        }
      }

      // ── 短事务②落库：RISKY 无 outreach、suppression 不落、personal_data + lawful_basis 留痕（persistGuessedEmail 保证）──
      let guessed = 0;
      if (results.length) {
        await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          for (const r of results) {
            const out = await persistGuessedEmail(tx, {
              workspaceId: args.workspaceId,
              contactId: r.contactId,
              result: r.result,
              suppressedEmails,
              // 门实际采用（已 stamp）的依据优先；否则退回 config 的 interim 全局 LIA（问责留痕一致）。
              lawfulBasis: r.result.lawfulBasis ?? lawfulBasis,
              now,
            });
            if (out.persisted) guessed += 1;
          }
        });
      }

      // ── 水位 stamp-all（命中/未命中/DAT-011 跳过都 stamp）：30d TTL 防每 sweep 重锤 MX，游标吞噬存量 ──
      await stampProcessed(args.workspaceId, companyIds, { emailGuessAttemptedAt: now });
      return {
        scanned: companyIds.length,
        attempted,
        guessed,
        nextCursor: companyIds.length === limit ? companyIds[companyIds.length - 1] : null,
      };
    },
  };
}

export type BacklogActivities = ReturnType<typeof createBacklogActivities>;
