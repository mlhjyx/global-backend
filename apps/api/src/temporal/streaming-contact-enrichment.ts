import { stampLawfulBasis } from '../discovery/compliance/email-verification-gate';
import { MAX_RUN_ENRICH_COMPANIES } from '../discovery/execution-envelope';
import type { LawfulBasis } from '../discovery/provider-contract';
import { runBypassStreamingContactEnrichment } from '../enrichment/safety/streaming-contact-enrichment-results';
import type { ContactEnrichmentSafetyService } from '../enrichment/safety/contact-enrichment-safety.service';
import type { ExecutionBudgetBinding } from '../execution-budget/execution-budget-binding';
import { isLegacyExecutionBudgetBypass } from '../execution-budget/legacy-execution-budget-mode';
import type { PrismaService } from '../prisma/prisma.service';
import type { BudgetStore } from '../tools/budget-store';
import { parseConfiguredLawfulBasis } from './backlog.activities';
import { executeContactEnrichmentSafetyActivity } from './contact-enrichment-safety.activity';

/** An explicit malformed setting closes the gate. An absent setting uses the shared provider policy. */
export function resolveStreamingContactDiscoveryLawfulBasis(
  value: string | undefined,
  providerConfig: unknown,
): LawfulBasis | undefined {
  const raw = value?.trim();
  if (!raw) return parseConfiguredLawfulBasis(providerConfig);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    decoded = raw;
  }
  const nested = typeof decoded === 'string' ? { basis: decoded } : decoded;
  return parseConfiguredLawfulBasis(nested) ?? parseConfiguredLawfulBasis({ lawfulBasis: nested });
}

export async function enrichMatchedStreamingCompany(
  deps: {
    prisma: PrismaService;
    budgetStore: BudgetStore;
    safety?: Pick<ContactEnrichmentSafetyService, 'executeRun'>;
  },
  input: {
    workspaceId: string;
    runId: string;
    companyId: string;
    binding: ExecutionBudgetBinding;
    enrichmentSlot?: number;
    providerConfig: unknown;
  },
): Promise<void> {
  const { prisma, budgetStore, safety } = deps;
  const { workspaceId, runId, companyId, binding, enrichmentSlot, providerConfig } = input;
  if (!safety || enrichmentSlot === undefined || !Number.isSafeInteger(enrichmentSlot) ||
      enrichmentSlot < 0 || enrichmentSlot >= MAX_RUN_ENRICH_COMPANIES) return;
  const configured = parseConfiguredLawfulBasis(providerConfig);
  if (!configured) return;
  const scope = { workspaceId, runId, companyId };
  const bypass = isLegacyExecutionBudgetBypass();
  const job = await prisma.withWorkspace(workspaceId, (tx) => tx.discoveryCompanyJob.findFirst({
    where: { workspaceId, runId, canonicalCompanyId: companyId, verdictDeep: 'match', run: { status: 'RUNNING' } },
    select: { contactEnrichmentStatus: true },
  }));
  if (!job || (!bypass && job.contactEnrichmentStatus !== null)) return;
  const execute = async () => {
    const run = await budgetStore.status({ workspaceId: binding.scopeKey, accountKey: binding.accountKey });
    const lawfulBasis = stampLawfulBasis(configured, `discovery-run:${runId}`, new Date().toISOString());
    return executeContactEnrichmentSafetyActivity(safety, { ...scope, binding, lawfulBasis, remainingMicrousd: run.remainingMicrousd });
  };
  if (bypass) {
    await runBypassStreamingContactEnrichment(prisma, scope, execute);
    return;
  }
  await execute();
}
