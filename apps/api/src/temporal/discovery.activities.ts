import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
export function createDiscoveryActivities(deps: {
  prisma: PrismaService;
  providers: DiscoveryProviderRegistry;
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

    /** Waterfall 步骤 3：调用（低成本优先的）发现源，raw 原样落地（幂等 by externalId）。 */
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
      return deps.prisma.withWorkspace(args.workspaceId, async (tx) => {
        const adapters = await deps.providers.routeCompanyDiscovery(tx as never, q.sourceClass);
        if (!adapters.length) return { rawCount: 0, costCents: 0, provider: null };
        const adapter = adapters[0];
        const result = await adapter.discoverCompanies(q);
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
