import { Prisma } from '@prisma/client';
import { authorityProfileForProvider } from './organization-identity-authority';
import { resolveOrganizationRoot, resolveOrganizationRootIds } from './organization-identity-root';
import {
  identityConflictFingerprint,
  normalizeAuthorityIdentifiers,
  ORGANIZATION_IDENTITY_RESOLVER_VERSION,
  ORGANIZATION_SINGLETON_IDENTIFIER_SCHEMES,
  type NormalizedOrganizationIdentifier,
  type OrganizationIdentifierInput,
} from './organization-identity-v2';
import { normalizeDomain } from './identity';
import { lockWorkspaceOrganizationIdentity } from './organization-identity-root';
import { lockWorkspaceSuppressionPolicy } from './suppression-policy-lock';

type IdentityTx = Prisma.TransactionClient;

export interface EnrichmentIdentifierClaim {
  providerKey: string;
  confidence: number;
  identifiers: readonly OrganizationIdentifierInput[];
  provenance?: { sourceUrl: string; fetchedAt: string; contentHash: string; parserVersion: string };
}

type NormalizedClaim = NormalizedOrganizationIdentifier & {
  providerKey: string;
  confidence: number;
  provenance?: EnrichmentIdentifierClaim['provenance'];
};

export type EnrichmentIdentifierBindingResult =
  | { kind: 'bound'; identifierCount: number }
  | { kind: 'conflict'; conflictId: string };

