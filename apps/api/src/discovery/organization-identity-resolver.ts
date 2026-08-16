import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { companyIdentity } from './identity';
import { authorityProfileForProvider } from './organization-identity-authority';
import { lockWorkspaceOrganizationIdentity, resolveOrganizationRoot } from './organization-identity-root';
import {
  identityConflictFingerprint,
  normalizeAuthorityIdentifiers,
  ORGANIZATION_IDENTITY_RESOLVER_VERSION,
  ORGANIZATION_SINGLETON_IDENTIFIER_SCHEMES,
  planOrganizationIdentityResolution,
  type NormalizedOrganizationIdentifier,
  type OrganizationIdentityConflictType,
  type OrganizationIdentifierInput,
} from './organization-identity-v2';

type IdentityTx = Prisma.TransactionClient;

export interface OrganizationIdentityRecord {
  name: string;
  domain?: string;
  country?: string;
  region?: string;
  industry?: string;
  employeeCount?: number;
  revenueUsd?: number;
  attributes?: Record<string, unknown>;
  identifier?: OrganizationIdentifierInput;
  identifiers?: OrganizationIdentifierInput[];
}

export type OrganizationIdentityResolutionResult =
  | {
      kind: 'bound';
      companyId: string;
      matchRule: 'identity_v2' | 'name_country';
      inputHash: string;
      replayed: boolean;
    }
  | {
      kind: 'conflict';
      conflictId: string;
      inputHash: string;
    };

export class OrganizationIdentityInputDriftError extends Error {
  readonly code = 'IDENTITY_INPUT_DRIFT';

