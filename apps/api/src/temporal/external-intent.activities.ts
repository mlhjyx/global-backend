import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaxonomyResolver } from '../discovery/taxonomy-resolver';
import type { ExecutionBroker } from '../tools/tool-contract';
import { BudgetExceededError, budgetLedger, sweepBudgetCents } from '../tools/budget';
import { resolveIcpToCpv, collectIndustryTerms, splitTerms, PlanQueryShape } from '../discovery/icp-to-cpv';
import { resolveIcpToFda } from '../discovery/icp-to-fda';
import { SignalIngestService, IngestOutcome } from '../signals/signal-ingest.service';
import { canonicalFdaSpec, canonicalTedSpec, queryFingerprint } from '../signals/signal-query';
import { TedIntentProjectionService, ProjectTendersResult } from '../intent/ted-intent-projection.service';
import { OpenFdaIntentProjectionService, ProjectClearancesResult } from '../intent/openfda-intent-projection.service';
import { IntentRecomputeService, ProjectionSurface } from '../signals/intent-recompute.service';

const DEFAULT_MAX_NOTICES = 100; // 单指纹有界样本（绝不 grind 全库）
const DEFAULT_RECOMPUTE_ROUNDS = 25; // 单 workspace 单 sweep 的复算分页轮上限（25×200=5000 家/轮，防单轮无界 grind）
const DEFAULT_MAX_RECORDS = 100;
const TED_PROVIDER = 'ted';
const OPENFDA_PROVIDER = 'openfda';
const SWEEP_BUDGET_KEY = 'sweep:external-intent'; // 平台级 sweep 预算账（收口② reserve-settle）

export interface ExternalIntentTarget {
  workspaceId: string;
  icpId: string;
}

/** ICP → 确定性解析出的查询面（解析与摄取/投影拆层：本身零出网）。 */
export interface ResolvedIntentTarget extends ExternalIntentTarget {
  cpvCodes: string[];
  buyerCountries: string[]; // ISO-3（TED 查询格式；投影端归 alpha-2）
  fdaProductCodes: string[];
  error?: string;
}

export interface IngestSweepSummary {
  tedSpecs: number; // 去重后的唯一 TED 查询指纹数
  fdaSpecs: number;
  fetches: number; // 真实出网拉取尝试次数（含失败；账本命中/未出网不计）
  ledgerHits: number; // ingest-once 命中数（跨 workspace/ICP 共享）
  signalsUpserted: number;
  budgetExceeded: boolean;
  errors: string[];
}

export interface ExternalIntentIcpResult {
  workspaceId: string;
  icpId: string;
  cpvCodes: number;
  fdaProductCodes: number;
  tenders?: ProjectTendersResult;
  clearances?: ProjectClearancesResult;
  error?: string;
}

/** 两 provider 的 live kill-switch 态（`DataProvider.status === 'ENABLED'`）。sweep 摄取后单次重读、thread 给逐 ICP 投影。 */
export interface LiveProviderState {
  ted: boolean;
  openfda: boolean;
}

/** 过期后 intent 复算汇总（可观测；truncated=达轮上限未扫尽的 workspace 数，下轮 sweep 续）。 */
export interface ExternalIntentRecomputeSummary {
  workspacesRecomputed: number;
  companiesRebuilt: number;
  companiesCleared: number;
  truncated: number;
  error?: string;
}

/**
 * **外部源 intent sweep** 的 Temporal 活动（收口⑤重构：ingest-once + 两层投影）。
 * 旧结构「逐 ICP 各自 broker.invoke 直连 TED/openFDA + 直接 upsert」= 同一外部记录被 N 个 ICP×workspace
 * 重复拉取、原始事实不落任何平台表（as-built 缺口#5）。新结构四段：
 *   ① listExternalIntentTargets：ownerDb 跨租户枚举全部 ACTIVE ICP（受信系统扫描器先例，无静默截断）；
 *   ② resolveExternalIntentTarget：逐 ICP **确定性**解析 CPV/FDA 码（allowLlm:false，零出网零 LLM 成本）；
 *   ③ ingestExternalSignals：按 (provider, queryFingerprint, windowKey) **全局去重后拉取一次** →
 *      source_signal 平台表（零个人数据）；预算 `sweep:external-intent` 开账，BudgetExceeded 停拉不停投影；
 *   ④ projectExternalIntentForIcp：逐 ICP 从 source_signal **只读投影**进本租户 canonical（withWorkspace RLS）。
 * kill-switch：③ 每指纹拉取前 live 重读 data_provider；④ 投影用 workflow 摄取后**单次** liveProviderState 重读的
 *   live 快照门控（中途 ops 关停本轮即生效；快照缺省则活动自读兜底=防御纵深——Codex #56 P1 + fast-follow 单次读优化）；
 *   ② 解析零出网只受捕获标志门。SUSPENDED=停采不停用不入投影（architecture §5）。
 */
