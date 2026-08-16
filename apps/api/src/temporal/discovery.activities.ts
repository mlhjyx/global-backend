import { Prisma, type PrismaClient } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ModelGateway } from "../model-gateway/model-gateway";
import { DiscoveryProviderRegistry } from "../discovery/provider.registry";
import {
  IdentityGroupLeadConflictError,
  findIdentityGroupLeadsForIcp,
  judgeFitCompany,
  loadIcpBrief,
  upsertLeadFit,
} from "../discovery/fit-judge";
import type { RuntimeTelemetry } from "../model-runtime/types";
import {
  CompanyDiscoveryAdapter,
  CompanyDiscoveryQuery,
  DiscoveryOptions,
  DiscoveryResult,
  EnrichmentResult,
  ExecutionContext,
  ProviderCallUsage,
  ProviderCallUsageBreakdown,
  SourceClass,
} from "../discovery/provider-contract";
import { companyIdentity } from "../discovery/identity";
import { resolveEvidenceLicense } from "../discovery/evidence-license";
import { TaxonomyResolver } from "../discovery/taxonomy-resolver";
import { IntentProjectionService } from "../intent/intent-projection.service";
import {
  enqueuePatentLookup,
  PATENT_PROVIDER_KEY,
} from "../adapters/patent-inventor-cache";
import {
  BudgetExceededError,
  budgetLedger,
  runBudgetCents,
} from "../tools/budget";
import type { ExecutionBroker } from "../tools/tool-contract";
import { loadMaterializableCompanyState } from "../discovery/company-suppression-gate";
import {
  organizationMayUseExternalProcessing as companyMayUseExternalProcessing,
  loadOrganizationIdentitySnapshot,
  loadOrganizationIdentitySnapshots,
  resolveOrganizationIdentityGroups,
  resolveOrganizationRootIds,
} from "../discovery/organization-identity-root";
import { lockWorkspaceSuppressionPolicy } from "../discovery/suppression-policy-lock";
import { commitCompanyEnrichmentResults } from "../discovery/company-enrichment-commit";
import { resolveOrganizationIdentityForRaw } from "../discovery/organization-identity-resolver";
import {
  ProviderIdentityQualityTracker,
  type ProviderIdentityQuality,
} from "../discovery/provider-identity-quality";
import {
  prepareRawSourceBatch,
  rawDriftIngestKey,
  rawSourceIngestLimits,
  reconcileRawSourceBatch,
  type RawSourceIngestLimits,
  type RawSourcePolicySnapshot,
} from "../discovery/raw-source-ingestion";
import { DIGITAL_FOOTPRINT_PARSER_VERSION } from "../discovery/providers/digital-footprint.provider";
import { WIKIDATA_ENRICH_PARSER_VERSION } from "../discovery/providers/wikidata-enrich.provider";
import { persistProviderQualityContributions } from "../discovery/provider-quality-ledger";
import { commitNppesLifecycleFact } from "../discovery/nppes-lifecycle";
import { partitionGovernedRawRecords } from "../discovery/raw-source-governance";
import {
  loadSecEdgarDirectoryBinding,
  persistSecEdgarSubmissionObservation,
} from "../discovery/sec-edgar-submission-observation";

export interface DiscoveryRunInput {
  workspaceId: string;
  runId: string;
  planId: string;
  icpId: string;
}

export interface PlanQuery {
  source_class: string;
  filters: Record<string, unknown>;
  keywords: string[];
  priority: number;
  /** 单查询 Provider 候选上限；运行时仍强制收敛到 1..PER_SOURCE_LIMIT。 */
  limit?: number;
}

const EXPLICIT_ONLY_PROVIDER_KEYS = new Set([
  'ror',
  'sec_edgar',
  'mexico_denue',
  'fmcsa_qcmobile',
  'eu_ecolabel',
  'sbir_sttr_companies',
  'koneps',
]);

/**
 * Provider-level execution facts for one query attempt. These counters are
 * deliberately additive so the workflow can aggregate repeated queries
 * without losing zero-result or failed providers.
 */
export interface ProviderExecutionStats {
  attemptedCount: number;
  successCount: number;
  zeroResultCount: number;
  failureCount: number;
  /** Raw rows accepted by the ingestion gate (not the provider response size). */
  rawCount: number;
  quarantinedCount: number;
  rejectedCount: number;
  duplicateCount: number;
}

function emptyProviderExecutionStats(): ProviderExecutionStats {
  return {
    attemptedCount: 0,
    successCount: 0,
    zeroResultCount: 0,
    failureCount: 0,
    rawCount: 0,
    quarantinedCount: 0,
    rejectedCount: 0,
    duplicateCount: 0,
  };
}

const PER_SOURCE_LIMIT = 25; // sandbox 阶段每源上限；真源接入后由预算/配额驱动（PRD 7.4.8）
const MAX_PROVIDER_PAGES = 3;
const ENRICH_LIMIT = 50; // 单 run 富集上限（护栏；GLEIF 限流）
const FIT_EVIDENCE_ENRICH_LIMIT = 5; // 官网取证较慢；资格门前只做小批量、零模型成本的事实补齐
const SIGNAL_ENRICH_LIMIT = 12; // 信号富集慢（抓官网/sitemap），单 run 上限更小；配长活动 + heartbeat
const SIGNAL_TTL_MS = 7 * 24 * 3600 * 1000; // 信号时变 → 7 天 TTL 刷新（非 GLEIF/Wikidata 那种一次写死）
const WATCH_REGISTER_LIMIT = 12; // 单 run 自动注册网站监控上限（每家一次 sitemap 探测，慢）
const PATENT_ENQUEUE_LIMIT = 500; // 单 run 专利缓存预热 enqueue 上限（cheap upsert，非慢活动；超出记 log）

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new Error(`unsupported JSON value: ${typeof value}`);
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function hasStructuredProducts(value: unknown): boolean {
  const products = recordValue(value)?.structured_products;
  return Array.isArray(products) && products.length > 0;
}

function hasCurrentFitEvidenceVersion(value: unknown): boolean {
  return (
    recordValue(value)?.fit_evidence_version ===
    DIGITAL_FOOTPRINT_PARSER_VERSION
  );
}

function hasCurrentWikidataIdentityVersion(value: unknown): boolean {
  return (
    recordValue(value)?.identity_evidence_version ===
    WIKIDATA_ENRICH_PARSER_VERSION
  );
}

function boundedPerSourceLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    return PER_SOURCE_LIMIT;
  return Math.max(1, Math.min(value, PER_SOURCE_LIMIT));
}

type BoundedProviderDiscovery = {
  key: string;
  r: DiscoveryResult;
  paginationFailed: boolean;
  paginationTruncated: boolean;
};

function mergeProviderUsage(
  current: ProviderCallUsage | undefined,
  next: ProviderCallUsage | undefined,
): ProviderCallUsage | undefined {
  if (!next) return current;
  const aggregate = new Map<string, ProviderCallUsageBreakdown>();
  for (const entry of [...(current?.breakdown ?? []), ...next.breakdown]) {
    const key = `${entry.phase}\0${entry.backend}`;
    const existing = aggregate.get(key);
    if (existing) {
      existing.callCount += entry.callCount;
      existing.completedCount += entry.completedCount;
      existing.costCents += entry.costCents;
    } else {
      aggregate.set(key, { ...entry });
    }
  }
  const breakdown = [...aggregate.values()];
  return {
    callCount: breakdown.reduce((sum, entry) => sum + entry.callCount, 0),
    breakdown,
  };
}

