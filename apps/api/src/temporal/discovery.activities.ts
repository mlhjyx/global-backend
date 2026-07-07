import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import { getTask } from '../ai-tasks/task-registry';
import { DiscoveryProviderRegistry } from '../discovery/provider.registry';
import { CompanyDiscoveryQuery, EnrichmentResult, SourceClass } from '../discovery/provider-contract';
import { companyIdentity } from '../discovery/identity';
import { TaxonomyResolver } from '../discovery/taxonomy-resolver';
import { IntentProjectionService } from '../intent/intent-projection.service';

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
}

const PER_SOURCE_LIMIT = 25; // sandbox 阶段每源上限；真源接入后由预算/配额驱动（PRD 7.4.8）
const ENRICH_LIMIT = 50; // 单 run 富集上限（护栏；GLEIF 限流）
const SIGNAL_ENRICH_LIMIT = 12; // 信号富集慢（抓官网/sitemap），单 run 上限更小；配长活动 + heartbeat
const SIGNAL_TTL_MS = 7 * 24 * 3600 * 1000; // 信号时变 → 7 天 TTL 刷新（非 GLEIF/Wikidata 那种一次写死）
const WATCH_REGISTER_LIMIT = 12; // 单 run 自动注册网站监控上限（每家一次 sitemap 探测，慢）

/**
 * Discover 阶段活动（PRD 5.5 / 8.7 流水线）：
 * 计划 → Provider 调用 → Raw Zone 原样落地 → 归一 + 身份解析 → Canonical +
 * FieldEvidence + IdentityLink → Suppression 标记 → 成本入账。
 */
interface FitOutput {
  verdict: string;
  material_gate: string;
  role_gate: string;
  process_gate: string;
  business_model_gate: string;
  reasons: string[];
}