  constructor(rawRecordId: string) {
    super('raw record ' + rawRecordId + ' was already resolved with different Identity v2 input');
    this.name = 'OrganizationIdentityInputDriftError';
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => JSON.stringify(key) + ':' + stableJson(item))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function rawIdentifierInputs(record: OrganizationIdentityRecord): OrganizationIdentifierInput[] {
  const inputs: OrganizationIdentifierInput[] = [];
  if (record.domain)
    inputs.push({
      scheme: 'domain',
      jurisdiction: 'GLOBAL',
      value: record.domain,
    });
  if (record.identifier) inputs.push(record.identifier);
  if (Array.isArray(record.identifiers)) inputs.push(...record.identifiers);
  return inputs;
}

function identityInputHash(
  rawRecordId: string,
  providerKey: string,
  record: OrganizationIdentityRecord,
  identifiers: readonly NormalizedOrganizationIdentifier[],
): string {
  return sha256({
    rawRecordId,
    providerKey,
    resolverVersion: ORGANIZATION_IDENTITY_RESOLVER_VERSION,
    identifiers: identifiers.map((item) => item.key),
    blocker: {
      name: record.name,
      domain: record.domain ?? null,
      country: record.country ?? null,
    },
  });
}

function resolutionFromPriorLinks(
  rawRecordId: string,
  inputHash: string,
  priorLinks: {
    inputHash: string;
    status: string;
    canonicalId: string;
    matchRule: string;
    conflictId: string | null;
  }[],
): OrganizationIdentityResolutionResult | null {
  if (priorLinks.some((link) => link.inputHash !== inputHash)) {
    throw new OrganizationIdentityInputDriftError(rawRecordId);
  }
  const priorActive = priorLinks.find((link) => link.status === 'ACTIVE');
  if (priorActive) {
    return {
      kind: 'bound',
      companyId: priorActive.canonicalId,
      matchRule: 'identity_v2',
      inputHash,
      replayed: true,
    };
  }
  const priorConflict = priorLinks.find((link) => link.matchRule === 'identity_conflict' && link.conflictId);
  if (priorConflict?.conflictId) {
    return {
      kind: 'conflict',
      conflictId: priorConflict.conflictId,
      inputHash,
    };
  }
  return null;
}

async function lockIdentifierKeys(
  tx: IdentityTx,
  workspaceId: string,
  identifiers: readonly NormalizedOrganizationIdentifier[],
): Promise<void> {
  for (const identifier of identifiers) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId + ':' + identifier.key}, 0))`;
  }
}

async function loadRootMap(tx: IdentityTx, workspaceId: string, companyIds: readonly string[]) {
  const ids = [...new Set(companyIds)];
  if (!ids.length) return new Map<string, string>();
  const mappings = await tx.organizationCanonicalMapping.findMany({
    where: { workspaceId, sourceCompanyId: { in: ids }, status: 'ACTIVE' },
    select: { sourceCompanyId: true, canonicalCompanyId: true },
  });
  return new Map(mappings.map((mapping) => [mapping.sourceCompanyId, mapping.canonicalCompanyId]));
}

async function createConflict(
  tx: IdentityTx,
  input: {
    workspaceId: string;
    rawRecordId: string;
    providerKey: string;
    conflictType: OrganizationIdentityConflictType;
    companyIds: readonly string[];
    identifierKeys: readonly string[];
    identifiers: readonly NormalizedOrganizationIdentifier[];
    proposedCompanyId: string | null;
    inputHash: string;
    blockerKey: string;
  },
): Promise<string> {
  const companyIds = [...new Set(input.companyIds)].sort();
  const identifierKeys = [...new Set(input.identifierKeys)].sort();
  const fingerprint = identityConflictFingerprint({
    rawRecordId: input.rawRecordId,
    resolverVersion: ORGANIZATION_IDENTITY_RESOLVER_VERSION,
    conflictType: input.conflictType,
    companyIds,
    identifierKeys,
  });
  const conflict = await tx.organizationIdentityConflict.upsert({
    where: {
      workspaceId_fingerprint: { workspaceId: input.workspaceId, fingerprint },
    },
    update: {},
    create: {
      workspaceId: input.workspaceId,
      rawRecordId: input.rawRecordId,
      conflictType: input.conflictType,
      fingerprint,
      facts: {
        resolverVersion: ORGANIZATION_IDENTITY_RESOLVER_VERSION,
        inputHash: input.inputHash,
        blockerKey: input.blockerKey,
        companyIds,
        identifierKeys,
        providerKey: input.providerKey,
        proposedCompanyId: input.proposedCompanyId,
        identifiers: input.identifiers.map((identifier) => ({
          scheme: identifier.scheme,
          jurisdiction: identifier.jurisdiction,
          normalizedValue: identifier.normalizedValue,
          normalizerVersion: identifier.normalizerVersion,
          validatorVersion: identifier.validatorVersion,
        })),
      },
    },
  });
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.workspaceId + ':identity-conflict:' + conflict.id}, 0))`;
  const linkStatus = conflict.status === 'RESOLVED' ? 'REVOKED' : 'PENDING_CONFLICT';
  if (companyIds.length) {
    await tx.organizationIdentityConflictParty.createMany({
      data: companyIds.map((companyId) => ({
        workspaceId: input.workspaceId,
        conflictId: conflict.id,
        companyId,
        role: 'CANDIDATE',
      })),
      skipDuplicates: true,
    });
  }
  for (const companyId of companyIds) {
    const link = await tx.identityLink.findFirst({
      where: {
        workspaceId: input.workspaceId,
        canonicalType: 'company',
        canonicalId: companyId,
        rawRecordId: input.rawRecordId,
      },
    });
    if (link) {
      await tx.identityLink.update({
        where: { id: link.id },
        data: {
          status: linkStatus,
          resolverVersion: ORGANIZATION_IDENTITY_RESOLVER_VERSION,
          inputHash: input.inputHash,
          conflictId: conflict.id,
        },
      });
    } else {
      await tx.identityLink.create({
        data: {
          workspaceId: input.workspaceId,
          canonicalType: 'company',
          canonicalId: companyId,
          rawRecordId: input.rawRecordId,
          matchRule: 'identity_conflict',
          confidence: 0,
          status: linkStatus,
          resolverVersion: ORGANIZATION_IDENTITY_RESOLVER_VERSION,
          inputHash: input.inputHash,
          conflictId: conflict.id,
        },
      });
    }
  }
  if (input.proposedCompanyId && conflict.status !== 'RESOLVED') {
    for (const identifier of input.identifiers) {
      const active = await tx.organizationIdentifier.findFirst({
        where: {
          workspaceId: input.workspaceId,
          scheme: identifier.scheme,
          jurisdiction: identifier.jurisdiction,
          normalizedValue: identifier.normalizedValue,
          status: 'ACTIVE',
        },
      });
      if (active) continue;
      const pending = await tx.organizationIdentifier.findFirst({
        where: {
          workspaceId: input.workspaceId,
          companyId: input.proposedCompanyId,
          rawRecordId: input.rawRecordId,
          scheme: identifier.scheme,
          jurisdiction: identifier.jurisdiction,
          normalizedValue: identifier.normalizedValue,
          status: 'PENDING_CONFLICT',
        },
      });
      if (pending) continue;
      await tx.organizationIdentifier.create({
        data: {
          workspaceId: input.workspaceId,
          companyId: input.proposedCompanyId,
          scheme: identifier.scheme,
          jurisdiction: identifier.jurisdiction,
          normalizedValue: identifier.normalizedValue,
          authorityProviderKey: input.providerKey,
          rawRecordId: input.rawRecordId,
          conflictId: conflict.id,
          confidence: 1,
          normalizerVersion: identifier.normalizerVersion,
          validatorVersion: identifier.validatorVersion,
          status: 'PENDING_CONFLICT',
        },
      });
    }
  }
  return conflict.id;
}

