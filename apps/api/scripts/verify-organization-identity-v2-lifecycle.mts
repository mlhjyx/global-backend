/**
 * Identity v2 real PostgreSQL lifecycle acceptance.
 *
 * Opt-in only: IDENTITY_V2_LIFECYCLE_ACCEPTANCE=1. The script creates a random
 * isolated workspace and intentionally retains its append-only identity history
 * for audit. It never deletes or rewrites pre-existing data.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  conflictEtag,
  mappingEtag,
  OrganizationIdentityService,
} from '../src/discovery/organization-identity.service';
import { createOrganizationIdentityReplayActivities } from '../src/temporal/organization-identity-replay.activities';
import {
  assertIdentityV2LifecycleAppRole,
  assertIdentityV2LifecycleDatabaseTargets,
} from '../src/discovery/organization-identity-lifecycle-preflight';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u);
  if (match && !line.trimStart().startsWith('#')) {
    process.env[match[1]] ??= match[2].replace(/^["']|["']$/gu, '');
  }
}

if (process.env.IDENTITY_V2_LIFECYCLE_ACCEPTANCE !== '1') {
  console.log(JSON.stringify({
    status: 'SKIPPED',
    reason: 'set IDENTITY_V2_LIFECYCLE_ACCEPTANCE=1 to run the real PostgreSQL acceptance',
  }));
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;
const appDatabaseUrl = process.env.APP_DATABASE_URL;
if (!databaseUrl || !appDatabaseUrl) {
  throw new Error('DATABASE_URL and APP_DATABASE_URL are required');
}
assertIdentityV2LifecycleDatabaseTargets(databaseUrl, appDatabaseUrl);

const workspaceId = randomUUID();
const ownerDb = new PrismaClient({ datasourceUrl: databaseUrl });
const appDb = new PrismaService();
const identity = new OrganizationIdentityService(appDb);
const replay = createOrganizationIdentityReplayActivities({ prisma: appDb });
const ctx = { workspaceId, userId: 'identity-v2-lifecycle-verifier', roles: [], scopes: [] };
let monitoredSourceId: string;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`identity v2 acceptance failed: ${message}`);
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as {
    code?: unknown;
    response?: { error?: { code?: unknown } };
    getResponse?: () => unknown;
  };
  if (typeof candidate.code === 'string') return candidate.code;
  if (typeof candidate.response?.error?.code === 'string') return candidate.response.error.code;
  const response = candidate.getResponse?.();
  if (response && typeof response === 'object') {
    const code = (response as { error?: { code?: unknown } }).error?.code;
    if (typeof code === 'string') return code;
  }
  return null;
}

async function expectCode(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    assert(errorCode(error) === code, `expected ${code}, received ${errorCode(error) ?? 'unknown error'}`);
    return;
  }
  throw new Error(`identity v2 acceptance failed: expected ${code}, operation succeeded`);
}

type Scenario = {
  rootId: string;
  aliasId: string;
  conflictId: string;
  rootRawId: string;
  aliasRawId: string;
};

async function seedScenario(label: string): Promise<Scenario> {
  const rootSourceEntity = await ownerDb.sourceEntity.create({
    data: {
      sourceId: monitoredSourceId,
      externalId: `${label}:root:${randomUUID()}`,
      name: `${label} Root`,
      country: 'GB',
      cleaned: { label, side: 'root' },
      contentHash: randomUUID().replaceAll('-', '').repeat(2),
    },
  });
  const aliasSourceEntity = await ownerDb.sourceEntity.create({
    data: {
      sourceId: monitoredSourceId,
      externalId: `${label}:alias:${randomUUID()}`,
      name: `${label} Alias`,
      country: 'GB',
      cleaned: { label, side: 'alias' },
      contentHash: randomUUID().replaceAll('-', '').repeat(2),
    },
  });
  return appDb.withWorkspace(workspaceId, async (tx) => {
    const root = await tx.canonicalCompany.create({
      data: {
        workspaceId,
        name: `${label} Root`,
        country: 'GB',
        status: 'NEW',
        dedupeKey: `identity-v2-acceptance:${label}:root:${randomUUID()}`,
      },
    });
    const alias = await tx.canonicalCompany.create({
      data: {
        workspaceId,
        name: `${label} Alias`,
        country: 'GB',
        status: 'NEW',
        dedupeKey: `identity-v2-acceptance:${label}:alias:${randomUUID()}`,
      },
    });
    const rootRaw = await tx.rawSourceRecord.create({
      data: {
        workspaceId,
        sourceEntityId: rootSourceEntity.id,
        providerKey: 'companies_house',
        sourceClass: 'company_registry',
        externalId: `${label}:root:${randomUUID()}`,
        payload: { label, side: 'root' },
      },
    });
    const aliasRaw = await tx.rawSourceRecord.create({
      data: {
        workspaceId,
        sourceEntityId: aliasSourceEntity.id,
        providerKey: 'companies_house',
        sourceClass: 'company_registry',
        externalId: `${label}:alias:${randomUUID()}`,
        payload: { label, side: 'alias' },
      },
    });
    const conflict = await tx.organizationIdentityConflict.create({
      data: {
        workspaceId,
        rawRecordId: aliasRaw.id,
        conflictType: 'binding_conflict',
        fingerprint: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
        facts: { label, rootId: root.id, aliasId: alias.id },
      },
    });
    await tx.organizationIdentityConflictParty.createMany({
      data: [
        { workspaceId, conflictId: conflict.id, companyId: root.id, role: 'BOUND_CANDIDATE' },
        { workspaceId, conflictId: conflict.id, companyId: alias.id, role: 'ENRICHMENT_TARGET' },
      ],
    });
    for (const [companyId, rawRecordId, value] of [
      [root.id, rootRaw.id, `${label}-root.example`],
      [alias.id, aliasRaw.id, `${label}-alias.example`],
    ] as const) {
      await tx.identityLink.create({
        data: {
          workspaceId,
          canonicalType: 'company',
          canonicalId: companyId,
          rawRecordId,
          matchRule: 'identity_v2_conflict',
          confidence: 1,
          status: 'PENDING_CONFLICT',
          resolverVersion: 'organization-identity-v2',
          inputHash: randomUUID().replaceAll('-', '').repeat(2),
          conflictId: conflict.id,
        },
      });
      await tx.organizationIdentifier.create({
        data: {
          workspaceId,
          companyId,
          scheme: 'domain',
          jurisdiction: 'GLOBAL',
          normalizedValue: value,
          authorityProviderKey: 'companies_house',
          rawRecordId,
          conflictId: conflict.id,
          confidence: 1,
          normalizerVersion: 'domain/v1',
          validatorVersion: 'domain/v1',
          status: 'PENDING_CONFLICT',
        },
      });
    }
    return {
      rootId: root.id,
      aliasId: alias.id,
      conflictId: conflict.id,
      rootRawId: rootRaw.id,
      aliasRawId: aliasRaw.id,
    };
  });
}

async function mergeScenario(scenario: Scenario, requestId = randomUUID()) {
  return identity.decideConflict(ctx, scenario.conflictId, conflictEtag(scenario.conflictId, 1), {
    requestId,
    decision: 'merge',
    canonicalCompanyId: scenario.rootId,
    reasonCode: 'SAME_ENTITY',
    note: 'real PostgreSQL lifecycle acceptance',
  });
}

async function projection(scenario: Scenario) {
  return appDb.withWorkspace(workspaceId, async (tx) => ({
    conflict: await tx.organizationIdentityConflict.findUniqueOrThrow({ where: { id: scenario.conflictId } }),
    mappings: await tx.organizationCanonicalMapping.findMany({
      where: { workspaceId, sourceCompanyId: scenario.aliasId },
      orderBy: { createdAt: 'asc' },
    }),
    links: await tx.identityLink.findMany({
      where: { workspaceId, rawRecordId: { in: [scenario.rootRawId, scenario.aliasRawId] } },
      orderBy: [{ rawRecordId: 'asc' }, { createdAt: 'asc' }],
    }),
    identifiers: await tx.organizationIdentifier.findMany({
      where: { workspaceId, rawRecordId: { in: [scenario.rootRawId, scenario.aliasRawId] } },
      orderBy: { normalizedValue: 'asc' },
    }),
  }));
}

await ownerDb.$connect();
await appDb.$connect();

try {
  const role = await appDb.$queryRaw<Array<{ role: string; superuser: boolean; bypassrls: boolean }>>`
    SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypassrls
    FROM pg_roles WHERE rolname = current_user`;
  assertIdentityV2LifecycleAppRole(role[0]);
  await ownerDb.workspace.create({
    data: { id: workspaceId, name: `Identity v2 lifecycle acceptance ${new Date().toISOString()}` },
  });
  const monitoredSource = await ownerDb.monitoredSource.create({
    data: {
      providerKey: 'companies_house',
      sourceKey: `identity-v2-lifecycle:${workspaceId}`,
      label: `Identity v2 lifecycle acceptance ${workspaceId}`,
      config: { acceptance: true, workspaceId },
      status: 'ACTIVE',
    },
  });
  monitoredSourceId = monitoredSource.id;

  // Complete reversible lifecycle.
  const lifecycle = await seedScenario('lifecycle');
  const merge = await mergeScenario(lifecycle);
  const mapping = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationCanonicalMapping.findFirstOrThrow({
      where: { workspaceId, sourceCompanyId: lifecycle.aliasId, status: 'ACTIVE' },
    }));
  assert(merge.replay.status === 'PENDING', 'merge must enqueue a pending replay');
  await replay.processOrganizationIdentityReplay({ workspaceId, replayId: merge.replay.id });
  const merged = await projection(lifecycle);
  assert(merged.conflict.status === 'RESOLVED', 'merge replay must resolve the conflict');
  assert(merged.mappings[0]?.status === 'ACTIVE', 'merge mapping must be ACTIVE');
  assert(merged.identifiers.every((item) => item.status === 'ACTIVE'), 'merge must activate pending identifiers');
  assert(
    merged.links.filter((link) => link.status === 'ACTIVE').every((link) => link.canonicalId === lifecycle.rootId),
    'merge must project every active raw link to the selected root',
  );
  const mergeReplayBefore = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationIdentityReplay.findUniqueOrThrow({ where: { id: merge.replay.id } }));
  await replay.processOrganizationIdentityReplay({ workspaceId, replayId: merge.replay.id });
  const mergeReplayAfter = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationIdentityReplay.findUniqueOrThrow({ where: { id: merge.replay.id } }));
  assert(mergeReplayAfter.attempt === mergeReplayBefore.attempt, 'repeated successful merge replay must be idempotent');
  assert(mergeReplayAfter.outputHash === mergeReplayBefore.outputHash, 'merge replay output hash must be stable');

  const split = await identity.splitMapping(ctx, mapping.id, mappingEtag(mapping.id, mapping.revision), {
    requestId: randomUUID(),
    reasonCode: 'WRONG_MERGE',
    note: 'real PostgreSQL lifecycle acceptance',
  });
  await replay.processOrganizationIdentityReplay({ workspaceId, replayId: split.replay.id });
  const splitState = await projection(lifecycle);
  assert(splitState.conflict.status === 'OPEN', 'split replay must reopen the original conflict');
  assert(splitState.mappings[0]?.status === 'REVOKED', 'split replay must revoke the mapping');
  assert(splitState.mappings[0]?.splitDecisionId === split.decision.id, 'mapping must reference the split decision');
  assert(splitState.identifiers.every((item) => item.status === 'PENDING_CONFLICT'), 'split must restore pending identifiers');
  const originalLinks = splitState.links.filter(
    (link) => link.conflictId === lifecycle.conflictId && link.matchRule !== 'manual_merge',
  );
  assert(originalLinks.length === 2, 'split must retain both original conflict links');
  assert(originalLinks.every((link) => link.status === 'PENDING_CONFLICT'), 'split must restore original pending links');
  assert(
    splitState.links.filter((link) => link.matchRule === 'manual_merge').every((link) => link.status === 'REVOKED'),
    'split must revoke manual merge links',
  );
  const splitReplayBefore = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationIdentityReplay.findUniqueOrThrow({ where: { id: split.replay.id } }));
  await replay.processOrganizationIdentityReplay({ workspaceId, replayId: split.replay.id });
  const splitReplayAfter = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationIdentityReplay.findUniqueOrThrow({ where: { id: split.replay.id } }));
  assert(splitReplayAfter.attempt === splitReplayBefore.attempt, 'repeated successful split replay must be idempotent');
  assert(splitReplayAfter.outputHash === splitReplayBefore.outputHash, 'split replay output hash must be stable');

  const decisionBefore = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationIdentityDecision.findUniqueOrThrow({ where: { id: merge.decision.id } }));
  let appendOnlyRejected = false;
  try {
    await appDb.withWorkspace(workspaceId, (tx) =>
      tx.organizationIdentityDecision.update({ where: { id: merge.decision.id }, data: { note: 'mutation forbidden' } }));
  } catch {
    appendOnlyRejected = true;
  }
  assert(appendOnlyRejected, 'database must reject an update to append-only decision history');
  const decisionAfter = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationIdentityDecision.findUniqueOrThrow({ where: { id: merge.decision.id } }));
  assert(JSON.stringify(decisionAfter) === JSON.stringify(decisionBefore), 'decision history must be append-only');

  // A split cannot overtake its merge replay while workers are paused.
  const unsettled = await seedScenario('unsettled-merge');
  const unsettledMerge = await mergeScenario(unsettled);
  const unsettledMapping = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationCanonicalMapping.findFirstOrThrow({ where: { workspaceId, sourceCompanyId: unsettled.aliasId } }));
  const decisionsBeforeUnsettledSplit = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationIdentityDecision.count({ where: { workspaceId } }));
  await expectCode(
    () => identity.splitMapping(ctx, unsettledMapping.id, mappingEtag(unsettledMapping.id, 1), {
      requestId: randomUUID(),
      reasonCode: 'WRONG_MERGE',
    }),
    'IDENTITY_MERGE_PROJECTION_UNSETTLED',
  );
  const decisionsAfterUnsettledSplit = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationIdentityDecision.count({ where: { workspaceId } }));
  assert(decisionsAfterUnsettledSplit === decisionsBeforeUnsettledSplit, 'unsettled split must create no decision');
  assert(unsettledMerge.replay.status === 'PENDING', 'unsettled merge replay must remain pending');

  const seller = await appDb.withWorkspace(workspaceId, (tx) => tx.companyProfile.create({
    data: { workspaceId, name: 'Identity v2 acceptance seller' },
  }));
  const icp = await appDb.withWorkspace(workspaceId, (tx) => tx.icpDefinition.create({
    data: { workspaceId, companyId: seller.id, name: 'Identity v2 acceptance ICP', status: 'ACTIVE' },
  }));

  // Terminal Lead blocks a new merge before mapping/history is created.
  const terminalMerge = await seedScenario('terminal-merge');
  await appDb.withWorkspace(workspaceId, (tx) => tx.lead.create({
    data: {
      workspaceId,
      icpId: icp.id,
      canonicalCompanyId: terminalMerge.aliasId,
      status: 'QUALIFIED',
    },
  }));
  await expectCode(() => mergeScenario(terminalMerge), 'COMMERCIAL_FACTS_IMMUTABLE');
  const terminalMergeMappings = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationCanonicalMapping.count({ where: { workspaceId, sourceCompanyId: terminalMerge.aliasId } }));
  assert(terminalMergeMappings === 0, 'blocked merge must create no mapping');

  // Commercial facts can also appear after a merge request but before replay.
  const lateMergeCommercial = await seedScenario('late-merge-commercial');
  const requestedLateMerge = await mergeScenario(lateMergeCommercial);
  await appDb.withWorkspace(workspaceId, (tx) => tx.lead.create({
    data: {
      workspaceId,
      icpId: icp.id,
      canonicalCompanyId: lateMergeCommercial.aliasId,
      status: 'QUALIFIED',
    },
  }));
  const beforeFailedMergeReplay = await projection(lateMergeCommercial);
  await expectCode(
    () => replay.processOrganizationIdentityReplay({ workspaceId, replayId: requestedLateMerge.replay.id }),
    'COMMERCIAL_FACTS_IMMUTABLE',
  );
  const afterFailedMergeReplay = await projection(lateMergeCommercial);
  assert(afterFailedMergeReplay.mappings[0]?.status === 'ACTIVE', 'failed merge replay must retain pending mapping');
  assert(afterFailedMergeReplay.conflict.status === 'RESOLVING', 'failed merge replay must keep conflict RESOLVING');
  assert(
    JSON.stringify(afterFailedMergeReplay.links) === JSON.stringify(beforeFailedMergeReplay.links),
    'failed merge replay must not change link projection',
  );
  assert(
    JSON.stringify(afterFailedMergeReplay.identifiers) === JSON.stringify(beforeFailedMergeReplay.identifiers),
    'failed merge replay must not change identifier projection',
  );
  const failedMergeReplay = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationIdentityReplay.findUniqueOrThrow({ where: { id: requestedLateMerge.replay.id } }));
  assert(failedMergeReplay.status === 'FAILED', 'commercially blocked merge replay must persist FAILED');
  assert(
    failedMergeReplay.errorCode === 'COMMERCIAL_FACTS_IMMUTABLE',
    'failed merge replay must persist stable errorCode',
  );

  // Delivered LeadQualified blocks a split request.
  const deliveredSplit = await seedScenario('delivered-split');
  const deliveredMerge = await mergeScenario(deliveredSplit);
  await replay.processOrganizationIdentityReplay({ workspaceId, replayId: deliveredMerge.replay.id });
  const deliveredMapping = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationCanonicalMapping.findFirstOrThrow({ where: { workspaceId, sourceCompanyId: deliveredSplit.aliasId } }));
  const deliveredLead = await appDb.withWorkspace(workspaceId, (tx) => tx.lead.create({
    data: { workspaceId, icpId: icp.id, canonicalCompanyId: deliveredSplit.rootId, status: 'DISCOVERED' },
  }));
  await appDb.withWorkspace(workspaceId, (tx) => tx.outboxEvent.create({
    data: {
      workspaceId,
      eventType: 'LeadQualified',
      aggregateType: 'Lead',
      aggregateId: deliveredLead.id,
      payload: { schema_version: 1 },
    },
  }));
  await expectCode(
    () => identity.splitMapping(ctx, deliveredMapping.id, mappingEtag(deliveredMapping.id, 1), {
      requestId: randomUUID(),
      reasonCode: 'WRONG_MERGE',
    }),
    'COMMERCIAL_FACTS_IMMUTABLE',
  );

  // Commercial facts can appear after the split request; replay must recheck.
  const lateCommercial = await seedScenario('late-commercial');
  const lateMerge = await mergeScenario(lateCommercial);
  await replay.processOrganizationIdentityReplay({ workspaceId, replayId: lateMerge.replay.id });
  const lateMapping = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationCanonicalMapping.findFirstOrThrow({ where: { workspaceId, sourceCompanyId: lateCommercial.aliasId } }));
  const lateSplit = await identity.splitMapping(ctx, lateMapping.id, mappingEtag(lateMapping.id, 1), {
    requestId: randomUUID(),
    reasonCode: 'WRONG_MERGE',
  });
  await appDb.withWorkspace(workspaceId, (tx) => tx.lead.create({
    data: { workspaceId, icpId: icp.id, canonicalCompanyId: lateCommercial.rootId, status: 'QUALIFIED' },
  }));
  const beforeFailedReplay = await projection(lateCommercial);
  await expectCode(
    () => replay.processOrganizationIdentityReplay({ workspaceId, replayId: lateSplit.replay.id }),
    'COMMERCIAL_FACTS_IMMUTABLE',
  );
  const afterFailedReplay = await projection(lateCommercial);
  assert(afterFailedReplay.mappings[0]?.status === 'ACTIVE', 'failed split replay must keep mapping ACTIVE');
  assert(afterFailedReplay.conflict.status === 'RESOLVED', 'failed split replay must keep conflict RESOLVED');
  assert(
    JSON.stringify(afterFailedReplay.links) === JSON.stringify(beforeFailedReplay.links),
    'failed split replay must not change link projection',
  );
  assert(
    JSON.stringify(afterFailedReplay.identifiers) === JSON.stringify(beforeFailedReplay.identifiers),
    'failed split replay must not change identifier projection',
  );
  const failedReplay = await appDb.withWorkspace(workspaceId, (tx) =>
    tx.organizationIdentityReplay.findUniqueOrThrow({ where: { id: lateSplit.replay.id } }));
  assert(failedReplay.status === 'FAILED', 'commercially blocked replay must persist FAILED');
  assert(failedReplay.errorCode === 'COMMERCIAL_FACTS_IMMUTABLE', 'failed replay must persist stable errorCode');

  console.log(JSON.stringify({
    status: 'PASS',
    workspaceId,
    retainedForAudit: true,
    conflictOrigin: 'seeded real PostgreSQL state; not generated by the resolver',
    lifecycle: {
      conflictId: lifecycle.conflictId,
      mappingId: mapping.id,
      mergeDecisionId: merge.decision.id,
      mergeReplayId: merge.replay.id,
      splitDecisionId: split.decision.id,
      splitReplayId: split.replay.id,
    },
    guards: {
      unsettledMergeReplayId: unsettledMerge.replay.id,
      terminalMergeConflictId: terminalMerge.conflictId,
      lateCommercialMergeReplayId: requestedLateMerge.replay.id,
      deliveredSplitMappingId: deliveredMapping.id,
      lateCommercialReplayId: lateSplit.replay.id,
    },
  }, null, 2));
} finally {
  await appDb.$disconnect();
  await ownerDb.$disconnect();
}
