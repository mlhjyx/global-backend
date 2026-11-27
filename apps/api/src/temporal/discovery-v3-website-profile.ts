import { commitCompanyEnrichmentResults } from '../discovery/company-enrichment-commit';
import { companyMayUseExternalProcessing } from '../discovery/company-suppression-gate';
import { withDiscoveryV3OperationScope, type DiscoveryV3ResultLink } from '../discovery/discovery-v3-operation-scope';
import { discoveryV3Digest, type DiscoveryV3OperationStore } from '../discovery/discovery-v3-operations';
import { normalizeDomain } from '../discovery/identity';
import { WebsiteProfileProvider, WEBSITE_PROFILE_PARSER_MARKER, WEBSITE_PROFILE_PARSER_VERSION,
  WEBSITE_PROFILE_PROVIDER_KEY } from '../discovery/providers/website-profile.provider';
import { targetCountryCodes } from '../discovery/search-localization';
import type { PrismaService } from '../prisma/prisma.service';
import type { DiscoveryV3Dispatch } from '../runtime/discovery-v3-dispatch-contract';
import type { ModelGateway } from '../model-gateway/model-gateway';
import type { RuntimeTelemetry } from '../model-runtime/types';
import type { ExecutionBroker } from '../tools/tool-contract';
import { icpProductContext, websiteProfileEnrichment, websiteProfileFreshAndCurrent } from './discovery.activities';

export function createDiscoveryV3WebsiteProfile(deps: {
  prisma: Pick<PrismaService, 'withWorkspace'>;
  operationStore: DiscoveryV3OperationStore;
  gateway: ModelGateway;
  broker: ExecutionBroker;
  runtimeTelemetry?: RuntimeTelemetry;
}) {
  const { prisma, operationStore } = deps;
  const provider = new WebsiteProfileProvider(deps);
  return async (command: DiscoveryV3Dispatch, companyId: string, signal: AbortSignal, workerAttempt: number): Promise<boolean> => {
    const material = await prisma.withWorkspace(command.workspaceId, async (tx) => {
      const company = await tx.canonicalCompany.findUnique({ where: { id: companyId, workspaceId: command.workspaceId } });
      const icp = await tx.icpDefinition.findUnique({ where: { id: command.icpId, workspaceId: command.workspaceId } });
      return company && icp ? { company, icp } : null;
    });
    if (!material?.company.domain) return false;
    const { company, icp } = material;
    const expectedDomain = material.company.domain;
    const enabledAndAllowed = () => prisma.withWorkspace(command.workspaceId, async (tx) => {
      const enabled = await tx.dataProvider.findUnique({ where: { key: WEBSITE_PROFILE_PROVIDER_KEY }, select: { status: true } });
      if (enabled?.status !== 'ENABLED' || !await companyMayUseExternalProcessing(tx, command.workspaceId, companyId)) return false;
      return Boolean(await tx.canonicalCompany.findFirst({
        where: { id: companyId, workspaceId: command.workspaceId, domain: expectedDomain }, select: { id: true },
      }));
    });
    if (!await enabledAndAllowed()) return false;
    if (websiteProfileForDomain(company.attributes, expectedDomain) && websiteProfileFreshAndCurrent(company.attributes, false, Date.now())) return true;
    const homeCountry = targetCountryCodes({ filters: { country: company.country } })[0] ??
      targetCountryCodes({ filters: { country: icp.targetMarkets } })[0] ?? '';
    const receipts: DiscoveryV3ResultLink[] = [];
    const profile = await withDiscoveryV3OperationScope({
      command, store: operationStore, step: `profile/${companyId}`, signal, workerAttempt,
      onResult: (receipt) => receipts.push(receipt),
    }, () => provider.profile({ domain: expectedDomain, homeCountry, icpContext: icpProductContext(icp.companyAttributes) }, {
      workspaceId: command.workspaceId, runId: command.runId, correlationId: companyId,
      authorizeExternalAction: enabledAndAllowed, artifactSubject: { subjectType: 'company', subjectId: companyId },
    }));
    signal.throwIfAborted();
    if (!receipts.length) return false;
    const consumer = discoveryV3Digest(['discovery-v3/website-profile', command.requestSha256, companyId]);
    return await operationStore.acknowledgeBatch(command, receipts, consumer, async (tx) => {
      if (!profile || normalizeDomain(profile.impressumUrl ?? profile.homepageUrl) !== normalizeDomain(expectedDomain)) return false;
      const observedAt = new Date();
      return commitCompanyEnrichmentResults(tx, {
        workspaceId: command.workspaceId, companyId, signalTimestamp: observedAt,
        expectedDomain,
        hits: [{ key: WEBSITE_PROFILE_PROVIDER_KEY, result: websiteProfileEnrichment(profile, observedAt) }],
        namespaceMarkers: { [WEBSITE_PROFILE_PARSER_MARKER]: WEBSITE_PROFILE_PARSER_VERSION },
      });
    }, workerAttempt) === true;
  };
}

function websiteProfileForDomain(attributes: unknown, companyDomain: string | null): Record<string, unknown> | undefined {
  const profile = (attributes as { website_profile?: Record<string, unknown> } | null)?.website_profile;
  const domain = normalizeDomain(companyDomain);
  return domain && typeof profile?.source_url === 'string' && normalizeDomain(profile.source_url) === domain ? profile : undefined;
}

export function discoveryV3WebsiteFitEvidence(attributes: unknown, companyDomain: string | null): string {
  const profile = websiteProfileForDomain(attributes, companyDomain);
  if (!profile) return '';
  const evidence = Array.isArray(profile.evidence) ? profile.evidence.filter((item): item is string => typeof item === 'string') : [];
  const role = typeof profile.trade_role === 'string' ? profile.trade_role : null;
  return [...(role ? [`Registered website trade role: ${role}`] : []), ...evidence].join('\n');
}