async function upsertLegacyCandidate(tx: IdentityTx, workspaceId: string, record: OrganizationIdentityRecord, dedupeKey: string) {
  return tx.canonicalCompany.upsert({
    where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } },
    update: {
      ...(record.region ? { region: { set: record.region } } : {}),
      version: { increment: 1 },
    },
    create: {
      workspaceId,
      name: record.name,
      domain: record.domain ?? null,
      country: record.country ?? null,
      region: record.region ?? null,
      industry: record.industry ?? null,
      employeeCount: record.employeeCount ?? null,
      revenueUsd: record.revenueUsd ?? null,
      attributes: (record.attributes ?? undefined) as never,
      status: 'NEW',
      dedupeKey,
    },
  });
}

function strongCandidateDedupeKey(blockerKey: string, identifiers: readonly NormalizedOrganizationIdentifier[]): string {
  return blockerKey + ':identity:' + sha256(identifiers.map((identifier) => identifier.key)).slice(0, 16);
}

async function candidateHasIncompatibleSingletonIdentifier(
  tx: IdentityTx,
  workspaceId: string,
  companyIds: readonly string[],
  identifiers: readonly NormalizedOrganizationIdentifier[],
): Promise<boolean> {
  const singletonInputs = identifiers.filter((identifier) => ORGANIZATION_SINGLETON_IDENTIFIER_SCHEMES.has(identifier.scheme));
  if (!companyIds.length || !singletonInputs.length) return false;
  const existing = await tx.organizationIdentifier.findMany({
    where: {
      workspaceId,
      companyId: { in: [...new Set(companyIds)] },
      status: 'ACTIVE',
      OR: singletonInputs.map((identifier) => ({
        scheme: identifier.scheme,
        jurisdiction: identifier.jurisdiction,
      })),
    },
    select: { scheme: true, jurisdiction: true, normalizedValue: true },
  });
  return singletonInputs.some((identifier) =>
    existing.some(
      (item) =>
        item.scheme === identifier.scheme &&
        item.jurisdiction === identifier.jurisdiction &&
        item.normalizedValue !== identifier.normalizedValue,
    ),
  );
}

