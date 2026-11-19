import type { Prisma } from '@prisma/client';
import { governingPolicy } from '../raw-source-ingestion';
import { readBuyerScenarioFromPlan } from '../buyer-procurement-scenarios';
import { companyProjectPageUrl, readProjectPageEvidence } from './project-page-evidence';

interface ProjectPageScope {
  workspaceId: string;
  runId: string;
  icpId: string;
  companyId: string;
  domain: string;
  now: Date;
}

/** Only an active source already accepted and linked to this company in the same run. */
export async function loadRunProjectPage(tx: Prisma.TransactionClient, scope: ProjectPageScope): Promise<string | undefined> {
  const { workspaceId, runId, icpId, companyId, domain, now } = scope;
  const run = await tx.discoveryRun.findFirst({ where: { id: runId, workspaceId, icpId }, select: { planId: true } });
  if (!run) return undefined;
  const plan = await tx.discoveryQueryPlan.findFirst({
    where: { id: run.planId, workspaceId, icpId }, select: { queries: true },
  });
  const scene = readBuyerScenarioFromPlan(plan?.queries);
  if (scene !== 'factory_direct' && scene !== 'equipment_integration') return undefined;
  const candidates = await tx.discoveryCompanyMaterializationOutcome.findMany({
    where: { workspaceId, runId, canonicalCompanyId: companyId, providerKey: 'public_web', outcome: 'CANONICALIZED',
      queryItem: { rawRecord: {
        workspaceId, runId, providerKey: 'public_web', externalId: domain, ingestStatus: 'ACCEPTED',
        expiredAt: null, expiresAt: { gt: now }, sourceUrl: { not: null },
      } },
    },
    orderBy: [{ queryOrdinal: 'asc' }, { recordIndex: 'asc' }, { queryItemId: 'asc' }],
    take: 12,
    select: { queryItem: { select: { rawRecord: { select: { sourceUrl: true, sourcePolicySnapshot: true } } } } },
  });
  const usable = candidates.flatMap(({ queryItem: { rawRecord } }) => {
    const url = companyProjectPageUrl(rawRecord.sourceUrl, domain);
    const policyId = (rawRecord.sourcePolicySnapshot as { id?: string } | null)?.id;
    return url && typeof policyId === 'string' ? [{ url, policyId }] : [];
  });
  if (!usable.length) return undefined;
  // Apply the existing ingestion precedence: a newly blocked site overrides a historical
  // generic policy. Require the current governing policy to be the recorded policy too.
  const policies = await tx.sourcePolicy.findMany({
    select: { id: true, domain: true, reviewStatus: true, allowedPurpose: true, retentionDays: true, updatedAt: true },
  });
  for (const { url, policyId } of usable) {
    const host = new URL(url).hostname;
    const policy = governingPolicy({ host, hostname: host.replace(/^www\./u, '') }, 'public_web', domain, policies);
    if (policy?.id === policyId && policy.reviewStatus === 'APPROVED' && Array.isArray(policy.allowedPurpose) &&
        policy.allowedPurpose.includes('enrichment')) return url;
  }
  return undefined;
}

/** A previous run's project page is not evidence for a run that could not read that source. */
export function scopeRunProjectEvidence(attributes: unknown, projectUrl: string | undefined): unknown {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return attributes;
  const { website_profile, ...rest } = attributes as Record<string, unknown>;
  if (!website_profile || typeof website_profile !== 'object' || Array.isArray(website_profile)) return attributes;
  const { project_evidence, ...profile } = website_profile as Record<string, unknown>;
  if (!project_evidence || (projectUrl && readProjectPageEvidence(project_evidence)?.source_url === projectUrl)) return attributes;
  return { ...rest, website_profile: profile };
}