export function createDiscoveryActivities(deps: {
  prisma: PrismaService;
  providers: DiscoveryProviderRegistry;
  gateway: ModelGateway;
  taxonomy?: TaxonomyResolver;
}) {
  return {
    async loadPlanQueries(args: { workspaceId: string; planId: string }): Promise<{ queries: PlanQuery[] }> {
      return deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const plan = await tx.discoveryQueryPlan.findUnique({ where: { id: args.planId } });
        if (!plan) throw new Error(`query plan ${args.planId} not found`);
        if (!['READY', 'EXECUTED'].includes(plan.status)) {
          throw new Error(`query plan is ${plan.status}; must be READY (human-confirmed) before execution`);
        }
        const queries = (plan.queries as unknown as PlanQuery[]) ?? [];
        return { queries: [...queries].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)) };
      });
    },

    /**
     * Waterfall 步骤 3：调用（低成本优先的）发现源，raw 原样落地（幂等 by externalId）。
     * 网络调用（搜索/爬取/LLM）在事务外完成，结果才进事务持久化——避免长事务。
     */
    async executeQuery(args: {
      workspaceId: string;
      runId: string;
      query: PlanQuery;
    }): Promise<{ rawCount: number; costCents: number; provider: string | null }> {
      // 词表归一（冷路径，docs/backend/vocab-taxonomy.md）：把 filters 里的行业/国家
      // 自由词（中/英/德）归一到规范节点，注入 resolved 码供各源精确路由。
      // 未接 resolver 或未命中时，provider 回退到内置 vocab.ts。
      const enriched: Record<string, unknown> = { ...(args.query.filters ?? {}) };
      if (deps.taxonomy) {
        const industryTerms = [enriched.industry, enriched.sub_industry].flat().filter(Boolean).map(String);
        const countryTerms = [enriched.country, enriched.region].flat().filter(Boolean).map(String);
        const inds = await deps.taxonomy.resolveMany('industry', industryTerms, { workspaceId: args.workspaceId });
        if (inds.length) {
          enriched._industryQids = inds.map((n) => n.wikidataQid).filter(Boolean);
          enriched._osmTags = inds.flatMap((n) => n.osmTags ?? []);
          enriched._industryCodes = inds.map((n) => n.code);
        }
        for (const ct of countryTerms) {
          const c = await deps.taxonomy.resolve('country', ct, { workspaceId: args.workspaceId });
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
        limit: PER_SOURCE_LIMIT,
      };
      // Source Registry（DAT-011）：SUSPENDED 的域名列入黑名单，适配器抓取前跳过。
      // source_policy 是无 RLS 的平台治理表（app_user 有 SELECT）→ 直接读。
      const suspended = await deps.prisma.sourcePolicy.findMany({
        where: { reviewStatus: 'SUSPENDED' },
        select: { domain: true },
      });
      // 多源 fan-out：该 source_class 下**全部 ENABLED 适配器**并行召回（蓝图集成点 1）。
      // 可选 source_hint 收窄到具体子源；否则全跑，统一进 raw → canonicalize 去重归并。
      const hint = (args.query.filters?.source_hint as string | undefined)?.toLowerCase();
      let adapters = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        deps.providers.routeCompanyDiscovery(tx as never, q.sourceClass),
      );
      if (hint) adapters = adapters.filter((a) => a.key === hint || a.key.includes(hint));
      if (!adapters.length) return { rawCount: 0, costCents: 0, provider: null };

      // ── 事务外：各源真实发现（可能耗时数十秒），单源失败不影响其余 ──
      const blockedDomains = suspended.map((s) => s.domain);
      const settled = await Promise.allSettled(
        adapters.map((a) => a.discoverCompanies(q, { blockedDomains }).then((r) => ({ key: a.key, r }))),
      );

      // ── 事务内：持久化各源 raw（带来源留痕），providerKey 区分来源 ──
      // 用 createMany({skipDuplicates}) 单语句写入：撞唯一键会被跳过而非 abort 事务
      // （Postgres 里 catch 单条 P2002 会毒化整个事务）。批内先按 externalId 去重。
      return deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        let rawCount = 0;
        let totalCost = 0;
        const providersHit: string[] = [];
        for (const s of settled) {
          if (s.status !== 'fulfilled') continue;
          const { key, r } = s.value;
          if (r.records.length) providersHit.push(key);
          const seen = new Set<string>();
          const rows = r.records
            .filter((rec) => {
              const k = rec.externalId ?? JSON.stringify(rec);
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            })
            .map((rec) => ({
              workspaceId: args.workspaceId,
              runId: args.runId,
              providerKey: key,
              sourceClass: q.sourceClass,
              externalId: rec.externalId,
              payload: rec as unknown as Prisma.InputJsonValue,
              sourceUrl: rec.provenance?.sourceUrl ?? null,
              fetchedAt: rec.provenance ? new Date(rec.provenance.fetchedAt) : null,
              contentHash: rec.provenance?.contentHash ?? null,
              parserVersion: rec.provenance?.parserVersion ?? null,
              costCents: 0,
            }));
          if (rows.length) {
            const created = await tx.rawSourceRecord.createMany({ data: rows, skipDuplicates: true });
            rawCount += created.count;
          }
          totalCost += r.costCents;
        }
        if (totalCost > 0) {
          await tx.usageLedger.create({
            data: {
              workspaceId: args.workspaceId,
              resourceType: 'provider_call',
              quantity: rawCount,
              costUsd: totalCost / 100,
              refType: 'discovery_run',
              refId: args.runId,
              meta: { providers: providersHit, sourceClass: q.sourceClass },
            },
          });
        }
        return { rawCount, costCents: totalCost, provider: providersHit.join('+') || null };
      });
    },

    /**
     * 归一 + 身份解析（PRD 8.8）+ 字段级 Evidence（8.10）+ Suppression 标记。
     * 幂等：canonical 按 dedupeKey upsert；identity_link 按 (canonical,raw) 去重。
     */
    async canonicalizeRun(args: {
      workspaceId: string;
      runId: string;
    }): Promise<{ companies: number; suppressed: number }> {
      return deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const raws = await tx.rawSourceRecord.findMany({ where: { runId: args.runId } });
        const suppressions = await tx.suppressionRecord.findMany({
          where: { type: { in: ['domain', 'company_name'] } },
        });
        const suppressedDomains = new Set(
          suppressions.filter((s) => s.type === 'domain').map((s) => s.value.toLowerCase()),
        );
        const suppressedNames = new Set(
          suppressions.filter((s) => s.type === 'company_name').map((s) => s.value.toLowerCase()),
        );

        let companies = 0;
        let suppressed = 0;
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
          };
          if (!rec.name) continue;
          const identity = companyIdentity({ name: rec.name, domain: rec.domain, country: rec.country });
          const isSuppressed =
            (rec.domain && suppressedDomains.has(rec.domain.toLowerCase())) ||
            suppressedNames.has(rec.name.toLowerCase());

          const canonical = await tx.canonicalCompany.upsert({
            where: { workspaceId_dedupeKey: { workspaceId: args.workspaceId, dedupeKey: identity.dedupeKey } },
            update: {
              // 后到的源只补缺，不覆盖已有值（冲突留在 field_evidence 里可见）
              ...(rec.region ? { region: { set: rec.region } } : {}),
              status: isSuppressed ? 'SUPPRESSED' : undefined,
              version: { increment: 1 },
            },
            create: {
              workspaceId: args.workspaceId,
              name: rec.name,
              domain: rec.domain ?? null,
              country: rec.country ?? null,
              region: rec.region ?? null,
              industry: rec.industry ?? null,
              employeeCount: rec.employeeCount ?? null,
              revenueUsd: rec.revenueUsd ?? null,
              attributes: (rec.attributes ?? undefined) as never,
              status: isSuppressed ? 'SUPPRESSED' : 'NEW',
              dedupeKey: identity.dedupeKey,
            },
          });
          if (isSuppressed) suppressed += 1;
          companies += 1;

          const linkExists = await tx.identityLink.findFirst({
            where: { canonicalId: canonical.id, rawRecordId: raw.id },
            select: { id: true },
          });
          if (!linkExists) {
            await tx.identityLink.create({
              data: {
                workspaceId: args.workspaceId,
                canonicalType: 'company',
                canonicalId: canonical.id,
                rawRecordId: raw.id,
                matchRule: identity.matchRule,
                confidence: identity.matchRule === 'domain_exact' ? 1 : 0.8,
              },
            });
            // 字段级 Evidence：该 raw 记录贡献的每个非空字段留痕
            const fields: [string, unknown][] = [
              ['name', rec.name],
              ['domain', rec.domain],
              ['country', rec.country],
              ['region', rec.region],
              ['industry', rec.industry],
              ['employee_count', rec.employeeCount],
              ['revenue_usd', rec.revenueUsd],
              ['attributes', rec.attributes],
            ];
            for (const [field, value] of fields) {
              if (value == null) continue;
              await tx.fieldEvidence.create({
                data: {
                  workspaceId: args.workspaceId,
                  entityType: 'company',
                  entityId: canonical.id,
                  field,
                  value: value as Prisma.InputJsonValue,
                  providerKey: raw.providerKey,
                  rawRecordId: raw.id,
                  license: raw.providerKey === 'sandbox' ? 'sandbox' : 'licensed',
                  allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
                },
              });
            }
          }
        }
        return { companies, suppressed };
      });
    },

    /**
     * ICP 资格门（发现评测驱动，PRD 5.6 前置）：对本次 run 归一出的、尚未判定的
     * canonical 公司逐家跑四门判别（材质/角色/工艺/商业模式），写 fit_verdict。
     * 召回与资格分离——挖掘负责"是不是真公司"，这里负责"是不是该 ICP 的客户"。
     * 网络调用在事务外，落库在事务内。
     */
    async qualifyFitForRun(args: {
      workspaceId: string;
      runId: string;
      icpId: string;
    }): Promise<{ judged: number; verdicts: Record<string, number> }> {
      // ICP 摘要 + 本 run 待判公司（事务内只读，快）
      const { icpBrief, companies } = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const icp = await tx.icpDefinition.findUnique({
          where: { id: args.icpId },
          include: { company: true },
        });
        const rawIds = await tx.rawSourceRecord.findMany({
          where: { runId: args.runId },
          select: { id: true },
        });
        const links = await tx.identityLink.findMany({
          where: { canonicalType: 'company', rawRecordId: { in: rawIds.map((r) => r.id) } },
          select: { canonicalId: true },
        });
        const ids = [...new Set(links.map((l) => l.canonicalId))];
        const companies = await tx.canonicalCompany.findMany({
          where: { id: { in: ids }, fitVerdict: null, status: { not: 'SUPPRESSED' } },
          select: { id: true, name: true, domain: true, country: true, industry: true, attributes: true },
        });
        const icpBrief = icp
          ? {
              seller: icp.company?.name ?? 'unknown',
              seller_summary: icp.company?.summary ?? null,
              icp_name: icp.name,
              company_attributes: icp.companyAttributes,
              exclusions: icp.exclusions,
              target_markets: icp.targetMarkets,
            }
          : {};
        return { icpBrief, companies };
      });

      const contract = getTask('discovery.qualify_fit')!;
      const verdicts: Record<string, number> = { match: 0, weak: 0, mismatch: 0 };
      let judged = 0;

      // 逐家判别（事务外，可并发但这里顺序以控成本/限流）
      for (const c of companies) {
        const products = (c.attributes as { products?: string[] } | null)?.products ?? [];
        let out: FitOutput;
        try {
          const result = await deps.gateway.generateStructured<FitOutput>(
            {
              task: contract.id,
              prompt: `卖方 ICP：\n${JSON.stringify(icpBrief, null, 2)}\n\n候选公司：\n${JSON.stringify(
                { name: c.name, domain: c.domain, country: c.country, industry: c.industry, products },
                null,
                2,
              )}\n\n判断该候选是否为卖方的真实目标客户，输出中文理由。`,
              system: contract.description,
              model: contract.model,
              schema: contract.outputSchema,
            },
            { workspaceId: args.workspaceId },
          );
          out = result.data;
        } catch {
          continue; // 单家判别失败不影响其余
        }
        const verdict = ['match', 'weak', 'mismatch'].includes(out.verdict) ? out.verdict : 'weak';
        verdicts[verdict] += 1;
        judged += 1;
        await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
          tx.canonicalCompany.update({
            where: { id: c.id },
            data: {
              fitVerdict: verdict,
              fitReasons: {
                material: out.material_gate,
                role: out.role_gate,
                process: out.process_gate,
                business_model: out.business_model_gate,
                reasons: out.reasons,
              } as unknown as Prisma.InputJsonValue,
              status: verdict === 'match' ? 'ENRICHED' : undefined,
            },
          }),
        );
      }
      return { judged, verdicts };
    },

    /**
     * 富集（Waterfall 富化段，PRD 7.4.7/7.4.8）：只对通过 ICP 资格门的高价值公司
     * （fitVerdict=match）补结构化事实 —— 多个富集源**互补并跑**：
     *   GLEIF = 法律身份（LEI/法人形式/母子关系）；Wikidata = 商业事实（行业/产品/财务/官网）。
     * 「贵操作只给会跟进的线索」；各源零成本但受限流，故限量。
     * 幂等：按 enricher key 命名空间存 attributes，已有该源命名空间则跳过（重跑不重复写证据）。
     * 网络调用在事务外，每家命中后单独落库（attributes 命名空间合并 + 逐字段 field_evidence）。
     */
    async enrichRun(args: {
      workspaceId: string;
      runId: string;
    }): Promise<{ enriched: number; matched: number; provider: string | null }> {
      const enrichers = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        deps.providers.routeEnrichment(tx as never),
      );
      if (!enrichers.length) return { enriched: 0, matched: 0, provider: null };

      // 本 run 归一出、且过了 fit 门的公司
      const companies = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const rawIds = await tx.rawSourceRecord.findMany({
          where: { runId: args.runId },
          select: { id: true },
        });
        const links = await tx.identityLink.findMany({
          where: { canonicalType: 'company', rawRecordId: { in: rawIds.map((r) => r.id) } },
          select: { canonicalId: true },
        });
        const ids = [...new Set(links.map((l) => l.canonicalId))];
        return tx.canonicalCompany.findMany({
          where: { id: { in: ids }, fitVerdict: 'match', status: { not: 'SUPPRESSED' } },
          select: { id: true, name: true, domain: true, country: true, region: true, attributes: true },
        });
      });

      const providersHit = new Set<string>();
      let enriched = 0;
      let matched = 0;
      for (const c of companies.slice(0, ENRICH_LIMIT)) {
        const existing = ((c.attributes as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
        // 所有 enricher 互补并跑；已有该源命名空间的跳过（幂等）
        const hits: { key: string; result: EnrichmentResult }[] = [];
        for (const e of enrichers) {
          if (existing[e.key]) continue; // 该源已富集过 → 跳过（重跑不重复写）
          try {
            const r = await e.enrichCompany({
              name: c.name,
              domain: c.domain ?? undefined,
              country: c.country ?? undefined,
              region: c.region ?? undefined,
            });
            if (r.matched) hits.push({ key: e.key, result: r });
          } catch {
            // 单富集源失败不影响其余
          }
        }
        enriched += 1;
        if (!hits.length) continue;
        matched += 1;
        hits.forEach((h) => providersHit.add(h.key));

        await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          // attributes 按 enricher key 命名空间合并（attributes.gleif.* / attributes.wikidata.*）
          const merged: Record<string, unknown> = { ...existing };
          for (const h of hits) merged[h.key] = h.result.attributes;
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
                  license: 'public', // GLEIF / Wikidata 均为 CC0 公共领域
                  allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
                  ...(h.result.provenance ? { fetchedAt: new Date(h.result.provenance.fetchedAt) } : {}),
                },
              });
            }
          }
        });
      }
      return { enriched, matched, provider: providersHit.size ? [...providersHit].join('+') : null };
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
    }): Promise<{ enriched: number; matched: number; provider: string | null }> {
      const enrichers = await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        deps.providers.routeSignalEnrichment(tx as never),
      );
      if (!enrichers.length) return { enriched: 0, matched: 0, provider: null };

      // DAT-011：SUSPENDED 域名黑名单（平台级 source_policy，富集侧同样遵守 —— 富集也会抓这些域名）
      const suspended = new Set(
        (await deps.prisma.sourcePolicy.findMany({ where: { reviewStatus: 'SUSPENDED' }, select: { domain: true } })).map(
          (s) => s.domain.toLowerCase(),
        ),
      );

      const companies = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const rawIds = await tx.rawSourceRecord.findMany({ where: { runId: args.runId }, select: { id: true } });
        const links = await tx.identityLink.findMany({
          where: { canonicalType: 'company', rawRecordId: { in: rawIds.map((r) => r.id) } },
          select: { canonicalId: true },
        });
        const ids = [...new Set(links.map((l) => l.canonicalId))];
        return tx.canonicalCompany.findMany({
          where: { id: { in: ids }, fitVerdict: 'match', status: { not: 'SUPPRESSED' }, domain: { not: null } },
          select: { id: true, name: true, domain: true, country: true, region: true, attributes: true },
        });
      });

      const providersHit = new Set<string>();
      let enriched = 0;
      let matched = 0;
      const nowMs = Date.now();
      for (const c of companies.slice(0, SIGNAL_ENRICH_LIMIT)) {
        if (c.domain && suspended.has(c.domain.toLowerCase())) continue; // DAT-011：富集侧跳过 SUSPENDED

        const existing = ((c.attributes as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
        const hits: { key: string; result: EnrichmentResult }[] = [];
        for (const e of enrichers) {
          const prev = existing[e.key] as { _ts?: string } | undefined;
          if (prev?._ts && nowMs - Date.parse(prev._ts) < SIGNAL_TTL_MS) continue; // TTL 新鲜 → 跳过（不刷）
          try {
            const r = await e.enrichCompany({
              name: c.name,
              domain: c.domain ?? undefined,
              country: c.country ?? undefined,
              region: c.region ?? undefined,
            });
            if (r.matched) hits.push({ key: e.key, result: r });
          } catch {
            /* 单信号源失败不影响其余 */
          }
        }
        enriched += 1;
        if (!hits.length) continue;
        matched += 1;
        hits.forEach((h) => providersHit.add(h.key));

        await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
          const merged: Record<string, unknown> = { ...existing };
          // 命名空间存入并盖 _ts（供下次 TTL 判新鲜）
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
      return { enriched, matched, provider: providersHit.size ? [...providersHit].join('+') : null };
    },

    /**
     * 从 ICP 短名单自动注册网站变更监控（#4 loop 收口）：对本 run 归一出的 **fit=match + 有域名**公司
     * （与 enrichSignalsRun 同口径）建平台级 web_watch monitored_source（dedup by 域名，sitemap 推监控页），
     * 交给独立 intentSweep 持续盯产品/招聘/供应商招募/新闻页变更 → intent 事件 → 投影进 attributes.intent.*。
     * 慢（每家一次 sitemap 探测）→ 走长活动；best-effort，单家失败不影响其余与 run 状态。
     */
    async registerWatchesForRun(args: { workspaceId: string; runId: string }): Promise<{ candidates: number; registered: number }> {
      const intentSvc = new IntentProjectionService({ prisma: deps.prisma });
      const companies = await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const rawIds = await tx.rawSourceRecord.findMany({ where: { runId: args.runId }, select: { id: true } });
        const links = await tx.identityLink.findMany({
          where: { canonicalType: 'company', rawRecordId: { in: rawIds.map((r) => r.id) } },
          select: { canonicalId: true },
        });
        const ids = [...new Set(links.map((l) => l.canonicalId))];
        return tx.canonicalCompany.findMany({
          where: { id: { in: ids }, fitVerdict: 'match', status: { not: 'SUPPRESSED' }, domain: { not: null } },
          select: { id: true },
        });
      });
      let registered = 0;
      for (const c of companies.slice(0, WATCH_REGISTER_LIMIT)) {
        try {
          await intentSvc.registerWatch(args.workspaceId, c.id);
          registered += 1;
        } catch {
          /* 单家注册失败（无域名/sitemap 不可达/DAT-011）不影响其余 */
        }
      }
      return { candidates: companies.length, registered };
    },

    async finalizeRun(args: {
      workspaceId: string;
      runId: string;
      planId: string;
      status: 'DONE' | 'PARTIAL' | 'FAILED';
      stats: Record<string, unknown>;
    }): Promise<void> {
      await deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        await tx.discoveryRun.update({
          where: { id: args.runId },
          data: {
            status: args.status,
            stats: args.stats as Prisma.InputJsonValue,
            completedAt: new Date(),
          },
        });
        if (args.status !== 'FAILED') {
          await tx.discoveryQueryPlan.update({
            where: { id: args.planId },
            data: { status: 'EXECUTED', version: { increment: 1 } },
          });
        }
        await tx.outboxEvent.create({
          data: {
            workspaceId: args.workspaceId,
            eventType: 'DiscoveryRunCompleted',
            aggregateType: 'DiscoveryRun',
            aggregateId: args.runId,
            payload: { planId: args.planId, status: args.status, stats: args.stats } as Prisma.InputJsonValue,
          },
        });
      });
    },
  };
}

export type DiscoveryActivities = ReturnType<typeof createDiscoveryActivities>;