async function discoverProviderPages(args: {
  adapter: CompanyDiscoveryAdapter;
  query: CompanyDiscoveryQuery;
  ctx: ExecutionContext;
  options: DiscoveryOptions;
}): Promise<BoundedProviderDiscovery> {
  const records = new Map<string, DiscoveryResult["records"][number]>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let costCents = 0;
  let usage: ProviderCallUsage | undefined;
  let paginationFailed = false;
  let paginationTruncated = false;

  for (
    let page = 0;
    page < MAX_PROVIDER_PAGES && records.size < args.query.limit;
    page += 1
  ) {
    const remaining = args.query.limit - records.size;
    let result: DiscoveryResult;
    try {
      result = await args.adapter.discoverCompanies(
        { ...args.query, limit: remaining },
        args.ctx,
        { ...args.options, cursor },
      );
    } catch (error) {
      if (page === 0) throw error;
      paginationFailed = true;
      paginationTruncated = true;
      break;
    }
    costCents += result.costCents;
    usage = mergeProviderUsage(usage, result.usage);
    for (const record of result.records) {
      if (records.size >= args.query.limit) break;
      if (!records.has(record.externalId))
        records.set(record.externalId, record);
    }
    if (!result.nextCursor || records.size >= args.query.limit) break;
    if (
      result.nextCursor.length > 2_048 ||
      result.nextCursor.includes("\0") ||
      seenCursors.has(result.nextCursor)
    ) {
      paginationFailed = true;
      paginationTruncated = true;
      break;
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
    if (page === MAX_PROVIDER_PAGES - 1) paginationTruncated = true;
  }

  return {
    key: args.adapter.key,
    r: {
      records: [...records.values()],
      costCents,
      ...(usage ? { usage } : {}),
    },
    paginationFailed,
    paginationTruncated,
  };
}

/**
 * Discover 阶段活动（PRD 5.5 / 8.7 流水线）：
 * 计划 → Provider 调用 → Raw Zone 原样落地 → 归一 + 身份解析 → Canonical +
 * FieldEvidence + IdentityLink → Suppression 标记 → 成本入账。
 */
export function createDiscoveryActivities(deps: {
  prisma: PrismaService;
  providers: DiscoveryProviderRegistry;
  gateway: ModelGateway;
  taxonomy?: TaxonomyResolver;
  /** IntentProjectionService 的 sitemap 探测出网经此闸门（收口②）。 */
  broker?: ExecutionBroker;
  runtimeTelemetry?: RuntimeTelemetry;
  rawIngestLimits?: RawSourceIngestLimits;
  now?: () => Date;
  /** Owner read is restricted to selecting workspaces with due retention rows. */
  ownerDb?: PrismaClient;
}) {
  // 收口② D「真开账」：每个活动入口幂等 open（open 取较大值，重复无害；账本进程内，
  // 活动重试/换 worker 也能重新立账）。run 结束由 finalizeRun close。
  const ensureRunBudget = (runId: string): void =>
    budgetLedger.open(runId, runBudgetCents());
  const authorizeCompanyExternalAction =
    (workspaceId: string, companyId: string): (() => Promise<boolean>) =>
    () =>
      deps.prisma.withWorkspace(workspaceId, (tx) =>
        companyMayUseExternalProcessing(tx, workspaceId, companyId),
      );

  return {
    /**
     * run 起始清账：强制关闭本 runId 可能残留的预算账户（含 wasExhausted 打标）。用于同 runId 的**重试**：
     * 上次 attempt 若在 finalizeRun 前崩溃，进程内账户与打穿标记会残留（budgetLedger 无 GC），
     * 令重试的首个 executeQuery 误报 budgetTruncated。workflow 起始调一次即从干净状态起（单 worker 前提下）。
     *
     * 权衡（对抗复审 MEDIUM）：重试因此拿到**全新 cap**，不继承崩溃 attempt 已发生的 settledCents ——
     * 极端下同 runId 跨 attempt 实际花费可达 ~2×cap（cap 目前是宽松占位值，可接受）。反面（保留残留账户）
     * 更糟：残留的打穿标记会令**每次**重试都被永久误判截断、run 永不成功。真正的跨 attempt 成本对账需
     * 待预算基建换持久化后端（budget.ts 顶注已记档），非本进程内实现能力范围。
     */
    async resetRunBudget(args: { runId: string }): Promise<void> {
      budgetLedger.close(args.runId, { force: true });
    },

    /**
     * Replace expired v2 payloads with a bounded audit receipt. Open identity
     * conflicts defer expiry so reviewers retain the facts needed for a decision.
     */
    async expireRawSourceRecords(args: {
      workspaceId: string;
      limit?: number;
    }): Promise<{ expired: number; deferredForConflict: number }> {
      const now = deps.now?.() ?? new Date();
      const limit = Math.max(1, Math.min(args.limit ?? 200, 500));
      return deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const due: Prisma.RawSourceRecordWhereInput = {
          ingestVersion: "raw-source/v2",
          ingestStatus: { in: ["ACCEPTED", "QUARANTINED", "REJECTED"] },
          expiresAt: { lte: now },
        };
        const [rows, deferredForConflict] = await Promise.all([
          tx.rawSourceRecord.findMany({
            where: {
              ...due,
              identityConflicts: {
                none: { status: { in: ["OPEN", "RESOLVING"] } },
              },
            },
            select: {
              id: true,
              ingestStatus: true,
              payloadHash: true,
              payloadBytes: true,
            },
            orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
            take: limit,
          }),
          tx.rawSourceRecord.count({
            where: {
              ...due,
              identityConflicts: {
                some: { status: { in: ["OPEN", "RESOLVING"] } },
              },
            },
          }),
        ]);
        let expired = 0;
        for (const row of rows) {
          const updated = await tx.rawSourceRecord.updateMany({
            where: { id: row.id, ingestStatus: row.ingestStatus },
            data: {
              ingestStatus: "EXPIRED",
              expiredAt: now,
              payload: {
                _rawReceipt: "raw-source/expired-v1",
                previousStatus: row.ingestStatus,
                payloadHash: row.payloadHash,
                payloadBytes: row.payloadBytes,
              },
            },
          });
          expired += updated.count;
        }
        return { expired, deferredForConflict };
      });
    },

    /** Platform schedule admission: owner reads tenant ids only; payload mutation remains RLS-scoped. */
    async listRawRetentionWorkspaces(args?: {
      limit?: number;
      afterWorkspaceId?: string;
    }): Promise<{
      workspaceIds: string[];
      nextCursor: string | null;
    }> {
      if (!deps.ownerDb) throw new Error("RAW_RETENTION_OWNER_DB_UNAVAILABLE");
      const now = deps.now?.() ?? new Date();
      const limit = Math.max(1, Math.min(args?.limit ?? 100, 500));
      const rows = await deps.ownerDb.rawSourceRecord.findMany({
        where: {
          ...(args?.afterWorkspaceId
            ? { workspaceId: { gt: args.afterWorkspaceId } }
            : {}),
          ingestVersion: "raw-source/v2",
          ingestStatus: { in: ["ACCEPTED", "QUARANTINED", "REJECTED"] },
          expiresAt: { lte: now },
        },
        select: { workspaceId: true },
        distinct: ["workspaceId"],
        orderBy: { workspaceId: "asc" },
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      return {
        workspaceIds: page.map((row) => row.workspaceId),
        nextCursor:
          rows.length > limit ? (page.at(-1)?.workspaceId ?? null) : null,
      };
    },

    async loadPlanQueries(args: {
      workspaceId: string;
      planId: string;
    }): Promise<{ queries: PlanQuery[] }> {
      return deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const plan = await tx.discoveryQueryPlan.findUnique({
          where: { id: args.planId },
        });
        if (!plan) throw new Error(`query plan ${args.planId} not found`);
        if (!["READY", "EXECUTED"].includes(plan.status)) {
          throw new Error(
            `query plan is ${plan.status}; must be READY (human-confirmed) before execution`,
          );
        }
        const queries = (plan.queries as unknown as PlanQuery[]) ?? [];
        return {
          queries: [...queries].sort(
            (a, b) => (a.priority ?? 99) - (b.priority ?? 99),
          ),
        };
      });
    },

    /**
     * Waterfall 步骤 3：fan-out 调用该 source_class 下全部 ENABLED 发现源（source_hint 可收窄），
     * raw 原样落地（幂等 by externalId）。
     * 网络调用（搜索/爬取/LLM）在事务外完成，结果才进事务持久化——避免长事务。
     */
    async executeQuery(args: {
      workspaceId: string;
      runId: string;
      query: PlanQuery;
    }): Promise<{
      rawCount: number;
      quarantinedCount: number;
      rejectedCount: number;
      duplicateCount: number;
      costCents: number;
      provider: string | null;
      failedProviderCount: number;
      budgetTruncated: boolean;
      paginationTruncated: boolean;
      perProvider: Record<string, ProviderExecutionStats>;
    }> {
      // 词表归一（冷路径，docs/backend/vocab-taxonomy.md）：把 filters 里的行业/国家
      // 自由词（中/英/德）归一到规范节点，注入 resolved 码供各源精确路由。
      // 未接 resolver 或未命中时，provider 回退到内置 vocab.ts。
      const enriched: Record<string, unknown> = {
        ...(args.query.filters ?? {}),
      };
      if (deps.taxonomy) {
        const industryTerms = [enriched.industry, enriched.sub_industry]
          .flat()
          .filter(Boolean)
          .map(String);
        const countryTerms = [enriched.country, enriched.region]
          .flat()
          .filter(Boolean)
          .map(String);
        const inds = await deps.taxonomy.resolveMany(
          "industry",
          industryTerms,
          { workspaceId: args.workspaceId },
        );
        if (inds.length) {
          enriched._industryQids = inds
            .map((n) => n.wikidataQid)
            .filter(Boolean);
          enriched._osmTags = inds.flatMap((n) => n.osmTags ?? []);
          enriched._industryCodes = inds.map((n) => n.code);
        }
        for (const ct of countryTerms) {
          const c = await deps.taxonomy.resolve("country", ct, {
            workspaceId: args.workspaceId,
          });
          if (c?.wikidataQid) {
            enriched._countryQid = c.wikidataQid;
            enriched._countryCode = c.code;
            break;
          }
        }
      }
      const q: CompanyDiscoveryQuery = {
        sourceClass: args.query.source_class as SourceClass,
        filters: enriched,
        keywords: args.query.keywords ?? [],
        limit: boundedPerSourceLimit(args.query.limit),
      };
      // Source Registry（DAT-011）：SUSPENDED 的域名列入黑名单，适配器抓取前跳过。
      // source_policy 是无 RLS 的平台治理表（app_user 有 SELECT）→ 直接读。
      const sourcePolicies = await deps.prisma.sourcePolicy.findMany({
        select: {
          id: true,
          domain: true,
          retentionDays: true,
          reviewStatus: true,
          updatedAt: true,
        },
      });
      // 多源 fan-out：该 source_class 下**全部 ENABLED 适配器**并行召回（蓝图集成点 1）。
      // source_hint 必须是非空字符串并做精确匹配；显式点名型来源不得进入默认 fan-out。
      const rawHint = args.query.filters?.source_hint;
      if (
        rawHint !== undefined &&
        (typeof rawHint !== "string" || rawHint.trim().length === 0)
      ) {
        throw new Error("DISCOVERY_SOURCE_HINT_INVALID");
      }
      const hint =
        typeof rawHint === "string" ? rawHint.trim().toLowerCase() : undefined;
      let adapters = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        deps.providers.routeCompanyDiscovery(tx as never, q.sourceClass),
      );
      if (hint) adapters = adapters.filter((a) => a.key === hint);
      else adapters = adapters.filter((a) => !EXPLICIT_ONLY_PROVIDER_KEYS.has(a.key));
      // An explicit provider request that cannot route (disabled/unregistered/wrong class)
      // is a failed source attempt, never a successful empty result.
      if (!adapters.length && hint)
        return {
          rawCount: 0,
          quarantinedCount: 0,
          rejectedCount: 0,
          duplicateCount: 0,
          costCents: 0,
          provider: hint,
          failedProviderCount: 1,
          budgetTruncated: false,
          paginationTruncated: false,
          perProvider: {
            [hint]: {
              attemptedCount: 1,
              successCount: 0,
              failureCount: 1,
              zeroResultCount: 0,
              rawCount: 0,
              quarantinedCount: 0,
              rejectedCount: 0,
              duplicateCount: 0,
            },
          },
        };
      if (!adapters.length)
        return {
          rawCount: 0,
          quarantinedCount: 0,
          rejectedCount: 0,
          duplicateCount: 0,
          costCents: 0,
          provider: null,
          failedProviderCount: 0,
          budgetTruncated: false,
          paginationTruncated: false,
          perProvider: {},
        };

      // ── 事务外：各源真实发现（可能耗时数十秒），单源失败不影响其余 ──
      // 收口②：ExecutionContext 贯穿到 provider——LLM/工具出网按真租户/run 归属（灭伪 workspace）。
      ensureRunBudget(args.runId);
      const ctx: ExecutionContext = {
        workspaceId: args.workspaceId,
        runId: args.runId,
        correlationId: args.runId,
      };
      const blockedDomains = sourcePolicies
        .filter((policy) => policy.reviewStatus === "SUSPENDED")
        .map((policy) => policy.domain);
      const settled = await Promise.allSettled(
        adapters.map((adapter) =>
          discoverProviderPages({
            adapter,
            query: q,
            ctx,
            options: { blockedDomains },
          }),
        ),
      );
      // 预算耗尽绝不被吞成假成功。**不能**靠「某源 reject」判断——provider 的 fail-safe catch 会把
      // BudgetExceededError 吞成空结果（对源失败是对的），编排层从返回值区分不出「真没数据」还是「打穿被吞」。
      // 改由 BudgetLedger 唯一真相点判：本 run 预算若在 fan-out 中被任一源的 broker/gateway reserve 打穿，
      // wasExhausted=true → 显性上报截断，让 workflow 判 PARTIAL 而非假 DONE（各源 fail-safe 拿到的部分记录仍落库）。
      const budgetTruncated = budgetLedger.wasExhausted(args.runId);

      // ── 事务内：持久化各源 raw（带来源留痕），providerKey 区分来源 ──
      // 用 createMany({skipDuplicates}) 单语句写入：撞唯一键会被跳过而非 abort 事务
      // （Postgres 里 catch 单条 P2002 会毒化整个事务）。批内先按 externalId 去重。
      return deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        let rawCount = 0;
        let quarantinedCount = 0;
        let rejectedCount = 0;
        let duplicateCount = 0;
        let totalCost = 0;
        const providersHit: string[] = [];
        let failedProviderCount = 0;
        let paginationTruncated = false;
        const perProvider: Record<string, ProviderExecutionStats> = {};
        const providerUsageLedger: Prisma.InputJsonObject[] = [];
        let providerCallCount = 0;
        for (const [index, s] of settled.entries()) {
          // Promise.allSettled preserves input order. Reading the key from the
          // routed adapter is essential because a rejected promise has no
          // result payload from which the provider could be recovered.
          const key = adapters[index]!.key;
          const providerStats =
            perProvider[key] ?? emptyProviderExecutionStats();
          perProvider[key] = providerStats;
          providerStats.attemptedCount += 1;
          if (s.status !== "fulfilled") {
            failedProviderCount += 1;
            providerStats.failureCount += 1;
            continue;
          }
          const {
            r,
            paginationFailed,
            paginationTruncated: providerPaginationTruncated,
          } = s.value;
          paginationTruncated ||= providerPaginationTruncated;
          if (paginationFailed) {
            failedProviderCount += 1;
            providerStats.failureCount += 1;
          } else {
            providerStats.successCount += 1;
            if (r.records.length === 0) providerStats.zeroResultCount += 1;
          }
          if (r.records.length) providersHit.push(key);
          const prepared = prepareRawSourceBatch({
            providerKey: key,
            records: r.records,
            policies: sourcePolicies as RawSourcePolicySnapshot[],
            limits: deps.rawIngestLimits ?? rawSourceIngestLimits(),
            now: deps.now?.() ?? new Date(),
          });
          if (prepared.rows.length) {
            await tx.$executeRaw(
              Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`raw-source:${args.workspaceId}:${args.runId}:${key}`}, 0))`,
            );
            const ingestKeys = prepared.rows.flatMap((row) => [
              row.ingestKey,
              rawDriftIngestKey(row.ingestKey, row.payloadHash),
            ]);
            const externalIds = prepared.rows.flatMap((row) =>
              row.externalId ? [row.externalId] : [],
            );
            const existing = await tx.rawSourceRecord.findMany({
              where: {
                runId: args.runId,
                providerKey: key,
                OR: [
                  { ingestKey: { in: ingestKeys } },
                  ...(externalIds.length
                    ? [{ externalId: { in: externalIds } }]
                    : []),
                ],
              },
              select: {
                id: true,
                externalId: true,
                ingestKey: true,
                payloadHash: true,
                payload: true,
              },
            });
            const reconciled = reconcileRawSourceBatch(prepared.rows, existing);
            if (reconciled.rows.length) {
              const created = await tx.rawSourceRecord.createMany({
                data: reconciled.rows.map((row) => ({
                  workspaceId: args.workspaceId,
                  runId: args.runId,
                  providerKey: key,
                  sourceClass: q.sourceClass,
                  externalId: row.externalId,
                  payload: row.payload as Prisma.InputJsonValue,
                  sourceUrl: row.sourceUrl,
                  fetchedAt: row.fetchedAt,
                  contentHash: row.contentHash,
                  parserVersion: row.parserVersion,
                  ingestKey: row.ingestKey,
                  payloadHash: row.payloadHash,
                  payloadBytes: row.payloadBytes,
                  ingestVersion: row.ingestVersion,
                  ingestStatus: row.ingestStatus,
                  dispositionCode: row.dispositionCode,
                  retentionDays: row.retentionDays,
                  expiresAt: row.expiresAt,
                  sourcePolicySnapshot:
                    row.sourcePolicySnapshot as Prisma.InputJsonValue,
                  costCents: 0,
                })),
                skipDuplicates: true,
              });
              if (created.count !== reconciled.rows.length) {
                throw new Error("RAW_SOURCE_CONCURRENT_WRITE_CONFLICT");
              }
            }
            rawCount += reconciled.acceptedCount;
            quarantinedCount += reconciled.quarantinedCount;
            rejectedCount += reconciled.rejectedCount;
            duplicateCount += reconciled.duplicateCount;
            providerStats.rawCount += reconciled.acceptedCount;
            providerStats.quarantinedCount += reconciled.quarantinedCount;
            providerStats.rejectedCount += reconciled.rejectedCount;
            providerStats.duplicateCount += reconciled.duplicateCount;
          }
          totalCost += r.costCents;
          if (r.costCents > 0 || r.usage) {
            const callCount = r.usage?.callCount ?? providerStats.rawCount;
            providerCallCount += callCount;
            providerUsageLedger.push({
              providerKey: key,
              accounting: r.usage ? "reported_calls" : "legacy_raw_count",
              rawCount: providerStats.rawCount,
              costCents: r.costCents,
              callCount,
              breakdown: (r.usage?.breakdown ?? []).map(
                (entry): Prisma.InputJsonObject => ({ ...entry }),
              ),
            });
          }
        }
        if (providerCallCount > 0 || totalCost > 0) {
          await tx.usageLedger.create({
            data: {
              workspaceId: args.workspaceId,
              resourceType: "provider_call",
              quantity: providerCallCount,
              costUsd: totalCost / 100,
              refType: "discovery_run",
              refId: args.runId,
              meta: {
                providers: providersHit,
                sourceClass: q.sourceClass,
                providerUsage: providerUsageLedger,
              },
            },
          });
        }
        return {
          rawCount,
          quarantinedCount,
          rejectedCount,
          duplicateCount,
          costCents: totalCost,
          provider: providersHit.join("+") || null,
          failedProviderCount,
          budgetTruncated,
          paginationTruncated,
          perProvider: Object.fromEntries(
            Object.entries(perProvider).sort(([left], [right]) =>
              left < right ? -1 : left > right ? 1 : 0,
            ),
          ),
        };
      });
    },

    /**
     * 归一 + 身份解析（PRD 8.8）+ 字段级 Evidence（8.10）+ Suppression 标记。
     * 幂等：canonical 按 dedupeKey upsert；identity_link 按 (canonical,raw) 去重。
     */
    async canonicalizeRun(args: {
      workspaceId: string;
      runId: string;
    }): Promise<{
      companies: number;
      suppressed: number;
      manualFollowup: number;
      identityQuality: Record<string, ProviderIdentityQuality>;
    }> {
      return deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        // Canonical materialization participates in the same linearization
        // protocol as suppression creation and downstream PII commits. This
        // stage performs no network I/O, so the transaction-scoped lock covers
        // the authoritative suppression read and every canonical write.
        const policyLock = await lockWorkspaceSuppressionPolicy(
          tx,
          args.workspaceId,
        );
        const governanceDispositions =
          await tx.rawSourceGovernanceDisposition.findMany({
            where: {
              workspaceId: args.workspaceId,
              runId: args.runId,
              effect: "RESTRICT_PROCESSING",
            },
            select: { rawRecordId: true, providerKey: true },
          });
        const restrictedProviders = new Map(
          governanceDispositions.map((disposition) => [
            disposition.rawRecordId,
            disposition.providerKey,
          ]),
        );
        const rawReferences = await tx.rawSourceRecord.findMany({
          where: { runId: args.runId, ingestStatus: "ACCEPTED" },
          select: { id: true },
        });
        const { consumable: consumableReferences } =
          partitionGovernedRawRecords(
            rawReferences,
            new Set(restrictedProviders.keys()),
          );
        const fetchedRaws = consumableReferences.length
          ? await tx.rawSourceRecord.findMany({
              where: {
                runId: args.runId,
                ingestStatus: "ACCEPTED",
                id: { in: consumableReferences.map((raw) => raw.id) },
              },
            })
          : [];
        // A second partition is intentional defense in depth for owner roles
        // that bypass RLS and for replay callers with custom data clients.
        const { consumable: raws } = partitionGovernedRawRecords(
          fetchedRaws,
          new Set(restrictedProviders.keys()),
        );
        const suppressions = await tx.suppressionRecord.findMany({
          where: { type: { in: ["domain", "company_name"] } },
        });
        let companies = 0;
        let suppressed = restrictedProviders.size;
        let manualFollowup = 0;
        const identityQuality = new ProviderIdentityQualityTracker();
        for (const providerKey of restrictedProviders.values()) {
          identityQuality.recordSuppressed(providerKey);
        }
        for (const raw of raws) {
          const rec = raw.payload as unknown as {
            name?: string;
            domain?: string;
            country?: string;
            region?: string;
            industry?: string;
            employeeCount?: number;
            revenueUsd?: number;
            attributes?: Record<string, unknown>;
            identifier?: { scheme: string; value: string }; // §8.4 provider 标识（税号/注册号）
            identifiers?: {
              scheme: string;
              value: string;
              jurisdiction?: string;
            }[];
            license?: string; // §8.5 记录声明许可（绿事实源署名义务，如 TED CC BY 4.0）
          };
          identityQuality.recordAccepted(raw.providerKey, rec);
          if (!rec.name) continue;
          const nppesLifecycle = await commitNppesLifecycleFact(tx, {
            workspaceId: args.workspaceId,
            raw: {
              id: raw.id,
              providerKey: raw.providerKey,
              sourceUrl: raw.sourceUrl,
              fetchedAt: raw.fetchedAt,
              contentHash: raw.contentHash,
              parserVersion: raw.parserVersion,
            },
            record: { ...rec, name: rec.name },
            now: deps.now?.() ?? new Date(),
          });
          // Exact NPPES D is a lifecycle status fact, not a new candidate. The
          // NPI and identity link remain ACTIVE because the organization did
          // not become a different entity; root + aliases are suppressed from
          // acquisition. Existing terminal/delivered Lead facts remain intact
          // and make the run visibly require manual follow-up.
          if (nppesLifecycle.kind !== "not_applicable") {
            if (nppesLifecycle.kind === "deactivated") {
              suppressed += 1;
              identityQuality.recordSuppressed(raw.providerKey);
              if (nppesLifecycle.requiresManualFollowup) manualFollowup += 1;
            }
            continue;
          }
          const identity = companyIdentity({
            name: rec.name,
            domain: rec.domain,
            country: rec.country,
            identifier: rec.identifier, // §8.4：无域名时按税号消歧，防同名同国不同实体误并
          });
          const materialization = await loadMaterializableCompanyState(
            tx,
            args.workspaceId,
            identity.dedupeKey,
            { name: rec.name, domain: rec.domain },
            { knownSuppressions: suppressions, policyLock },
          );
          if (!materialization.allowed) {
            suppressed += 1;
            identityQuality.recordSuppressed(raw.providerKey);
            continue;
          }

          const resolution = await resolveOrganizationIdentityForRaw(tx, {
            workspaceId: args.workspaceId,
            rawRecordId: raw.id,
            providerKey: raw.providerKey,
            record: { ...rec, name: rec.name },
          });
          // 多强标识互相矛盾时只留下 pending link + 冲突，不把事实错误投影给任何公司。
          if (resolution.kind === "conflict") {
            identityQuality.recordConflict(raw.providerKey);
            continue;
          }
          companies += 1;
          identityQuality.recordBound(
            raw.providerKey,
            resolution.companyId,
            resolution.replayed,
          );

          if (!resolution.replayed) {
            // 字段级 Evidence：该 raw 记录贡献的每个非空字段留痕
            const fields: [string, unknown][] = [
              ["name", rec.name],
              ["domain", rec.domain],
              ["country", rec.country],
              ["region", rec.region],
              ["industry", rec.industry],
              ["employee_count", rec.employeeCount],
              ["revenue_usd", rec.revenueUsd],
              ["attributes", rec.attributes],
            ];
            for (const [field, value] of fields) {
              if (value == null) continue;
              await tx.fieldEvidence.create({
                data: {
                  workspaceId: args.workspaceId,
                  entityType: "company",
                  entityId: resolution.companyId,
                  field,
                  value: value as Prisma.InputJsonValue,
                  providerKey: raw.providerKey,
                  rawRecordId: raw.id,
                  license: resolveEvidenceLicense(rec.license, raw.providerKey), // §8.5：记录声明许可优先（TED CC BY 4.0），否则回退不变
                  allowedActions: [
                    "display",
                    "match",
                  ] as unknown as Prisma.InputJsonValue,
                },
              });
            }
          }
        }
        return {
          companies,
          suppressed,
          manualFollowup,
          identityQuality: identityQuality.snapshot(),
        };
      });
    },

    /**
     * ICP 资格门（发现评测驱动，PRD 5.6 前置）：对本次 run 归一出的、尚未判定的
     * canonical 公司逐家跑四门判别（材质/角色/工艺/商业模式），写 **Lead(本 run ICP × 公司)** 的 fit_verdict。
     * 召回与资格分离——挖掘负责"是不是真公司"，这里负责"是不是该 ICP 的客户"。
     * 判定即 CandidateAssessment：发现候选就建 Lead 行（status=DISCOVERED、无 scores），评分阶段再填 scores。
     * fit 挂 Lead 而非 canonical —— 同 workspace 多 ICP 各自独立判，互不覆盖。网络调用在事务外，落库在事务内。
     */
    async qualifyFitForRun(args: {
      workspaceId: string;
      runId: string;
      icpId: string;
    }): Promise<{
      judged: number;
      failed: number;
      verdicts: Record<string, number>;
      skippedForBudget: number;
    }> {
      ensureRunBudget(args.runId); // fit 判定（LLM）消耗计入本 run 预算
      // ICP 摘要 + 本 run 待判公司（事务内只读，快）
      const { icpBrief, companies } = await deps.prisma.withWorkspace(
        args.workspaceId,
        async (tx) => {
          const icpBrief = await loadIcpBrief(tx, args.icpId);
          const rawIds = await tx.rawSourceRecord.findMany({
            where: { runId: args.runId },
            select: { id: true },
          });
          const links = await tx.identityLink.findMany({
            where: {
              canonicalType: "company",
              status: "ACTIVE",
              rawRecordId: { in: rawIds.map((r) => r.id) },
            },
            select: { canonicalId: true },
          });
          const identityGroups = await resolveOrganizationIdentityGroups(
            tx,
            args.workspaceId,
            links.map((link) => link.canonicalId),
          );
          const identityRootByCompany = new Map<string, string>();
          for (const group of identityGroups) {
            for (const companyId of group.relatedCompanyIds)
              identityRootByCompany.set(companyId, group.rootCompanyId);
          }
          const existingLeads = await findIdentityGroupLeadsForIcp(
            tx,
            args.workspaceId,
            args.icpId,
            identityGroups,
          );
          const leadsByRoot = new Map<string, typeof existingLeads>();
          for (const lead of existingLeads) {
            const rootCompanyId = identityRootByCompany.get(
              lead.canonicalCompanyId,
            );
            if (!rootCompanyId) continue;
            const rootLeads = leadsByRoot.get(rootCompanyId) ?? [];
            rootLeads.push(lead);
            leadsByRoot.set(rootCompanyId, rootLeads);
          }
          for (const group of identityGroups) {
            if ((leadsByRoot.get(group.rootCompanyId)?.length ?? 0) > 1) {
              throw new IdentityGroupLeadConflictError(
                group.rootCompanyId,
                args.icpId,
              );
            }
          }
          const candidateGroups = identityGroups.filter((group) => {
            const lead = leadsByRoot.get(group.rootCompanyId)?.[0];
            return !lead || lead.fitVerdict === null;
          });
          if (!candidateGroups.length) return { icpBrief, companies: [] };
          const candidateRootIds = candidateGroups.map(
            (group) => group.rootCompanyId,
          );
          const identitySnapshots = await loadOrganizationIdentitySnapshots(
            tx,
            args.workspaceId,
            candidateRootIds,
          );
          const companies = await tx.canonicalCompany.findMany({
            // 尚无「本 run ICP」的已判 Lead（无 Lead 或该 Lead.fitVerdict 为 null）才判定——防重复判、
            // 且以 icpId 限定 → 别的 ICP 判过的公司在本 ICP 仍会被判（修「后判 ICP 判不了」的漏斗断流）。
            where: {
              id: { in: candidateRootIds },
              status: { not: "SUPPRESSED" },
              identityConflictParties: {
                none: { conflict: { status: { in: ["OPEN", "RESOLVING"] } } },
              },
            },
            select: {
              id: true,
              name: true,
              domain: true,
              country: true,
              industry: true,
              attributes: true,
            },
          });
          const candidateRootByCompany = new Map<string, string>();
          for (const group of candidateGroups) {
            for (const companyId of group.relatedCompanyIds)
              candidateRootByCompany.set(companyId, group.rootCompanyId);
          }
          const evidenceRows = companies.length
            ? await tx.fieldEvidence.findMany({
                where: {
                  entityType: "company",
                  entityId: { in: [...candidateRootByCompany.keys()] },
                },
                select: {
                  id: true,
                  entityId: true,
                  field: true,
                  value: true,
                  providerKey: true,
                  allowedActions: true,
                  fetchedAt: true,
                },
                orderBy: { fetchedAt: "desc" },
              })
            : [];
          const evidenceByCompany = new Map<string, typeof evidenceRows>();
          for (const row of evidenceRows) {
            const rootCompanyId =
              candidateRootByCompany.get(row.entityId) ?? row.entityId;
            const existing = evidenceByCompany.get(rootCompanyId) ?? [];
            existing.push(row);
            evidenceByCompany.set(rootCompanyId, existing);
          }
          return {
            icpBrief,
            companies: companies.map((company) => ({
              ...company,
              evidence: evidenceByCompany.get(company.id) ?? [],
              identityFingerprint:
                identitySnapshots.get(company.id)?.fingerprint ?? "",
            })),
          };
        },
      );

      const verdicts: Record<string, number> = {
        match: 0,
        weak: 0,
        mismatch: 0,
      };
      let judged = 0;
      let failed = 0;

      // 逐家判别（事务外，可并发但这里顺序以控成本/限流）
      let skippedForBudget = 0;
      for (let i = 0; i < companies.length; i++) {
        const c = companies[i];
        if (
          !(await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
            companyMayUseExternalProcessing(tx, args.workspaceId, c.id),
          ))
        )
          continue;
        let judgment;
        try {
          const authorizeExternalAction = authorizeCompanyExternalAction(
            args.workspaceId,
            c.id,
          );
          judgment = await judgeFitCompany(
            deps.gateway,
            args.workspaceId,
            icpBrief,
            c,
            {
              runId: args.runId,
              runtimeTelemetry: deps.runtimeTelemetry,
              authorizeExternalAction,
            },
          );
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            // 预算耗尽=本批余下全部会失败 → 中断并显性计数（复审 HIGH：绝不静默漏判假 DONE）
            skippedForBudget = companies.length - i;
            console.warn(
              `[discovery] run ${args.runId} fit 预算耗尽：跳过余下 ${skippedForBudget} 家（进 stats，backlog sweep 兜底）`,
            );
            break;
          }
          throw err;
        }
        if (!judgment) {
          // judgeFitCompany 对模型超时、截断、schema 失败或 stub 回退都返回 null。
          // 可以继续判其他公司，但不能把这次未完成冒充成功。
          failed += 1;
          continue;
        }
        const committed = await deps.prisma.withWorkspace(
          args.workspaceId,
          (tx) =>
            upsertLeadFit(
              tx,
              args.workspaceId,
              args.icpId,
              c.id,
              judgment,
              c.identityFingerprint,
            ),
        );
        if (!committed) {
          failed += 1;
          continue;
        }
        verdicts[judgment.verdict] += 1;
        judged += 1;
      }
      return { judged, failed, verdicts, skippedForBudget };
    },

    /**
     * 富集（Waterfall 富化段，PRD 7.4.7/7.4.8）。默认只对通过 ICP 资格门的高价值公司
     * （fitVerdict=match）补结构化事实 —— 多个富集源**互补并跑**：
     *   GLEIF = 法律身份（LEI/法人形式/母子关系）；Wikidata = 商业事实（行业/产品/财务/官网）。
     * 「贵操作只给会跟进的线索」；各源零成本但受限流，故限量。
     *
     * phase=pre_fit_evidence 是资格门前的例外：跑 Wikidata/GLEIF 身份事实 + 官网公开结构化事实，
     * 且不要求已有 Lead/match。它解决「没证据不能判 fit，没判 fit 又不富集」的循环依赖。
     * 深度富集仍在 fit=match 后执行，不放大 GLEIF/信号源的调用面。
     * 幂等：按 enricher key 命名空间存 attributes，已有该源命名空间则跳过（重跑不重复写证据）。
     * 网络调用在事务外，每家命中后单独落库（attributes 命名空间合并 + 逐字段 field_evidence）。
     */
    async enrichRun(args: {
      workspaceId: string;
      runId: string;
      icpId: string;
      phase?: "pre_fit_evidence";
    }): Promise<{
      enriched: number;
      matched: number;
      provider: string | null;
      budgetTruncated: boolean;
      dataQualityBlocked: boolean;
      perProvider: Record<string, ProviderExecutionStats>;
      identityQuality: Record<string, ProviderIdentityQuality>;
    }> {
      const preFitEvidence = args.phase === "pre_fit_evidence";
      const enrichers = await deps.prisma.withWorkspace(
        args.workspaceId,
        (tx) =>
          preFitEvidence
            ? deps.providers.routeFitEvidenceEnrichment(tx as never)
            : deps.providers.routeEnrichment(tx as never),
      );
      if (!enrichers.length)
        return {
          enriched: 0,
          matched: 0,
          provider: null,
          budgetTruncated: false,
          dataQualityBlocked: false,
          perProvider: {},
          identityQuality: {},
        };

      const enrichmentSourcePolicies = enrichers.some((provider) => provider.key === "sec_edgar")
        ? await deps.prisma.sourcePolicy.findMany({
            select: {
              id: true,
              domain: true,
              retentionDays: true,
              reviewStatus: true,
              updatedAt: true,
            },
          })
        : [];

      // 本 run 归一出的公司。证据前置阶段不要求 Lead；默认深度富集仍要求 fit=match。
      const companies = await deps.prisma.withWorkspace(
        args.workspaceId,
        async (tx) => {
          const rawIds = await tx.rawSourceRecord.findMany({
            where: { runId: args.runId },
            select: { id: true },
          });
          const links = await tx.identityLink.findMany({
            where: {
              canonicalType: "company",
              status: "ACTIVE",
              rawRecordId: { in: rawIds.map((r) => r.id) },
            },
            select: { canonicalId: true },
          });
          const ids = await resolveOrganizationRootIds(
            tx,
            args.workspaceId,
            links.map((link) => link.canonicalId),
          );
          const rows = await tx.canonicalCompany.findMany({
            where: {
              id: { in: ids },
              status: { not: "SUPPRESSED" },
              identityConflictParties: {
                none: { conflict: { status: { in: ["OPEN", "RESOLVING"] } } },
              },
              ...(preFitEvidence
                ? {}
                : {
                    leads: { some: { icpId: args.icpId, fitVerdict: "match" } },
                  }),
            },
            select: {
              id: true,
              name: true,
              domain: true,
              country: true,
              region: true,
              attributes: true,
            },
          });
          const identitySnapshots = await loadOrganizationIdentitySnapshots(
            tx,
            args.workspaceId,
            rows.map((row) => row.id),
          );
          return rows.map((row) => ({
            ...row,
            organizationIdentifiers: identitySnapshots.get(row.id)!.identifiers,
            identitySnapshot: identitySnapshots.get(row.id)!.fingerprint,
          }));
        },
      );

      ensureRunBudget(args.runId);
      const providersHit = new Set<string>();
      const perProvider: Record<string, ProviderExecutionStats> = {};
      const enrichmentIdentityQuality = new ProviderIdentityQualityTracker();
      let dataQualityBlocked = false;
      let enriched = 0;
      let matched = 0;
      const companyLimit = preFitEvidence
        ? FIT_EVIDENCE_ENRICH_LIMIT
        : ENRICH_LIMIT;
      for (const c of companies.slice(0, companyLimit)) {
        const ctx: ExecutionContext = {
          workspaceId: args.workspaceId,
          runId: args.runId,
          correlationId: args.runId,
          authorizeExternalAction: authorizeCompanyExternalAction(
            args.workspaceId,
            c.id,
          ),
        };
        const existing = ((c.attributes as Record<string, unknown> | null) ??
          {}) as Record<string, unknown>;
        // 默认深富集互补并跑；资格前置阶段则逐源提交。这样 Wikidata
        // 安全提升的 domain 能在同一轮立即供 digital_footprint 使用。
        const hits: { key: string; result: EnrichmentResult }[] = [];
        let workingDomain = c.domain ?? undefined;
        let workingIdentifiers = c.organizationIdentifiers ?? [];
        let workingIdentitySnapshot = c.identitySnapshot;
        let companyMatched = false;
        for (const e of enrichers) {
          const existingProviderFacts = recordValue(existing[e.key]);
          const needsSecSubmissionObservation =
            preFitEvidence &&
            e.key === "sec_edgar" &&
            existingProviderFacts?.submission_schema_version !==
              "sec-edgar-submission-observation/v1";
          const needsFitEvidenceLazyUpgrade =
            preFitEvidence &&
            (needsSecSubmissionObservation ||
              (e.key === "digital_footprint" &&
              (!hasStructuredProducts(existingProviderFacts) ||
                !hasCurrentFitEvidenceVersion(existingProviderFacts))) ||
              (e.key === "wikidata" &&
                !hasCurrentWikidataIdentityVersion(existingProviderFacts)));
          if (existingProviderFacts && !needsFitEvidenceLazyUpgrade) continue; // 该源已有本阶段证据
          if (
            !(await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
              companyMayUseExternalProcessing(tx, args.workspaceId, c.id),
            ))
          )
            break;
          try {
            const providerStats = perProvider[e.key] ?? emptyProviderExecutionStats();
            perProvider[e.key] = providerStats;
            let secBinding = null;
            if (e.key === "sec_edgar") {
              secBinding = await deps.prisma.withWorkspace(
                args.workspaceId,
                (tx) => loadSecEdgarDirectoryBinding(tx, {
                  workspaceId: args.workspaceId,
                  runId: args.runId,
                  companyId: c.id,
                }),
              );
              // A submissions call is never allowed to bootstrap from a name
              // or caller-supplied CIK. No persisted directory binding means
              // no attempt and no wire.
              if (!secBinding) continue;
            }
            providerStats.attemptedCount += 1;
            const r = await e.enrichCompany(
              {
                name: c.name,
                domain: workingDomain,
                country: c.country ?? undefined,
                region: c.region ?? undefined,
                identifiers: workingIdentifiers,
                identitySnapshot: workingIdentitySnapshot,
                purpose: preFitEvidence ? "fit_evidence" : "deep_enrichment",
                ...(secBinding
                  ? {
                      sourceBindings: [{
                        providerKey: "sec_edgar",
                        rawRecordId: secBinding.rawRecordId,
                        externalId: secBinding.externalId,
                        name: secBinding.companyName,
                        identifier: {
                          scheme: "cik",
                          jurisdiction: "US",
                          value: secBinding.cik,
                        },
                        sourceUrl: secBinding.sourceUrl,
                        parserVersion: secBinding.parserVersion,
                      }],
                    }
                  : {}),
              },
              ctx,
            );
            if (e.key === "sec_edgar") {
              if (!r.matched || !secBinding) {
                providerStats.successCount += 1;
                providerStats.zeroResultCount += 1;
                dataQualityBlocked = true;
                continue;
              }
              const persisted = await deps.prisma.withWorkspace(
                args.workspaceId,
                (tx) => persistSecEdgarSubmissionObservation(tx, {
                  workspaceId: args.workspaceId,
                  runId: args.runId,
                  binding: secBinding!,
                  result: r,
                  sourcePolicies: enrichmentSourcePolicies as RawSourcePolicySnapshot[],
                  limits: deps.rawIngestLimits ?? rawSourceIngestLimits(),
                  now: deps.now?.() ?? new Date(),
                }),
              );
              providerStats.successCount += 1;
              providerStats.rawCount += persisted.rawCreated;
              if (persisted.replayed || persisted.rawCreated === 0) {
                providerStats.duplicateCount += 1;
              }
              companyMatched = true;
              enrichmentIdentityQuality.recordAccepted(
                e.key,
                r.rawObservation?.payload ?? {},
              );
              enrichmentIdentityQuality.recordBound(
                e.key,
                secBinding.companyId,
                persisted.replayed,
              );
              providersHit.add(e.key);
              existing[e.key] = { ...existingProviderFacts, ...r.attributes };
              continue;
            }
            providerStats.successCount += 1;
            if (!r.matched) providerStats.zeroResultCount += 1;
            if (r.matched) {
              const hit = {
                key: e.key,
                result:
                  needsFitEvidenceLazyUpgrade && existingProviderFacts
                    ? {
                        ...r,
                        attributes: {
                          ...existingProviderFacts,
                          ...r.attributes,
                        },
                      }
                    : r,
              };
              if (preFitEvidence) {
                const committed = await deps.prisma.withWorkspace(
                  args.workspaceId,
                  (tx) =>
                    commitCompanyEnrichmentResults(tx, {
                      workspaceId: args.workspaceId,
                      companyId: c.id,
                      hits: [hit],
                      status: "ENRICHED",
                      expectedIdentitySnapshot: workingIdentitySnapshot,
                    }),
                );
                if (!committed) break;
                companyMatched = true;
                providersHit.add(hit.key);
                existing[hit.key] = hit.result.attributes;
                const claimedDomain = hit.result.identifiers
                  ?.filter(
                    (identifier) =>
                      identifier.scheme.toLocaleLowerCase("en-US") === "domain",
                  )
                  .map((identifier) => identifier.value)[0];
                if (claimedDomain) workingDomain = claimedDomain;
                const refreshedIdentity = await deps.prisma.withWorkspace(
                  args.workspaceId,
                  (tx) =>
                    loadOrganizationIdentitySnapshot(
                      tx,
                      args.workspaceId,
                      c.id,
                    ),
                );
                workingIdentifiers = refreshedIdentity.identifiers;
                workingIdentitySnapshot = refreshedIdentity.fingerprint;
              } else {
                hits.push(hit);
              }
            }
          } catch {
            // 单富集源失败不影响其余
            const providerStats = perProvider[e.key] ?? emptyProviderExecutionStats();
            perProvider[e.key] = providerStats;
            providerStats.failureCount += 1;
            if (e.key === "sec_edgar") dataQualityBlocked = true;
          }
        }
        enriched += 1;
        if (preFitEvidence) {
          if (companyMatched) matched += 1;
          continue;
        }
        if (!hits.length) continue;
        const committed = await deps.prisma.withWorkspace(
          args.workspaceId,
          (tx) =>
            commitCompanyEnrichmentResults(tx, {
              workspaceId: args.workspaceId,
              companyId: c.id,
              hits,
              status: "ENRICHED",
              expectedIdentitySnapshot: workingIdentitySnapshot,
            }),
        );
        if (!committed) continue;
        matched += 1;
        hits.forEach((h) => providersHit.add(h.key));
      }
      // 富集阶段与发现共享 run 预算账户：某源在富集中打穿 → wasExhausted 检出，让 run 判 PARTIAL 而非假 DONE
      // （provider fail-safe 吞了 BudgetExceededError，仍靠 ledger 唯一真相点判——与 executeQuery 一致）。
      return {
        enriched,
        matched,
        provider: providersHit.size ? [...providersHit].join("+") : null,
        budgetTruncated: budgetLedger.wasExhausted(args.runId),
        dataQualityBlocked,
        perProvider,
        identityQuality: enrichmentIdentityQuality.snapshot(),
      };
    },

    /**
     * 信号富集（v3.0）——与 enrichRun **分开的独立活动**（抓官网/sitemap 慢且时变，绝不塞进
     * enrichRun 的 2 分钟活动）。由 discoveryWorkflow 用**长 startToCloseTimeout + heartbeat** 代理。
     *  - DAT-011：SUSPENDED 域名跳过（富集侧同样遵守 source_policy）。
     *  - TTL 刷新：命名空间 `_ts` 在 SIGNAL_TTL_MS 内则跳过（信号时变，不能像 GLEIF 静态事实那样一次写死）。
     *  - 每家 heartbeat + 上限 SIGNAL_ENRICH_LIMIT，防长活动被判卡死。
     */
    async enrichSignalsRun(args: {
      workspaceId: string;
      runId: string;
      icpId: string;
    }): Promise<{
      enriched: number;
      matched: number;
      provider: string | null;
      budgetTruncated: boolean;
    }> {
      const enrichers = await deps.prisma.withWorkspace(
        args.workspaceId,
        (tx) => deps.providers.routeSignalEnrichment(tx as never),
      );
      if (!enrichers.length)
        return {
          enriched: 0,
          matched: 0,
          provider: null,
          budgetTruncated: false,
        };

      // DAT-011：SUSPENDED 域名黑名单（平台级 source_policy，富集侧同样遵守 —— 富集也会抓这些域名）
      const suspended = new Set(
        (
          await deps.prisma.sourcePolicy.findMany({
            where: { reviewStatus: "SUSPENDED" },
            select: { domain: true },
          })
        ).map((s) => s.domain.toLowerCase()),
      );

      const companies = await deps.prisma.withWorkspace(
        args.workspaceId,
        async (tx) => {
          const rawIds = await tx.rawSourceRecord.findMany({
            where: { runId: args.runId },
            select: { id: true },
          });
          const links = await tx.identityLink.findMany({
            where: {
              canonicalType: "company",
              status: "ACTIVE",
              rawRecordId: { in: rawIds.map((r) => r.id) },
            },
            select: { canonicalId: true },
          });
          const ids = await resolveOrganizationRootIds(
            tx,
            args.workspaceId,
            links.map((link) => link.canonicalId),
          );
          const rows = await tx.canonicalCompany.findMany({
            where: {
              id: { in: ids },
              status: { not: "SUPPRESSED" },
              identityConflictParties: {
                none: { conflict: { status: { in: ["OPEN", "RESOLVING"] } } },
              },
              domain: { not: null },
              leads: { some: { icpId: args.icpId, fitVerdict: "match" } },
            },
            select: {
              id: true,
              name: true,
              domain: true,
              country: true,
              region: true,
              attributes: true,
            },
          });
          const identitySnapshots = await loadOrganizationIdentitySnapshots(
            tx,
            args.workspaceId,
            rows.map((row) => row.id),
          );
          return rows.map((row) => ({
            ...row,
            organizationIdentifiers: identitySnapshots.get(row.id)!.identifiers,
            identitySnapshot: identitySnapshots.get(row.id)!.fingerprint,
          }));
        },
      );

      ensureRunBudget(args.runId);
      const providersHit = new Set<string>();
      let enriched = 0;
      let matched = 0;
      const nowMs = Date.now();
      for (const c of companies.slice(0, SIGNAL_ENRICH_LIMIT)) {
        const ctx: ExecutionContext = {
          workspaceId: args.workspaceId,
          runId: args.runId,
          correlationId: args.runId,
          authorizeExternalAction: authorizeCompanyExternalAction(
            args.workspaceId,
            c.id,
          ),
        };
        if (c.domain && suspended.has(c.domain.toLowerCase())) continue; // DAT-011：富集侧跳过 SUSPENDED

        const existing = ((c.attributes as Record<string, unknown> | null) ??
          {}) as Record<string, unknown>;
        const hits: { key: string; result: EnrichmentResult }[] = [];
        for (const e of enrichers) {
          const prev = existing[e.key] as { _ts?: string } | undefined;
          if (prev?._ts && nowMs - Date.parse(prev._ts) < SIGNAL_TTL_MS)
            continue; // TTL 新鲜 → 跳过（不刷）
          if (
            !(await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
              companyMayUseExternalProcessing(tx, args.workspaceId, c.id),
            ))
          )
            break;
          try {
            const r = await e.enrichCompany(
              {
                name: c.name,
                domain: c.domain ?? undefined,
                country: c.country ?? undefined,
                region: c.region ?? undefined,
                identifiers: c.organizationIdentifiers,
                identitySnapshot: c.identitySnapshot,
                purpose: "signal",
              },
              ctx,
            );
            if (r.matched) hits.push({ key: e.key, result: r });
          } catch {
            /* 单信号源失败不影响其余 */
          }
        }
        enriched += 1;
        if (!hits.length) continue;
        const committed = await deps.prisma.withWorkspace(
          args.workspaceId,
          (tx) =>
            commitCompanyEnrichmentResults(tx, {
              workspaceId: args.workspaceId,
              companyId: c.id,
              hits,
              signalTimestamp: new Date(nowMs),
              expectedIdentitySnapshot: c.identitySnapshot,
            }),
        );
        if (!committed) continue;
        matched += 1;
        hits.forEach((h) => providersHit.add(h.key));
      }
      return {
        enriched,
        matched,
        provider: providersHit.size ? [...providersHit].join("+") : null,
        budgetTruncated: budgetLedger.wasExhausted(args.runId),
      };
    },

    /**
     * 从 ICP 短名单自动注册网站变更监控（#4 loop 收口）：对本 run 归一出的 **fit=match + 有域名**公司
     * （与 enrichSignalsRun 同口径）建平台级 web_watch monitored_source（dedup by 域名，sitemap 推监控页），
     * 交给独立 intentSweep 持续盯产品/招聘/供应商招募/新闻页变更 → intent 事件 → 投影进 attributes.intent.*。
     * 慢（每家一次 sitemap 探测）→ 走长活动；best-effort，单家失败不影响其余与 run 状态。
     */
    async registerWatchesForRun(args: {
      workspaceId: string;
      runId: string;
      icpId: string;
    }): Promise<{ candidates: number; registered: number }> {
      const intentSvc = new IntentProjectionService({
        prisma: deps.prisma,
        broker: deps.broker,
      });
      const companies = await deps.prisma.withWorkspace(
        args.workspaceId,
        async (tx) => {
          const rawIds = await tx.rawSourceRecord.findMany({
            where: { runId: args.runId },
            select: { id: true },
          });
          const links = await tx.identityLink.findMany({
            where: {
              canonicalType: "company",
              status: "ACTIVE",
              rawRecordId: { in: rawIds.map((r) => r.id) },
            },
            select: { canonicalId: true },
          });
          const ids = await resolveOrganizationRootIds(
            tx,
            args.workspaceId,
            links.map((link) => link.canonicalId),
          );
          return tx.canonicalCompany.findMany({
            where: {
              id: { in: ids },
              status: { not: "SUPPRESSED" },
              identityConflictParties: {
                none: { conflict: { status: { in: ["OPEN", "RESOLVING"] } } },
              },
              domain: { not: null },
              leads: { some: { icpId: args.icpId, fitVerdict: "match" } },
            },
            select: { id: true },
          });
        },
      );
      let registered = 0;
      for (const c of companies.slice(0, WATCH_REGISTER_LIMIT)) {
        try {
          if (
            !(await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
              companyMayUseExternalProcessing(tx, args.workspaceId, c.id),
            ))
          )
            continue;
          await intentSvc.registerWatch(args.workspaceId, c.id, {
            authorizeExternalAction: authorizeCompanyExternalAction(
              args.workspaceId,
              c.id,
            ),
          });
          registered += 1;
        } catch {
          /* 单家注册失败（无域名/sitemap 不可达/DAT-011）不影响其余 */
        }
      }
      return { candidates: companies.length, registered };
    },

    /**
     * 专利缓存**冷启动预热 enqueue**（scale-safe #89 · 仿 registerWatchesForRun）：对本 run fit=match + 非
     * SUPPRESSED 公司把 (assigneeNorm, country) 排进 `patent_lookup_request`（PENDING）——**populates 刷新队列**，
     * 令第 5 个 Temporal Schedule（patentsCacheRefresh）知道该缓存哪些公司。绝不阻断 run（best-effort、单家失败继续）。
     * 注：专利按**公司名**对齐（非域名），故不筛域名——enqueuePatentLookup 自筛无效锚（纯法人词/空名 no-op）。
     * enqueue = 廉价 upsert（非慢活动/无 BQ 出网），故上限比 web_watch 宽；capped 记 log（不静默截断）。
     * 冷启动时序（首次 contact discovery 早于首刷）由 Step 10 灰度启用的**手跑刷新预热**兜（见设计文档）。
     */
    async enqueuePatentLookupsForRun(args: {
      workspaceId: string;
      runId: string;
      icpId: string;
    }): Promise<{ candidates: number; enqueued: number }> {
      // 🔴 P1-1 kill-switch（Codex PR #93）：google_patents 非 ENABLED（seed=DISABLED，未签 LIA/DPIA）→ 不 enqueue。
      // PII 物化的真正闸在 refreshPatentCache（DISABLED 时不扫）；此处止住队列积压——「DISABLED=不物化」不变式
      // 的前哨（也免翻 ENABLED 瞬间冷启动把历史积压一次性全扫）。data_provider 平台表无 RLS，app_user 有 SELECT。
      const provider = await deps.prisma.dataProvider.findUnique({
        where: { key: PATENT_PROVIDER_KEY },
        select: { status: true },
      });
      if (provider?.status !== "ENABLED") return { candidates: 0, enqueued: 0 };
      const companies = await deps.prisma.withWorkspace(
        args.workspaceId,
        async (tx) => {
          const rawIds = await tx.rawSourceRecord.findMany({
            where: { runId: args.runId },
            select: { id: true },
          });
          const links = await tx.identityLink.findMany({
            where: {
              canonicalType: "company",
              status: "ACTIVE",
              rawRecordId: { in: rawIds.map((r) => r.id) },
            },
            select: { canonicalId: true },
          });
          const ids = await resolveOrganizationRootIds(
            tx,
            args.workspaceId,
            links.map((link) => link.canonicalId),
          );
          return tx.canonicalCompany.findMany({
            where: {
              id: { in: ids },
              status: { not: "SUPPRESSED" },
              identityConflictParties: {
                none: { conflict: { status: { in: ["OPEN", "RESOLVING"] } } },
              },
              leads: { some: { icpId: args.icpId, fitVerdict: "match" } },
            },
            select: { name: true, country: true },
          });
        },
      );
      if (companies.length > PATENT_ENQUEUE_LIMIT) {
        console.warn(
          `[patent-enqueue] run ${args.runId}: ${companies.length} fit=match 超上限 ${PATENT_ENQUEUE_LIMIT}——本轮取前 ${PATENT_ENQUEUE_LIMIT}`,
        );
      }
      let enqueued = 0;
      for (const c of companies.slice(0, PATENT_ENQUEUE_LIMIT)) {
        try {
          const r = await enqueuePatentLookup(deps.prisma, {
            companyName: c.name,
            country: c.country ?? undefined,
          });
          if (r.enqueued) enqueued += 1;
        } catch {
          /* 单家 enqueue 失败（DB 抖动）不影响其余；最终一致靠下一刷新周期 */
        }
      }
      return { candidates: companies.length, enqueued };
    },

    async finalizeRun(args: {
      workspaceId: string;
      runId: string;
      planId: string;
      icpId?: string;
      status: "DONE" | "PARTIAL" | "FAILED";
      stats: Record<string, unknown>;
    }): Promise<void> {
      await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        // Activity completion may be retried after the database commit but
        // before Temporal receives the acknowledgement. Claim the RUNNING ->
        // terminal transition once so retries cannot duplicate completion or
        // qualification events, nor increment the plan twice.
        const completedAt = deps.now?.() ?? new Date();
        const transitioned = await tx.discoveryRun.updateMany({
          where: { id: args.runId, status: "RUNNING", completedAt: null },
          data: {
            status: args.status,
            stats: args.stats as Prisma.InputJsonValue,
            completedAt,
          },
        });
        if (transitioned.count === 0) {
          const existing = await tx.discoveryRun.findUnique({
            where: { id: args.runId },
            select: { status: true, completedAt: true, stats: true },
          });
          if (!existing)
            throw new Error(
              `discovery run ${args.runId} not found during finalization`,
            );
          if (existing.status !== args.status || !existing.completedAt) {
            throw new Error(
              `discovery run ${args.runId} terminal transition conflict (${existing.status} -> ${args.status})`,
            );
          }
          const persistedStats = recordValue(existing.stats);
          if (!persistedStats || !sameJson(persistedStats, args.stats)) {
            throw new Error(
              `discovery run ${args.runId} terminal stats conflict`,
            );
          }
          // A retry can arrive after the run transition committed but before
          // Temporal received the activity acknowledgement. Reconcile the
          // immutable ledger from the persisted parent facts and timestamp;
          // never silently skip a missing contribution or mint a new time.
          await persistProviderQualityContributions(tx as never, {
            workspaceId: args.workspaceId,
            runId: args.runId,
            icpId: args.icpId,
            status: args.status,
            stats: persistedStats,
            completedAt: existing.completedAt,
          });
          return;
        }
        // Immutable provider facts are written in the same transaction as the
        // terminal run transition. The unique run/provider key plus
        // skipDuplicates makes activity retries and concurrent finalizers
        // converge without mutating an earlier fact.
        await persistProviderQualityContributions(tx as never, {
          workspaceId: args.workspaceId,
          runId: args.runId,
          icpId: args.icpId,
          status: args.status,
          stats: args.stats,
          completedAt,
        });
        if (args.status !== "FAILED") {
          await tx.discoveryQueryPlan.update({
            where: { id: args.planId },
            data: { status: "EXECUTED", version: { increment: 1 } },
          });
        }
        await tx.outboxEvent.create({
          data: {
            workspaceId: args.workspaceId,
            eventType: "DiscoveryRunCompleted",
            aggregateType: "DiscoveryRun",
            aggregateId: args.runId,
            payload: {
              planId: args.planId,
              status: args.status,
              stats: args.stats,
            } as Prisma.InputJsonValue,
          },
        });
        // 发现→评分自动衔接：run 完成即请求重评分（relay 启 qualifyWorkflow，重复请求合并到在跑实例）。
        // 之前评分只能人工触发 —— 新公司判了 fit 也进不了 lead 队列，漏斗断在这一步。
        if (args.status !== "FAILED" && args.icpId) {
          await tx.outboxEvent.create({
            data: {
              workspaceId: args.workspaceId,
              eventType: "QualifyRequested",
              aggregateType: "ICP",
              aggregateId: args.icpId,
              payload: {
                reason: "discovery_run_completed",
                runId: args.runId,
              } as Prisma.InputJsonValue,
            },
          });
        }
      });
      budgetLedger.close(args.runId, { force: true }); // 收口② D：run 终点强制关账（run 内多活动各 open 过）
    },
  };
}

export type DiscoveryActivities = ReturnType<typeof createDiscoveryActivities>;