/** Resolve one immutable Raw record into Identity v2 without ever guessing through a conflict. */
export async function resolveOrganizationIdentityForRaw(
  tx: IdentityTx,
  input: {
    workspaceId: string;
    rawRecordId: string;
    providerKey: string;
    record: OrganizationIdentityRecord;
  },
): Promise<OrganizationIdentityResolutionResult> {
  await lockWorkspaceOrganizationIdentity(tx, input.workspaceId);
  const normalizedIdentifiers = normalizeAuthorityIdentifiers(
    authorityProfileForProvider(input.providerKey),
    rawIdentifierInputs(input.record),
  );
  const inputHash = identityInputHash(input.rawRecordId, input.providerKey, input.record, normalizedIdentifiers);
  const priorLinks = await tx.identityLink.findMany({
    where: {
      workspaceId: input.workspaceId,
      rawRecordId: input.rawRecordId,
      resolverVersion: ORGANIZATION_IDENTITY_RESOLVER_VERSION,
    },
  });
  const priorResolution = resolutionFromPriorLinks(input.rawRecordId, inputHash, priorLinks);
  if (priorResolution) {
    if (priorResolution.kind === 'conflict') return priorResolution;
    const identity = await resolveOrganizationRoot(tx, input.workspaceId, priorResolution.companyId);
    return { ...priorResolution, companyId: identity.rootCompanyId };
  }

  await lockIdentifierKeys(tx, input.workspaceId, normalizedIdentifiers);
  // The pre-lock read is only a fast path. A concurrent resolver may have
  // committed this raw while we waited for the authority-key lock, so re-read
  // under the lock before creating any canonical, identifier, conflict or link.
  const lockedLinks = await tx.identityLink.findMany({
    where: {
      workspaceId: input.workspaceId,
      rawRecordId: input.rawRecordId,
      resolverVersion: ORGANIZATION_IDENTITY_RESOLVER_VERSION,
    },
  });
  const lockedResolution = resolutionFromPriorLinks(input.rawRecordId, inputHash, lockedLinks);
  if (lockedResolution) {
    if (lockedResolution.kind === 'conflict') return lockedResolution;
    const identity = await resolveOrganizationRoot(tx, input.workspaceId, lockedResolution.companyId);
    return { ...lockedResolution, companyId: identity.rootCompanyId };
  }
  const bindings = normalizedIdentifiers.length
    ? await tx.organizationIdentifier.findMany({
        where: {
          workspaceId: input.workspaceId,
          status: 'ACTIVE',
          OR: normalizedIdentifiers.map((identifier) => ({
            scheme: identifier.scheme,
            jurisdiction: identifier.jurisdiction,
            normalizedValue: identifier.normalizedValue,
          })),
        },
        select: {
          scheme: true,
          jurisdiction: true,
          normalizedValue: true,
          companyId: true,
        },
      })
    : [];
  const bindingMap = new Map(
    bindings.map((binding) => [binding.scheme + ':' + binding.jurisdiction + ':' + binding.normalizedValue, binding.companyId]),
  );
  const fallbackIdentifier =
    input.record.identifier ??
    [...(input.record.identifiers ?? [])].sort((left, right) =>
      (left.scheme + ':' + left.value).localeCompare(right.scheme + ':' + right.value),
    )[0];
  const blocker = companyIdentity({
    name: input.record.name,
    domain: input.record.domain,
    country: input.record.country,
    identifier: fallbackIdentifier,
  });
  const legacyNameBlocker =
    fallbackIdentifier && !input.record.domain
      ? companyIdentity({
          name: input.record.name,
          country: input.record.country,
        })
      : null;
  const primaryCandidate = await tx.canonicalCompany.findUnique({
    where: {
      workspaceId_dedupeKey: {
        workspaceId: input.workspaceId,
        dedupeKey: blocker.dedupeKey,
      },
    },
    select: { id: true },
  });
  const legacyCandidate =
    primaryCandidate ??
    (legacyNameBlocker
      ? await tx.canonicalCompany.findUnique({
          where: {
            workspaceId_dedupeKey: {
              workspaceId: input.workspaceId,
              dedupeKey: legacyNameBlocker.dedupeKey,
            },
          },
          select: { id: true },
        })
      : null);
  const roots = await loadRootMap(tx, input.workspaceId, [
    ...bindings.map((binding) => binding.companyId),
    ...(legacyCandidate ? [legacyCandidate.id] : []),
  ]);
  const legacyRoot = legacyCandidate ? (roots.get(legacyCandidate.id) ?? legacyCandidate.id) : null;
  const legacyAliases = legacyRoot
    ? await tx.organizationCanonicalMapping.findMany({
        where: {
          workspaceId: input.workspaceId,
          canonicalCompanyId: legacyRoot,
          status: 'ACTIVE',
        },
        select: { sourceCompanyId: true },
      })
    : [];
  const legacyGroupIds = legacyRoot ? [legacyRoot, ...legacyAliases.map((mapping) => mapping.sourceCompanyId)] : [];
  const incompatibleLegacyIdentifier = legacyRoot
    ? await candidateHasIncompatibleSingletonIdentifier(tx, input.workspaceId, legacyGroupIds, normalizedIdentifiers)
    : false;
  const disambiguatedDedupeKey = incompatibleLegacyIdentifier
    ? strongCandidateDedupeKey(blocker.dedupeKey, normalizedIdentifiers)
    : blocker.dedupeKey;

  const legacyRootIsAuthoritativelyBound = legacyRoot
    ? bindings.some((binding) => (roots.get(binding.companyId) ?? binding.companyId) === legacyRoot)
    : false;
  if (incompatibleLegacyIdentifier && legacyRootIsAuthoritativelyBound && legacyRoot) {
    const alternative = await upsertLegacyCandidate(tx, input.workspaceId, input.record, disambiguatedDedupeKey);
    const conflictId = await createConflict(tx, {
      workspaceId: input.workspaceId,
      rawRecordId: input.rawRecordId,
      providerKey: input.providerKey,
      conflictType: 'blocking_key_disagreement',
      companyIds: [legacyRoot, alternative.id],
      identifierKeys: normalizedIdentifiers.map((identifier) => identifier.key),
      identifiers: normalizedIdentifiers,
      proposedCompanyId: alternative.id,
      inputHash,
      blockerKey: blocker.dedupeKey,
    });
    return { kind: 'conflict', conflictId, inputHash };
  }
  const plan = planOrganizationIdentityResolution({
    identifiers: normalizedIdentifiers,
    legacyCandidateCompanyId: incompatibleLegacyIdentifier ? null : (legacyCandidate?.id ?? null),
    bindings: bindingMap,
    roots,
  });

  if (plan.kind === 'conflict') {
    const boundRoots = [
      ...new Set(
        bindings.map((binding) => roots.get(binding.companyId) ?? binding.companyId),
      ),
    ];
    const conflictId = await createConflict(tx, {
      workspaceId: input.workspaceId,
      rawRecordId: input.rawRecordId,
      providerKey: input.providerKey,
      conflictType: plan.conflictType,
      companyIds: plan.companyIds,
      identifierKeys: plan.identifierKeys,
      identifiers: normalizedIdentifiers,
      proposedCompanyId: boundRoots.length === 1 ? boundRoots[0] : null,
      inputHash,
      blockerKey: blocker.dedupeKey,
    });
    return { kind: 'conflict', conflictId, inputHash };
  }

  const canonical =
    plan.kind === 'create_new'
      ? await upsertLegacyCandidate(tx, input.workspaceId, input.record, disambiguatedDedupeKey)
      : await tx.canonicalCompany.update({
          where: { id: plan.companyId },
          data: {
            ...(input.record.region ? { region: { set: input.record.region } } : {}),
            version: { increment: 1 },
          },
        });

  for (const identifier of normalizedIdentifiers) {
    const existing = await tx.organizationIdentifier.findFirst({
      where: {
        workspaceId: input.workspaceId,
        scheme: identifier.scheme,
        jurisdiction: identifier.jurisdiction,
        normalizedValue: identifier.normalizedValue,
        status: 'ACTIVE',
      },
    });
    if (existing) {
      await tx.organizationIdentifier.update({
        where: { id: existing.id },
        data: { lastSeenAt: new Date() },
      });
      continue;
    }
    await tx.organizationIdentifier.create({
      data: {
        workspaceId: input.workspaceId,
        companyId: canonical.id,
        scheme: identifier.scheme,
        jurisdiction: identifier.jurisdiction,
        normalizedValue: identifier.normalizedValue,
        authorityProviderKey: input.providerKey,
        rawRecordId: input.rawRecordId,
        confidence: 1,
        normalizerVersion: identifier.normalizerVersion,
        validatorVersion: identifier.validatorVersion,
      },
    });
  }

  await tx.identityLink.create({
    data: {
      workspaceId: input.workspaceId,
      canonicalType: 'company',
      canonicalId: canonical.id,
      rawRecordId: input.rawRecordId,
      matchRule: normalizedIdentifiers.length ? 'identity_v2' : blocker.matchRule,
      confidence: normalizedIdentifiers.length || blocker.matchRule !== 'name_country' ? 1 : 0.8,
      status: 'ACTIVE',
      resolverVersion: ORGANIZATION_IDENTITY_RESOLVER_VERSION,
      inputHash,
    },
  });
  return {
    kind: 'bound',
    companyId: canonical.id,
    matchRule: normalizedIdentifiers.length ? 'identity_v2' : 'name_country',
    inputHash,
    replayed: false,
  };
}
