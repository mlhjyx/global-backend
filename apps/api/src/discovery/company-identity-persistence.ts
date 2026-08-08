import { Prisma } from '@prisma/client';
import {
  companyIdentity,
  normalizeIdentifier,
  normalizeRegistrableDomain,
  resolveCompanyIdentity,
  type CompanyIdentityDecision,
  type CompanyIdentityDecisionContext,
  type CompanyIdentityEvidence,
} from './identity';

export interface AppendCompanyIdentityDecisionEvidenceArgs {
  readonly workspaceId: string;
  readonly entityId: string;
  readonly providerKey: string;
  readonly rawRecordId?: string;
  readonly license: string;
  readonly decision: CompanyIdentityDecision;
}

/**
 * Append-only persistence seam for identity decisions. Canonical attributes are a query
 * projection; this evidence row is the immutable provenance record for replay/review.
 */
export async function appendCompanyIdentityDecisionEvidence(
  tx: Prisma.TransactionClient,
  args: AppendCompanyIdentityDecisionEvidenceArgs,
): Promise<void> {
  await tx.fieldEvidence.create({
    data: {
      workspaceId: args.workspaceId,
      entityType: 'company',
      entityId: args.entityId,
      field: 'identity.resolution_decision',
      value: args.decision as unknown as Prisma.InputJsonValue,
      providerKey: args.providerKey,
      rawRecordId: args.rawRecordId,
      confidence: args.decision.decision === 'AUTO_LINK' ? 1 : 0,
      license: args.license,
      allowedActions: ['display', 'match'] as unknown as Prisma.InputJsonValue,
      dataClass: 'green',
    },
  });
}

export function companyIdentityResolutionProjection(
  decision: CompanyIdentityDecision,
  candidateDedupeKey?: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    decision: decision.decision,
    action: decision.action,
    rule_version: decision.ruleVersion,
    candidate_dedupe_key: candidateDedupeKey ?? decision.identity.dedupeKey,
    recommendation_eligible: decision.recommendationEligible,
    ambiguous: decision.ambiguous,
    reasons: [...decision.reasons],
  });
}

export async function resolveCompanyIdentityForWriter(
  tx: Prisma.TransactionClient,
  args: {
    readonly workspaceId: string;
    readonly incoming: CompanyIdentityEvidence;
    readonly context: CompanyIdentityDecisionContext;
  },
): Promise<{
  decision: CompanyIdentityDecision;
  candidateDedupeKey: string;
  targetExisting: {
    id: string;
    dedupeKey: string;
    name: string;
    domain: string | null;
    country: string | null;
    attributes: Prisma.JsonValue;
    status: string;
  } | null;
}> {
  const legacyIdentity = companyIdentity({
    name: args.incoming.name,
    domain: args.incoming.domain,
    country: args.incoming.country,
    identifier: args.incoming.identifier,
  });
  const candidateKeys = new Set([legacyIdentity.dedupeKey]);
  const registrableDomain = normalizeRegistrableDomain(args.incoming.domain);
  if (registrableDomain) candidateKeys.add(`d:${registrableDomain}`);
  const normalizedIdentifier = normalizeIdentifier(args.incoming.identifier);
  if (normalizedIdentifier) candidateKeys.add(`id:${normalizedIdentifier}`);
  const select = {
    id: true,
    dedupeKey: true,
    name: true,
    domain: true,
    country: true,
    attributes: true,
    status: true,
  } as const;
  const keyedCandidates = await Promise.all(
      [...candidateKeys].map((dedupeKey) =>
        tx.canonicalCompany.findUnique({
          where: { workspaceId_dedupeKey: { workspaceId: args.workspaceId, dedupeKey } },
          select,
        }),
      ),
    );
  const domainCandidates = registrableDomain
    ? await tx.canonicalCompany.findMany({
        where: {
          workspaceId: args.workspaceId,
          OR: [
            { domain: { equals: registrableDomain, mode: 'insensitive' } },
            { domain: { endsWith: `.${registrableDomain}`, mode: 'insensitive' } },
          ],
        },
        select,
        take: 20,
      })
    : [];
  const candidateRows = [...new Map(
    [...keyedCandidates, ...domainCandidates]
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate != null)
      .map((candidate) => [candidate.dedupeKey, candidate]),
  ).values()];
  const decision = resolveCompanyIdentity({
    context: args.context,
    incoming: args.incoming,
    candidates: candidateRows.map((candidate) => {
      const attributes = (candidate.attributes as Record<string, unknown> | null) ?? {};
      return {
        dedupeKey: candidate.dedupeKey,
        name: candidate.name,
        legalName: typeof attributes.legal_name === 'string' ? attributes.legal_name : undefined,
        domain: candidate.domain,
        country: candidate.country,
        sharedGroupAmbiguity: attributes.shared_group_domain === true,
      };
    }),
  });
  const targetExisting = candidateRows.find((candidate) => candidate.dedupeKey === decision.identity.dedupeKey) ??
    await tx.canonicalCompany.findUnique({
      where: {
        workspaceId_dedupeKey: {
          workspaceId: args.workspaceId,
          dedupeKey: decision.identity.dedupeKey,
        },
      },
      select: {
        ...select,
      },
    });
  return {
    decision,
    candidateDedupeKey: companyIdentity({ name: args.incoming.name, country: args.incoming.country }).dedupeKey,
    targetExisting,
  };
}