function normalizedClaims(claims: readonly EnrichmentIdentifierClaim[]): NormalizedClaim[] {
  const byKey = new Map<string, NormalizedClaim>();
  for (const claim of claims) {
    const identifiers = normalizeAuthorityIdentifiers(
      authorityProfileForProvider(claim.providerKey),
      claim.identifiers,
    );
    for (const identifier of identifiers) {
      const candidate: NormalizedClaim = {
        ...identifier,
        providerKey: claim.providerKey,
        confidence: Math.max(0, Math.min(1, claim.confidence)),
        provenance: claim.provenance,
      };
      const prior = byKey.get(identifier.key);
      if (
        !prior ||
        candidate.confidence > prior.confidence ||
        (candidate.confidence === prior.confidence && candidate.providerKey.localeCompare(prior.providerKey) < 0)
      ) {
        byKey.set(identifier.key, candidate);
      }
    }
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

async function createBindingConflict(
  tx: IdentityTx,
  args: {
    workspaceId: string;
    targetRootId: string;
    otherRootIds: readonly string[];
    identifiers: readonly NormalizedClaim[];
    existingIdentifierKeys: readonly string[];
  },
): Promise<string> {
  const companyIds = [...new Set([args.targetRootId, ...args.otherRootIds])].sort();
  const identifierKeys = [...new Set(args.identifiers.map((item) => item.key))].sort();
  const fingerprint = identityConflictFingerprint({
    rawRecordId: 'enrichment:' + args.targetRootId,
    resolverVersion: ORGANIZATION_IDENTITY_RESOLVER_VERSION,
    conflictType: 'binding_conflict',
    companyIds,
    identifierKeys,
  });
  const conflict = await tx.organizationIdentityConflict.upsert({
    where: { workspaceId_fingerprint: { workspaceId: args.workspaceId, fingerprint } },
    update: {},
    create: {
      workspaceId: args.workspaceId,
      rawRecordId: null,
      conflictType: 'binding_conflict',
      fingerprint,
      facts: {
        resolverVersion: ORGANIZATION_IDENTITY_RESOLVER_VERSION,
        source: 'company_enrichment',
        targetRootId: args.targetRootId,
        companyIds,
        identifierKeys,
        existingIdentifierKeys: [...new Set(args.existingIdentifierKeys)].sort(),
        claims: args.identifiers.map((item) => ({
          providerKey: item.providerKey,
          confidence: item.confidence,
          identifierKey: item.key,
          scheme: item.scheme,
          jurisdiction: item.jurisdiction,
          normalizedValue: item.normalizedValue,
          normalizerVersion: item.normalizerVersion,
          validatorVersion: item.validatorVersion,
          provenance: item.provenance ?? null,
        })),
      },
    },
  });
  await tx.organizationIdentityConflictParty.createMany({
    data: companyIds.map((companyId) => ({
      workspaceId: args.workspaceId,
      conflictId: conflict.id,
      companyId,
      role: companyId === args.targetRootId ? 'ENRICHMENT_TARGET' : 'BOUND_CANDIDATE',
    })),
    skipDuplicates: true,
  });
  if (conflict.status !== 'RESOLVED') {
    for (const identifier of args.identifiers) {
      const pending = await tx.organizationIdentifier.findFirst({
        where: {
          workspaceId: args.workspaceId,
          conflictId: conflict.id,
          scheme: identifier.scheme,
          jurisdiction: identifier.jurisdiction,
          normalizedValue: identifier.normalizedValue,
          status: 'PENDING_CONFLICT',
        },
      });
      if (pending) continue;
      await tx.organizationIdentifier.create({
        data: {
          workspaceId: args.workspaceId,
          companyId: args.targetRootId,
          scheme: identifier.scheme,
          jurisdiction: identifier.jurisdiction,
          normalizedValue: identifier.normalizedValue,
          authorityProviderKey: identifier.providerKey,
          rawRecordId: null,
          conflictId: conflict.id,
          confidence: identifier.confidence,
          normalizerVersion: identifier.normalizerVersion,
          validatorVersion: identifier.validatorVersion,
          provenance: identifier.provenance
            ? (identifier.provenance as Prisma.InputJsonValue)
            : undefined,
          status: 'PENDING_CONFLICT',
        },
      });
    }
  }
  return conflict.id;
}

/**
 * Admit identifiers emitted by a confidence-gated enricher into Identity v2.
 * The operation is all-or-nothing: any cross-root or singleton disagreement
 * creates a deterministic review conflict and no identifier is rebound.
 */
export async function bindOrganizationEnrichmentIdentifiers(
  tx: IdentityTx,
  args: {
    workspaceId: string;
    companyId: string;
    claims: readonly EnrichmentIdentifierClaim[];
  },
): Promise<EnrichmentIdentifierBindingResult> {
  await lockWorkspaceSuppressionPolicy(tx, args.workspaceId);
  await lockWorkspaceOrganizationIdentity(tx, args.workspaceId);
  const identifiers = normalizedClaims(args.claims.filter((claim) => claim.identifiers.length > 0));
  if (!identifiers.length) return { kind: 'bound', identifierCount: 0 };

  const identity = await resolveOrganizationRoot(tx, args.workspaceId, args.companyId);
  const lockKeys = [
    ...identifiers.map((identifier) => args.workspaceId + ':identifier:' + identifier.key),
    ...identifiers
      .filter((identifier) => ORGANIZATION_SINGLETON_IDENTIFIER_SCHEMES.has(identifier.scheme))
      .map(
        (identifier) =>
          args.workspaceId + ':company-singleton:' + identity.rootCompanyId + ':' + identifier.scheme + ':' + identifier.jurisdiction,
      ),
  ];
  for (const lockKey of [...new Set(lockKeys)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  }

  const bindings = await tx.organizationIdentifier.findMany({
    where: {
      workspaceId: args.workspaceId,
      status: 'ACTIVE',
      OR: identifiers.map((identifier) => ({
        scheme: identifier.scheme,
        jurisdiction: identifier.jurisdiction,
        normalizedValue: identifier.normalizedValue,
      })),
    },
    select: { id: true, companyId: true, scheme: true, jurisdiction: true, normalizedValue: true },
  });
  const boundRoots = await resolveOrganizationRootIds(
    tx,
    args.workspaceId,
    bindings.map((binding) => binding.companyId),
  );
  const otherRoots = boundRoots.filter((rootId) => rootId !== identity.rootCompanyId);

  // Legacy canonical rows may already carry a domain without an Identity v2
  // identifier. Treat those rows as identity facts during lazy upgrade so a
  // newly enriched domain can never silently bridge two roots.
  const domainClaims = identifiers.filter((identifier) => identifier.scheme === 'domain');
  const claimedDomains = [...new Set(domainClaims.map((identifier) => identifier.normalizedValue))];
  const legacyDomainRows = claimedDomains.length
    ? await tx.$queryRaw<Array<{ id: string; domain: string | null }>>`
        SELECT "id", "domain"
        FROM "canonical_company"
        WHERE "workspace_id" = ${args.workspaceId}::uuid
          AND "domain" IS NOT NULL
          AND NULLIF(
            lower(
              regexp_replace(
                regexp_replace(
                  regexp_replace(btrim("domain"), '^https?://', '', 'i'),
                  '^www\\.', '', 'i'
                ),
                '[/?#].*$', ''
              )
            ),
            ''
          ) IN (${Prisma.join(claimedDomains)})`
    : [];
  const legacyDomainRoots = await resolveOrganizationRootIds(
    tx,
    args.workspaceId,
    legacyDomainRows.map((row) => row.id),
  );
  const otherLegacyRoots = legacyDomainRoots.filter((rootId) => rootId !== identity.rootCompanyId);
  // Before a merge, a different legacy domain on the sole target company is a
  // useful conflict signal. After an explicit merge, aliases legitimately keep
  // their historical display domains: treating every sibling domain as a new
  // disagreement would make the exact reviewed enrichment facts conflict again
  // forever on retry.
  const currentDomainRows = claimedDomains.length && identity.relatedCompanyIds.length === 1
    ? await tx.canonicalCompany.findMany({
        where: { id: { in: identity.relatedCompanyIds }, domain: { not: null } },
        select: { id: true, domain: true },
      })
    : [];
  const legacyDomainDisagreement = currentDomainRows.some((row) => {
    const currentDomain = normalizeDomain(row.domain);
    return !!currentDomain && !claimedDomains.includes(currentDomain);
  });

  const singletonClaims = identifiers.filter((identifier) => ORGANIZATION_SINGLETON_IDENTIFIER_SCHEMES.has(identifier.scheme));
  const existingSingletons = singletonClaims.length
    ? await tx.organizationIdentifier.findMany({
        where: {
          workspaceId: args.workspaceId,
          companyId: { in: identity.relatedCompanyIds },
          status: 'ACTIVE',
          OR: singletonClaims.map((identifier) => ({
            scheme: identifier.scheme,
            jurisdiction: identifier.jurisdiction,
          })),
        },
        select: { scheme: true, jurisdiction: true, normalizedValue: true },
      })
    : [];
  const claimedSingletonValues = new Map<string, Set<string>>();
  for (const identifier of singletonClaims) {
    const scope = identifier.scheme + ':' + identifier.jurisdiction;
    const values = claimedSingletonValues.get(scope) ?? new Set<string>();
    values.add(identifier.normalizedValue);
    claimedSingletonValues.set(scope, values);
  }
  const singletonDisagreement =
    [...claimedSingletonValues.values()].some((values) => values.size > 1) ||
    singletonClaims.some((claim) =>
      existingSingletons.some(
        (existing) =>
          existing.scheme === claim.scheme &&
          existing.jurisdiction === claim.jurisdiction &&
          existing.normalizedValue !== claim.normalizedValue,
      ),
    );

  if (otherRoots.length || otherLegacyRoots.length || singletonDisagreement || legacyDomainDisagreement) {
    const existingIdentifierKeys = existingSingletons.map(
      (item) => item.scheme + ':' + item.jurisdiction + ':' + item.normalizedValue,
    );
    const conflictId = await createBindingConflict(tx, {
      workspaceId: args.workspaceId,
      targetRootId: identity.rootCompanyId,
      otherRootIds: [...new Set([...otherRoots, ...otherLegacyRoots])],
      identifiers,
      existingIdentifierKeys,
    });
    return { kind: 'conflict', conflictId };
  }

  const existingByKey = new Map(
    bindings.map((binding) => [binding.scheme + ':' + binding.jurisdiction + ':' + binding.normalizedValue, binding]),
  );
  for (const identifier of identifiers) {
    const existing = existingByKey.get(identifier.key);
    if (existing) {
      await tx.organizationIdentifier.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date() },
      });
      continue;
    }
    await tx.organizationIdentifier.create({
      data: {
        workspaceId: args.workspaceId,
        companyId: identity.rootCompanyId,
        scheme: identifier.scheme,
        jurisdiction: identifier.jurisdiction,
        normalizedValue: identifier.normalizedValue,
        authorityProviderKey: identifier.providerKey,
        rawRecordId: null,
        confidence: identifier.confidence,
        normalizerVersion: identifier.normalizerVersion,
        validatorVersion: identifier.validatorVersion,
        provenance: identifier.provenance
          ? (identifier.provenance as Prisma.InputJsonValue)
          : undefined,
      },
    });
  }
  return { kind: 'bound', identifierCount: identifiers.length };
}