export function createExternalIntentActivities(deps: {
  prisma: PrismaService;
  taxonomy: TaxonomyResolver;
  ownerDb?: PrismaClient;
  broker?: ExecutionBroker;
}) {
  const ingestSvc = new SignalIngestService({ prisma: deps.prisma, broker: deps.broker });
  const tedProj = new TedIntentProjectionService({ prisma: deps.prisma });
  const openfdaProj = new OpenFdaIntentProjectionService({ prisma: deps.prisma });
  const recomputeSvc = new IntentRecomputeService({ prisma: deps.prisma });

  /** live kill-switch：拉取前重读 data_provider 状态（ownerDb 只读；缺失 → 全停）。 */
  async function liveEnabled(): Promise<LiveProviderState> {
    if (!deps.ownerDb) return { ted: false, openfda: false };
    const rows = await deps.ownerDb.dataProvider.findMany({
      where: { key: { in: [TED_PROVIDER, OPENFDA_PROVIDER] } },
      select: { key: true, status: true },
    });
    return {
      ted: rows.some((p) => p.key === TED_PROVIDER && p.status === 'ENABLED'),
      openfda: rows.some((p) => p.key === OPENFDA_PROVIDER && p.status === 'ENABLED'),
    };
  }

  return {
    /**
     * 枚举待投影目标（全部 ACTIVE ICP）+ 两 provider 的 data_provider kill-switch 状态（ops 一键停）。
     * ownerDb 缺失（未注入）→ 空，不跑（不误当全启用）。
     */
    async listExternalIntentTargets(args?: { limit?: number }): Promise<{
      targets: ExternalIntentTarget[];
      tedEnabled: boolean;
      openfdaEnabled: boolean;
    }> {
      if (!deps.ownerDb) return { targets: [], tedEnabled: false, openfdaEnabled: false };
      const live = await liveEnabled();
      if (!live.ted && !live.openfda) return { targets: [], tedEnabled: live.ted, openfdaEnabled: live.openfda }; // 全停 → 不枚举

      // **无静默截断**：默认枚举全部 ACTIVE ICP（loop 收口要求每个 ICP 最终都被投影）。给了 arbitrary
      // take 上限 + orderBy updatedAt desc 会**永久饿死**旧 ICP（同 backlog id>cursor 防活锁的教训）。
      // `limit` 仅供单测/有界跑；生产 schedule 不传 → 全量。超大规模再上 lastSweptAt 水位列增量。
      const icps = await deps.ownerDb.icpDefinition.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, workspaceId: true },
        orderBy: { id: 'asc' }, // 稳定序（非 updatedAt，避免"最近编辑优先"倾斜）
        ...(args?.limit ? { take: args.limit } : {}),
      });
      return { targets: icps.map((i) => ({ workspaceId: i.workspaceId, icpId: i.id })), tedEnabled: live.ted, openfdaEnabled: live.openfda };
    },

    /**
     * ICP → 确定性解析 CPV/FDA 码（零出网零 LLM：allowLlm:false，调度里不臆造码、可复现）。
     * 稀疏 companyAttributes 兜底：复用 ICP 已存 discovery 查询计划的 filters.industry 补 industry 词。
     */
    async resolveExternalIntentTarget(args: ExternalIntentTarget): Promise<ResolvedIntentTarget> {
      const out: ResolvedIntentTarget = { ...args, cpvCodes: [], buyerCountries: [], fdaProductCodes: [] };
      if (!deps.ownerDb) return out;

      const icp = await deps.ownerDb.icpDefinition.findUnique({
        where: { id: args.icpId },
        select: { companyAttributes: true, targetMarkets: true },
      });
      if (!icp) return out;

      const plan = await deps.ownerDb.discoveryQueryPlan.findFirst({
        where: { icpId: args.icpId },
        orderBy: { updatedAt: 'desc' },
        select: { queries: true },
      });
      const planned = (Array.isArray(plan?.queries) ? plan!.queries : []) as unknown as PlanQueryShape[];

      const attrs = (icp.companyAttributes ?? {}) as Record<string, unknown>;
      const industryTerms = collectIndustryTerms(icp.companyAttributes, planned);
      const targetCountries = splitTerms(icp.targetMarkets);
      const product = attrs.product ? String(attrs.product) : undefined;
      const tradeSide = attrs.trade_side ? String(attrs.trade_side) : undefined;

      try {
        const cpv = await resolveIcpToCpv(
          deps.taxonomy,
          { industryTerms, product, targetCountries },
          { allowLlm: false, workspaceId: args.workspaceId },
        );
        out.cpvCodes = cpv.cpvCodes;
        out.buyerCountries = cpv.buyerCountries;
      } catch (err) {
        out.error = `cpv: ${String(err).slice(0, 120)}`;
      }
      try {
        const fda = await resolveIcpToFda(
          deps.taxonomy,
          { industryTerms, product, tradeSide, targetCountries },
          { allowLlm: false, workspaceId: args.workspaceId },
        );
        out.fdaProductCodes = fda.productCodes;
      } catch (err) {
        out.error = `${out.error ? out.error + '; ' : ''}fda: ${String(err).slice(0, 120)}`;
      }
      return out;
    },

    /**
     * 平台层摄取（ingest-once 核心）：全部 ICP 的查询面按指纹**全局去重**，每唯一 (provider, 指纹, 时间窗)
     * 只拉一次 → source_signal。预算：`sweep:external-intent` 开账（sweepBudgetCents 上界），
     * BudgetExceededError → 停止后续拉取（已落库的信号仍供投影），**显性上报不静默**。
     */
    async ingestExternalSignals(args: {
      targets: ResolvedIntentTarget[];
      tedEnabled: boolean;
      openfdaEnabled: boolean;
      maxNotices?: number;
      maxRecords?: number;
    }): Promise<IngestSweepSummary> {
      const summary: IngestSweepSummary = {
        tedSpecs: 0, fdaSpecs: 0, fetches: 0, ledgerHits: 0, signalsUpserted: 0, budgetExceeded: false, errors: [],
      };

      // 指纹级全局去重：两个 workspace 的同参 ICP → 同一指纹 → 一次拉取（收口⑤验收）。
      const tedByFp = new Map<string, { cpvCodes: string[]; buyerCountries: string[]; maxRecords?: number }>();
      const fdaByFp = new Map<string, { productCodes: string[]; maxRecords?: number }>();
      for (const t of args.targets) {
        if (args.tedEnabled && t.cpvCodes.length && t.buyerCountries.length) {
          // 需 CPV **且**有覆盖买方国别（空国别会令查询省略国别子句 → 拉全 EU，绝不裸拉）。
          const params = { cpvCodes: t.cpvCodes, buyerCountries: t.buyerCountries, maxRecords: args.maxNotices ?? DEFAULT_MAX_NOTICES };
          tedByFp.set(queryFingerprint(canonicalTedSpec(params)), params);
        }
        if (args.openfdaEnabled && t.fdaProductCodes.length) {
          const params = { productCodes: t.fdaProductCodes, maxRecords: args.maxRecords ?? DEFAULT_MAX_RECORDS };
          fdaByFp.set(queryFingerprint(canonicalFdaSpec(params)), params);
        }
      }
      summary.tedSpecs = tedByFp.size;
      summary.fdaSpecs = fdaByFp.size;
      if (!tedByFp.size && !fdaByFp.size) return summary;

      budgetLedger.open(SWEEP_BUDGET_KEY, sweepBudgetCents());
      try {
        const runOne = async (fetch: () => Promise<IngestOutcome>): Promise<boolean> => {
          try {
            const r = await fetch();
            // fetches=真实出网尝试次数（含失败——外部配额审计口径；复审 LOW）；未出网的
            // broker_unavailable/empty_query 不计；ledgerHit 命中不出网只计 ledgerHits。
            if (r.ledgerHit) summary.ledgerHits += 1;
            else if (r.error !== 'broker_unavailable' && r.error !== 'empty_query') summary.fetches += 1;
            if (r.error) summary.errors.push(`${r.provider}: ${r.error}`);
            summary.signalsUpserted += r.signalsUpserted; // ledgerHit 归 0（本轮真实落库数，不跨窗双计）
            return true;
          } catch (err) {
            if (err instanceof BudgetExceededError) {
              summary.budgetExceeded = true; // 显性截断：预算打穿即停拉（绝不静默假完成）
              summary.errors.push('budget_exceeded');
              return false;
            }
            summary.errors.push(String(err).slice(0, 150));
            return true; // 单指纹失败 fail-safe 不阻断其余
          }
        };

        for (const params of tedByFp.values()) {
          const live = await liveEnabled(); // 每指纹 live 重读：中途 ops 关停本轮即生效
          if (!live.ted) break;
          if (!(await runOne(() => ingestSvc.ingestTed(params, { budgetKey: SWEEP_BUDGET_KEY })))) return summary;
        }
        for (const params of fdaByFp.values()) {
          const live = await liveEnabled();
          if (!live.openfda) break;
          if (!(await runOne(() => ingestSvc.ingestFda(params, { budgetKey: SWEEP_BUDGET_KEY })))) return summary;
        }
        return summary;
      } finally {
        budgetLedger.close(SWEEP_BUDGET_KEY);
      }
    },

    /** 状态机 sweep：ACTIVE 且过期 → EXPIRED（投影前跑，过期信号绝不再投）。 */
    async expireStaleSignals(): Promise<{ expired: number }> {
      return { expired: await ingestSvc.expireStale() };
    },

    /**
     * 过期后 intent **复算收敛**（Codex #56 P2）：`expireStaleSignals` 把过期信号翻 EXPIRED 后，增量投影只**加**
     * 事件、绝不删——已写进 `canonical.attributes.intent` 的过期事件仍被评分（评分读租户属性而非 source_signal）
     * 直到自然衰减。故本活动从事实源（ACTIVE source_signal + web_watch）**确定性重建**受影响 workspace 的
     * intent 投影（`IntentRecomputeService`：无匹配事件 → 清除，全过期即收敛）。
     * 投影面 = 本 workspace 全部 ICP 的 surfaces 之并（`resolved` 逐 ICP 的 cpv/国别/FDA 码）——**必须与增量
     * 投影同一过滤面**，否则跨 CPV/跨 ICP 他源信号会被误注入（见 IntentRecomputeService 头注）。
     * 有界：单 workspace 分页复算至多 DEFAULT_RECOMPUTE_ROUNDS 轮（防单轮 grind 全量）；触顶记 truncated，下轮 sweep 续。
     * 幂等：重建结果与既有实质相同 → 不写（与增量投影有公共不动点）。
     */
    async recomputeExpiredIntent(args: {
      targets: ResolvedIntentTarget[];
      maxRounds?: number;
    }): Promise<ExternalIntentRecomputeSummary> {
      const out: ExternalIntentRecomputeSummary = { workspacesRecomputed: 0, companiesRebuilt: 0, companiesCleared: 0, truncated: 0 };
      // 逐 workspace 聚合投影面（同 workspace 多 ICP → surfaces 之并）。
      // 🔴 解析失败（t.error）的 ICP **绝不**贡献投影面：其空码是"投影面未知"而非"真无 TED/FDA 面"——
      // 若据此以空面复算，recomputeCompany 会把该 workspace 里 TED/FDA-derived 的 intent 当"无匹配事件"清除
      // （一次瞬时解析抖动即抹掉整租户 Intent 维，下轮才自愈）。跳过 → 保留既有 intent 不动（复审 HIGH）。
      const byWs = new Map<string, ProjectionSurface[]>();
      for (const t of args.targets) {
        if (t.error) continue; // 解析失败/不完整：投影面未知，不参与复算（不据空面误清）
        const surfaces = byWs.get(t.workspaceId) ?? [];
        if (t.cpvCodes.length && t.buyerCountries.length) surfaces.push({ provider: 'ted', cpvCodes: t.cpvCodes, buyerCountries: t.buyerCountries });
        if (t.fdaProductCodes.length) surfaces.push({ provider: 'openfda', productCodes: t.fdaProductCodes });
        byWs.set(t.workspaceId, surfaces);
      }
      const maxRounds = Math.max(1, args.maxRounds ?? DEFAULT_RECOMPUTE_ROUNDS);
      for (const [workspaceId, surfaces] of byWs) {
        // 空聚合面（本 workspace 全部 ICP 都无 CPV/FDA 面）→ 跳过：本 sweep 无 TED/FDA 收敛面可算，
        // 绝不以空面调 recomputeWorkspace（否则同样把 TED/FDA intent 误清）。web_watch 收敛归其自身 sweep。
        if (!surfaces.length) continue;
        out.workspacesRecomputed += 1;
        let cursor: string | undefined;
        let rounds = 0;
        for (; rounds < maxRounds; rounds += 1) {
          const r = await recomputeSvc.recomputeWorkspace(workspaceId, { surfaces, cursor });
          out.companiesRebuilt += r.companiesRebuilt;
          out.companiesCleared += r.companiesCleared;
          if (!r.nextCursor) break;
          cursor = r.nextCursor;
        }
        if (rounds >= maxRounds) out.truncated += 1; // 未扫尽（下轮 sweep 从头续；幂等，无副作用）
      }
      return out;
    },

    /**
     * live kill-switch 快照（fast-follow 单次读优化）：workflow 摄取后调**一次**，把结果 thread 给逐 ICP
     * `projectExternalIntentForIcp`——把「每 ICP 一次 owner-DB 读」降到「每 sweep 一次」。取的是**投影阶段开始前一刻**
     * 的 live 态（摄取全程若 ops 关停即反映）；投影仍逐 ICP AND 各自捕获标志。缺省不注入时投影自读兜底（防御纵深）。
     */
    async liveProviderState(): Promise<LiveProviderState> {
      return liveEnabled();
    },

    /**
     * 对一个 ICP 从 source_signal **只读投影**（零出网）：TED 招标 + openFDA 清关 → 本租户 canonical。
     * 各 provider 独立 enabled 门；单 provider 投影失败 fail-safe 不阻断另一个。
     */
    async projectExternalIntentForIcp(args: ResolvedIntentTarget & {
      tedEnabled: boolean;
      openfdaEnabled: boolean;
      /** workflow 摄取后单次 liveProviderState 重读的 live 快照；缺省则本活动自读 data_provider（防御纵深）。 */
      live?: LiveProviderState;
    }): Promise<ExternalIntentIcpResult> {
      const out: ExternalIntentIcpResult = {
        workspaceId: args.workspaceId, icpId: args.icpId,
        cpvCodes: args.cpvCodes.length, fdaProductCodes: args.fdaProductCodes.length,
        ...(args.error ? { error: args.error } : {}),
      };

      // 投影前 **live 门控 DataProvider kill-switch**（Codex #56 P1 收口 + fast-follow 单次读优化）：
      // tedEnabled/openfdaEnabled 是 sweep 头部 listExternalIntentTargets 捕获的、可能已过时的标志——provider 被
      // ops 中途置 DISABLED（schema DataProvider.status = Kill Switch 执行点）时，若只信捕获门会把缓存 source_signal
      // 投进本租户 canonical 造新线索。故用 live 态 AND 捕获标志：**优先用 workflow 摄取后单次 liveProviderState 重读
      // 的 `args.live` 快照**（省每-ICP owner-DB 读）；未注入时自读 liveEnabled() 兜底（直连调用者=测试/verify/未来
      // 调用不被信任，防御纵深）。provider 中途下线本轮即不投影——kill-switch 成为**非破坏性「停一切新活动」**闸。
      //   ⚠️ 刻意**不**在此加 source_policy SUSPENDED 门：SUSPENDED=**停采不停用**（egress-only，见 architecture
      //   §5 两级撤停语义）——停「用」存量信号的正解是 revokeByProvider（翻 REVOKED，投影已按 status='ACTIVE' 剔除）。
      const live = args.live ?? (await liveEnabled());
      const tedOn = args.tedEnabled && live.ted;
      const openfdaOn = args.openfdaEnabled && live.openfda;

      if (tedOn && args.cpvCodes.length && args.buyerCountries.length) {
        try {
          out.tenders = await tedProj.projectTenders(args.workspaceId, {
            cpvCodes: args.cpvCodes,
            buyerCountries: args.buyerCountries,
          });
        } catch (err) {
          out.error = `${out.error ? out.error + '; ' : ''}ted: ${String(err).slice(0, 120)}`;
        }
      }

      if (openfdaOn && args.fdaProductCodes.length) {
        try {
          out.clearances = await openfdaProj.projectClearances(args.workspaceId, {
            productCodes: args.fdaProductCodes,
          });
        } catch (err) {
          out.error = `${out.error ? out.error + '; ' : ''}openfda: ${String(err).slice(0, 120)}`;
        }
      }
      return out;
    },
  };
}

export type ExternalIntentActivities = ReturnType<typeof createExternalIntentActivities>;
