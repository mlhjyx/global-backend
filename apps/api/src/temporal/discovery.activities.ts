import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import { getTask } from '../ai-tasks/task-registry';
import { DiscoveryProviderRegistry } from '../discovery/provider.registry';
import { CompanyDiscoveryQuery, SourceClass } from '../discovery/provider-contract';
import { companyIdentity } from '../discovery/identity';

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
      const q: CompanyDiscoveryQuery = {
        sourceClass: args.query.source_class as SourceClass,
        filters: args.query.filters ?? {},
        keywords: args.query.keywords ?? [],
        limit: PER_SOURCE_LIMIT,
      };
      // Source Registry（DAT-011）：SUSPENDED 的域名列入黑名单，适配器抓取前跳过。
      // source_policy 是无 RLS 的平台治理表（app_user 有 SELECT）→ 直接读。
      const suspended = await deps.prisma.sourcePolicy.findMany({
        where: { reviewStatus: 'SUSPENDED' },
        select: { domain: true },
      });
      const adapter = (await deps.prisma.withWorkspace(args.workspaceId, (tx) =>
        deps.providers.routeCompanyDiscovery(tx as never, q.sourceClass),
      ))[0];
      if (!adapter) return { rawCount: 0, costCents: 0, provider: null };

      // ── 事务外：真实发现（可能耗时数十秒）──
      const result = await adapter.discoverCompanies(q, { blockedDomains: suspended.map((s) => s.domain) });

      // ── 事务内：持久化 raw（带公开采集留痕）──
      return deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        let rawCount = 0;
        for (const rec of result.records) {
          try {
            await tx.rawSourceRecord.create({
              data: {
                workspaceId: args.workspaceId,
                runId: args.runId,
                providerKey: adapter.key,
                sourceClass: q.sourceClass,
                externalId: rec.externalId,
                payload: rec as unknown as Prisma.InputJsonValue,
                sourceUrl: rec.provenance?.sourceUrl ?? null,
                fetchedAt: rec.provenance ? new Date(rec.provenance.fetchedAt) : null,
                contentHash: rec.provenance?.contentHash ?? null,
                parserVersion: rec.provenance?.parserVersion ?? null,
                costCents: 0,
              },
            });
            rawCount += 1;
          } catch (err) {
            if ((err as { code?: string }).code === 'P2002') continue; // 幂等：重试已写过
            throw err;
          }
        }
        if (result.costCents > 0) {
          await tx.usageLedger.create({
            data: {
              workspaceId: args.workspaceId,
              resourceType: 'provider_call',
              quantity: result.records.length,
              costUsd: result.costCents / 100,
              refType: 'discovery_run',
              refId: args.runId,
              meta: { provider: adapter.key, sourceClass: q.sourceClass },
            },
          });
        }
        return { rawCount, costCents: result.costCents, provider: adapter.key };
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
