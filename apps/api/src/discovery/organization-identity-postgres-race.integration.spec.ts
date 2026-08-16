import { randomBytes, randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestContext } from '../auth/request-context';
import type { DataRightsService } from '../compliance/data-rights.service';
import { LeadService } from '../lead/lead.service';
import { PrismaService } from '../prisma/prisma.service';
import type { SanctionsScreeningService } from '../sanctions/sanctions-screening.service';
import { commitCompanyEnrichmentResults } from './company-enrichment-commit';
import { upsertLeadFit, type FitJudgment } from './fit-judge';
import { createOrganizationIdentityReplayActivities } from '../temporal/organization-identity-replay.activities';
import {
  OrganizationIdentityService,
  conflictEtag,
  mappingEtag,
} from './organization-identity.service';
import {
  loadOrganizationIdentitySnapshot,
  lockWorkspaceOrganizationIdentity,
} from './organization-identity-root';
import { lockWorkspaceSuppressionPolicy } from './suppression-policy-lock';

const databaseUrl = process.env.IDENTITY_V2_POSTGRES_RACE_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

/**
 * Opt-in only: point IDENTITY_V2_POSTGRES_RACE_DATABASE_URL at a migrated,
 * disposable localhost acceptance database owned by app_user. Identity audit
 * rows are append-only, so this suite intentionally refuses ordinary databases.
 */

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type Fixture = {
  workspaceId: string;
  companyAId: string;
  companyAName: string;
  companyADomain: string;
  companyBId: string;
  leadId: string;
  icpId: string;
  conflictId: string;
};

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function localDatabaseUrl(raw: string): string {
  const parsed = new URL(raw);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error(
      'IDENTITY_V2_POSTGRES_RACE_DATABASE_URL must target localhost; this acceptance test refuses remote databases',
    );
  }
  if (!/(?:acceptance|test|experiment)/iu.test(parsed.pathname)) {
    throw new Error(
      'IDENTITY_V2_POSTGRES_RACE_DATABASE_URL must name an acceptance, test, or experiment database',
    );
  }
  return raw;
}

function context(workspaceId: string): RequestContext {
  return {
    workspaceId,
    userId: 'identity-v2-postgres-race',
    roles: ['admin'],
  };
}

function conflictCode(error: unknown): string | undefined {
  if (!(error instanceof ConflictException)) return undefined;
  const response = error.getResponse();
  if (!response || typeof response !== 'object') return undefined;
  return (response as { error?: { code?: string } }).error?.code;
}

function allowingDataRights(pause?: { entered: Deferred; release: Deferred }): DataRightsService {
  return {
    evaluate: () => ({
      allowed: true,
      effect: 'ALLOW',
      reason: 'postgres-race-acceptance',
      ruleId: null,
      ruleVersion: 'postgres-race-acceptance',
      article14NoticeRequired: false,
      retentionDays: null,
    }),
    logDecision: async () => {
      if (!pause) return;
      pause.entered.resolve();
      await pause.release.promise;
    },
  } as unknown as DataRightsService;
}

function disabledSanctions(): SanctionsScreeningService {
  return {
    screen: () => ({ status: 'not_screened', matches: [], listVersions: {} }),
  } as unknown as SanctionsScreeningService;
}

function acceptedFitJudgment(reason: string): FitJudgment {
  return {
    verdict: 'match',
    fitReasons: {
      material: 'supported',
      role: 'supported',
      process: 'supported',
      business_model: 'supported',
      reasons: [reason],
    },
  };
}

async function createFixture(
  db: PrismaService,
  options: { createLead?: boolean } = {},
): Promise<Fixture> {
  const workspaceId = randomUUID();
  const companyAId = randomUUID();
  const companyBId = randomUUID();
  const leadId = randomUUID();
  const conflictId = randomUUID();
  const profileId = randomUUID();
  const icpId = randomUUID();
  const suffix = randomUUID();
  const companyAName = `Race Source ${suffix}`;
  const companyADomain = `race-${suffix}.example.com`;

  await db.withWorkspace(workspaceId, async (tx) => {
    await tx.workspace.create({
      data: { id: workspaceId, name: `identity-v2-race-${suffix}` },
    });
    await tx.companyProfile.create({
      data: {
        id: profileId,
        workspaceId,
        name: `Race Seller ${suffix}`,
      },
    });
    await tx.icpDefinition.create({
      data: {
        id: icpId,
        workspaceId,
        companyId: profileId,
        name: `Race ICP ${suffix}`,
        status: 'ACTIVE',
      },
    });
    await tx.canonicalCompany.createMany({
      data: [
        {
          id: companyAId,
          workspaceId,
          name: companyAName,
          domain: companyADomain,
          country: 'US',
          attributes: { sentinel: 'unchanged' },
          status: 'ENRICHED',
          dedupeKey: `race-source-${suffix}`,
        },
        {
          id: companyBId,
          workspaceId,
          name: `Race Root ${suffix}`,
          country: 'US',
          attributes: {},
          status: 'ENRICHED',
          dedupeKey: `race-root-${suffix}`,
        },
      ],
    });
    if (options.createLead !== false) {
      await tx.lead.create({
        data: {
          id: leadId,
          workspaceId,
          icpId,
          canonicalCompanyId: companyAId,
          status: 'REVIEW',
          queue: 'needs_review',
          fitVerdict: null,
        },
      });
    }
  });

  return {
    workspaceId,
    companyAId,
    companyAName,
    companyADomain,
    companyBId,
    leadId,
    icpId,
    conflictId,
  };
}

async function createMergeConflict(db: PrismaService, fixture: Fixture): Promise<void> {
  await db.withWorkspace(fixture.workspaceId, async (tx) => {
    await lockWorkspaceSuppressionPolicy(tx, fixture.workspaceId);
    await lockWorkspaceOrganizationIdentity(tx, fixture.workspaceId);
    await tx.organizationIdentityConflict.create({
      data: {
        id: fixture.conflictId,
        workspaceId: fixture.workspaceId,
        conflictType: 'binding_conflict',
        fingerprint: randomBytes(32).toString('hex'),
        facts: { source: 'postgres-race-acceptance' },
        parties: {
          create: [
            { companyId: fixture.companyAId, role: 'candidate' },
            { companyId: fixture.companyBId, role: 'candidate' },
          ],
        },
      },
    });
  });
}

async function createResolvedMerge(
  db: PrismaService,
  fixture: Fixture,
): Promise<{ mappingId: string }> {
  return db.withWorkspace(fixture.workspaceId, async (tx) => {
    const conflict = await tx.organizationIdentityConflict.create({
      data: {
        id: fixture.conflictId,
        workspaceId: fixture.workspaceId,
        conflictType: 'binding_conflict',
        fingerprint: randomBytes(32).toString('hex'),
        status: 'RESOLVED',
        revision: 2,
        resolvedAt: new Date(),
        facts: { source: 'postgres-race-resolved-merge' },
        parties: {
          create: [
            { companyId: fixture.companyAId, role: 'candidate' },
            { companyId: fixture.companyBId, role: 'candidate' },
          ],
        },
      },
    });
    const decision = await tx.organizationIdentityDecision.create({
      data: {
        workspaceId: fixture.workspaceId,
        conflictId: conflict.id,
        action: 'MERGE',
        canonicalCompanyId: fixture.companyBId,
        requestId: randomUUID(),
        expectedRevision: 1,
        reasonCode: 'postgres_race_merge_fixture',
        decidedBy: 'identity-v2-postgres-race',
        decisionHash: randomBytes(32).toString('hex'),
        factSnapshot: { source: 'postgres-race-resolved-merge' },
      },
    });
    await tx.organizationIdentityReplay.create({
      data: {
        workspaceId: fixture.workspaceId,
        decisionId: decision.id,
        status: 'SUCCEEDED',
        inputHash: decision.decisionHash,
        outputHash: randomBytes(32).toString('hex'),
        completedAt: new Date(),
      },
    });
    const mapping = await tx.organizationCanonicalMapping.create({
      data: {
        workspaceId: fixture.workspaceId,
        sourceCompanyId: fixture.companyAId,
        canonicalCompanyId: fixture.companyBId,
        mergeDecisionId: decision.id,
      },
    });
    return { mappingId: mapping.id };
  });
}

async function requestSplit(
  db: PrismaService,
  fixture: Fixture,
  mappingId: string,
): Promise<{ replay: { id: string } }> {
  const service = new OrganizationIdentityService(db);
  const result = await service.splitMapping(
    context(fixture.workspaceId),
    mappingId,
    mappingEtag(mappingId, 1),
    {
      requestId: randomUUID(),
      reasonCode: 'postgres_race_split',
    },
  );
  if (!result.replay) throw new Error('split request did not create or return a replay');
  return { replay: { id: result.replay.id } };
}

async function identityLockIsAvailable(db: PrismaService, workspaceId: string): Promise<boolean> {
  return db.withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(
        hashtextextended(${'organization-identity:' + workspaceId}, 0)
      ) AS acquired`;
    return row.acquired;
  });
}

async function stillPending<T>(promise: Promise<T>, milliseconds = 250): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  return !settled;
}

describePostgres.sequential('Identity v2 real PostgreSQL transaction races', () => {
  const clients: PrismaService[] = [];

  beforeAll(async () => {
    const url = localDatabaseUrl(databaseUrl!);
    const previous = process.env.APP_DATABASE_URL;
    process.env.APP_DATABASE_URL = url;
    try {
      clients.push(new PrismaService(), new PrismaService(), new PrismaService(), new PrismaService());
    } finally {
      if (previous == null) delete process.env.APP_DATABASE_URL;
      else process.env.APP_DATABASE_URL = previous;
    }
    await Promise.all(clients.map((client) => client.onModuleInit()));
    const [role] = await clients[0].$queryRaw<Array<{ role: string; superuser: boolean; bypassrls: boolean }>>`
      SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypassrls
      FROM pg_roles
      WHERE rolname = current_user`;
    if (role.role !== 'app_user' || role.superuser || role.bypassrls) {
      throw new Error(
        `identity race acceptance requires the non-privileged app_user role; received ${role.role}`,
      );
    }
  }, 15_000);

  afterAll(async () => {
    await Promise.all(clients.map((client) => client.onModuleDestroy()));
  });

  it('blocks enrichment commit behind an identity mutation, then fails closed on snapshot drift without attributes or evidence writes', async () => {
    const fixture = await createFixture(clients[0]);
    const before = await clients[0].withWorkspace(fixture.workspaceId, (tx) =>
      loadOrganizationIdentitySnapshot(tx, fixture.workspaceId, fixture.companyAId),
    );
    const mutationEntered = deferred();
    const releaseMutation = deferred();

    const mutation = clients[0].withWorkspace(
      fixture.workspaceId,
      async (tx) => {
        await lockWorkspaceOrganizationIdentity(tx, fixture.workspaceId);
        await tx.organizationIdentifier.create({
          data: {
            workspaceId: fixture.workspaceId,
            companyId: fixture.companyAId,
            scheme: 'wikidata-qid',
            jurisdiction: '',
            normalizedValue: `Q${Date.now()}${Math.floor(Math.random() * 1_000_000)}`,
            authorityProviderKey: 'wikidata',
            confidence: 1,
            normalizerVersion: 'identity-v2',
            validatorVersion: 'identity-v2',
            provenance: { test: 'postgres-race-acceptance' },
          },
        });
        mutationEntered.resolve();
        await releaseMutation.promise;
      },
      { timeout: 15_000 },
    );
    await mutationEntered.promise;

    const commit = clients[1].withWorkspace(
      fixture.workspaceId,
      (tx) =>
        commitCompanyEnrichmentResults(tx, {
          workspaceId: fixture.workspaceId,
          companyId: fixture.companyAId,
          expectedIdentitySnapshot: before.fingerprint,
          hits: [
            {
              key: 'postgres-race-provider',
              result: {
                matched: true,
                attributes: { should_not_persist: true },
                confidence: 1,
                costCents: 0,
              },
            },
          ],
        }),
      { timeout: 15_000 },
    );
    expect(await stillPending(commit)).toBe(true);

    releaseMutation.resolve();
    await mutation;
    await expect(commit).resolves.toBe(false);

    const persisted = await clients[2].withWorkspace(fixture.workspaceId, async (tx) => ({
      company: await tx.canonicalCompany.findUniqueOrThrow({ where: { id: fixture.companyAId } }),
      evidenceCount: await tx.fieldEvidence.count({
        where: {
          workspaceId: fixture.workspaceId,
          entityType: 'company',
          entityId: fixture.companyAId,
          providerKey: 'postgres-race-provider',
        },
      }),
    }));
    expect(persisted.company.attributes).toEqual({ sentinel: 'unchanged' });
    expect(persisted.company.version).toBe(1);
    expect(persisted.evidenceCount).toBe(0);
  }, 20_000);

  it('accept holds the identity lock through LeadQualified commit, so the next identity conflict waits and its real merge returns COMMERCIAL_FACTS_IMMUTABLE', async () => {
    const fixture = await createFixture(clients[0]);
    const entered = deferred();
    const release = deferred();
    const leadService = new LeadService(
      clients[0],
      allowingDataRights({ entered, release }),
      disabledSanctions(),
    );
    const identityService = new OrganizationIdentityService(clients[1]);

    const accept = leadService.decide(context(fixture.workspaceId), fixture.leadId, 'accept');
    await entered.promise;
    expect(await identityLockIsAvailable(clients[2], fixture.workspaceId)).toBe(false);

    // The resolver-side identity mutation queues behind accept. A conflict cannot
    // pre-exist here because the handoff gate correctly rejects open conflicts.
    const createConflict = createMergeConflict(clients[3], fixture);
    expect(await stillPending(createConflict)).toBe(true);

    release.resolve();
    await expect(accept).resolves.toMatchObject({ status: 'QUALIFIED' });
    await createConflict;

    const merge = identityService.decideConflict(
      context(fixture.workspaceId),
      fixture.conflictId,
      conflictEtag(fixture.conflictId, 1),
      {
        requestId: randomUUID(),
        decision: 'merge',
        canonicalCompanyId: fixture.companyBId,
        reasonCode: 'postgres_race_accept_first',
      },
    );
    await expect(merge).rejects.toSatisfy(
      (error: unknown) => conflictCode(error) === 'COMMERCIAL_FACTS_IMMUTABLE',
    );

    const persisted = await clients[2].withWorkspace(fixture.workspaceId, async (tx) => ({
      mappingCount: await tx.organizationCanonicalMapping.count({
        where: { workspaceId: fixture.workspaceId, sourceCompanyId: fixture.companyAId },
      }),
      qualifiedEvents: await tx.outboxEvent.count({
        where: {
          workspaceId: fixture.workspaceId,
          aggregateId: fixture.leadId,
          eventType: 'LeadQualified',
        },
      }),
      conflict: await tx.organizationIdentityConflict.findUniqueOrThrow({
        where: { id: fixture.conflictId },
      }),
    }));
    expect(persisted.mappingCount).toBe(0);
    expect(persisted.qualifiedEvents).toBe(1);
    expect(persisted.conflict.status).toBe('OPEN');
  }, 20_000);

  it('a committed mapping wins before accept re-resolves identity, and LeadQualified references the new root instead of the stale source', async () => {
    const fixture = await createFixture(clients[0]);
    const mappingEntered = deferred();
    const releaseMapping = deferred();

    const mapping = clients[0].withWorkspace(
      fixture.workspaceId,
      async (tx) => {
        await lockWorkspaceSuppressionPolicy(tx, fixture.workspaceId);
        await lockWorkspaceOrganizationIdentity(tx, fixture.workspaceId);
        const decision = await tx.organizationIdentityDecision.create({
          data: {
            workspaceId: fixture.workspaceId,
            action: 'MERGE',
            canonicalCompanyId: fixture.companyBId,
            requestId: randomUUID(),
            expectedRevision: 1,
            reasonCode: 'postgres_race_mapping_first',
            decidedBy: 'identity-v2-postgres-race',
            decisionHash: randomBytes(32).toString('hex'),
            factSnapshot: { source: 'postgres-race-acceptance' },
          },
        });
        await tx.organizationCanonicalMapping.create({
          data: {
            workspaceId: fixture.workspaceId,
            sourceCompanyId: fixture.companyAId,
            canonicalCompanyId: fixture.companyBId,
            mergeDecisionId: decision.id,
          },
        });
        mappingEntered.resolve();
        await releaseMapping.promise;
      },
      { timeout: 15_000 },
    );
    await mappingEntered.promise;

    const leadService = new LeadService(
      clients[1],
      allowingDataRights(),
      disabledSanctions(),
    );
    const accept = leadService.decide(context(fixture.workspaceId), fixture.leadId, 'accept');
    expect(await stillPending(accept)).toBe(true);

    releaseMapping.resolve();
    await mapping;
    await expect(accept).resolves.toMatchObject({ status: 'QUALIFIED' });

    const event = await clients[2].withWorkspace(fixture.workspaceId, (tx) =>
      tx.outboxEvent.findFirstOrThrow({
        where: {
          workspaceId: fixture.workspaceId,
          aggregateId: fixture.leadId,
          eventType: 'LeadQualified',
        },
      }),
    );
    const payload = event.payload as {
      company_ref?: { canonical_company_id?: string };
    };
    expect(payload.company_ref?.canonical_company_id).toBe(fixture.companyBId);
    expect(payload.company_ref?.canonical_company_id).not.toBe(fixture.companyAId);
  }, 20_000);

  it('rejects accept with IDENTITY_CHANGE_PENDING while a committed split request still awaits replay', async () => {
    const fixture = await createFixture(clients[0]);
    const { mappingId } = await createResolvedMerge(clients[0], fixture);
    const { replay } = await requestSplit(clients[0], fixture, mappingId);
    const leadService = new LeadService(
      clients[1],
      allowingDataRights(),
      disabledSanctions(),
    );

    await expect(
      leadService.decide(context(fixture.workspaceId), fixture.leadId, 'accept'),
    ).rejects.toSatisfy(
      (error: unknown) => conflictCode(error) === 'IDENTITY_CHANGE_PENDING',
    );

    const persisted = await clients[2].withWorkspace(fixture.workspaceId, async (tx) => ({
      lead: await tx.lead.findUniqueOrThrow({ where: { id: fixture.leadId } }),
      qualifiedEvents: await tx.outboxEvent.count({
        where: {
          workspaceId: fixture.workspaceId,
          aggregateId: fixture.leadId,
          eventType: 'LeadQualified',
        },
      }),
      replay: await tx.organizationIdentityReplay.findUniqueOrThrow({ where: { id: replay.id } }),
    }));
    expect(persisted.lead.status).toBe('REVIEW');
    expect(persisted.qualifiedEvents).toBe(0);
    expect(persisted.replay.status).toBe('PENDING');
  }, 20_000);

  it('queues replay ahead of accept; after split commits, accept re-reads the reopened conflict and fails closed', async () => {
    const fixture = await createFixture(clients[0]);
    const { mappingId } = await createResolvedMerge(clients[0], fixture);
    const { replay } = await requestSplit(clients[0], fixture, mappingId);
    const gateEntered = deferred();
    const releaseGate = deferred();
    const gate = clients[3].withWorkspace(
      fixture.workspaceId,
      async (tx) => {
        await lockWorkspaceSuppressionPolicy(tx, fixture.workspaceId);
        await lockWorkspaceOrganizationIdentity(tx, fixture.workspaceId);
        gateEntered.resolve();
        await releaseGate.promise;
      },
      { timeout: 15_000 },
    );
    await gateEntered.promise;

    const replayActivities = createOrganizationIdentityReplayActivities({ prisma: clients[0] });
    const runReplay = replayActivities.processOrganizationIdentityReplay({
      workspaceId: fixture.workspaceId,
      replayId: replay.id,
    });
    expect(await stillPending(runReplay)).toBe(true);

    const leadService = new LeadService(
      clients[1],
      allowingDataRights(),
      disabledSanctions(),
    );
    const accept = leadService.decide(context(fixture.workspaceId), fixture.leadId, 'accept');
    expect(await stillPending(accept)).toBe(true);

    releaseGate.resolve();
    await gate;
    await expect(runReplay).resolves.toMatchObject({ status: 'SUCCEEDED', replayId: replay.id });
    await expect(accept).rejects.toSatisfy(
      (error: unknown) => conflictCode(error) === 'IDENTITY_CONFLICT_OPEN',
    );

    const persisted = await clients[2].withWorkspace(fixture.workspaceId, async (tx) => ({
      mapping: await tx.organizationCanonicalMapping.findUniqueOrThrow({ where: { id: mappingId } }),
      lead: await tx.lead.findUniqueOrThrow({ where: { id: fixture.leadId } }),
      qualifiedEvents: await tx.outboxEvent.count({
        where: {
          workspaceId: fixture.workspaceId,
          aggregateId: fixture.leadId,
          eventType: 'LeadQualified',
        },
      }),
    }));
    expect(persisted.mapping.status).toBe('REVOKED');
    expect(persisted.lead.status).toBe('REVIEW');
    expect(persisted.qualifiedEvents).toBe(0);
  }, 20_000);

  it('serializes fit commit before a mapping mutation, preserving one group Lead without duplicate creation', async () => {
    const fixture = await createFixture(clients[0]);
    const snapshot = await clients[0].withWorkspace(fixture.workspaceId, (tx) =>
      loadOrganizationIdentitySnapshot(tx, fixture.workspaceId, fixture.companyAId),
    );
    const entered = deferred();
    const release = deferred();
    const judgment: FitJudgment = {
      verdict: 'match',
      fitReasons: {
        material: 'supported',
        role: 'supported',
        process: 'supported',
        business_model: 'supported',
        reasons: ['postgres-race-acceptance'],
      },
    };

    const fit = clients[0].withWorkspace(
      fixture.workspaceId,
      async (tx) => {
        await lockWorkspaceSuppressionPolicy(tx, fixture.workspaceId);
        await lockWorkspaceOrganizationIdentity(tx, fixture.workspaceId);
        entered.resolve();
        await release.promise;
        return upsertLeadFit(
          tx,
          fixture.workspaceId,
          (await tx.lead.findUniqueOrThrow({ where: { id: fixture.leadId } })).icpId,
          fixture.companyAId,
          judgment,
          snapshot.fingerprint,
        );
      },
      { timeout: 15_000 },
    );
    await entered.promise;

    const mapping = clients[1].withWorkspace(
      fixture.workspaceId,
      async (tx) => {
        await lockWorkspaceSuppressionPolicy(tx, fixture.workspaceId);
        await lockWorkspaceOrganizationIdentity(tx, fixture.workspaceId);
        const decision = await tx.organizationIdentityDecision.create({
          data: {
            workspaceId: fixture.workspaceId,
            action: 'MERGE',
            canonicalCompanyId: fixture.companyBId,
            requestId: randomUUID(),
            expectedRevision: 1,
            reasonCode: 'postgres_race_fit_first',
            decidedBy: 'identity-v2-postgres-race',
            decisionHash: randomBytes(32).toString('hex'),
            factSnapshot: { source: 'postgres-race-fit-first' },
          },
        });
        return tx.organizationCanonicalMapping.create({
          data: {
            workspaceId: fixture.workspaceId,
            sourceCompanyId: fixture.companyAId,
            canonicalCompanyId: fixture.companyBId,
            mergeDecisionId: decision.id,
          },
        });
      },
      { timeout: 15_000 },
    );
    expect(await stillPending(mapping)).toBe(true);

    release.resolve();
    await expect(fit).resolves.toBe(true);
    await expect(mapping).resolves.toMatchObject({ status: 'ACTIVE' });

    const persisted = await clients[2].withWorkspace(fixture.workspaceId, async (tx) => ({
      groupLeadCount: await tx.lead.count({
        where: {
          workspaceId: fixture.workspaceId,
          canonicalCompanyId: { in: [fixture.companyAId, fixture.companyBId] },
        },
      }),
      lead: await tx.lead.findUniqueOrThrow({ where: { id: fixture.leadId } }),
    }));
    expect(persisted.groupLeadCount).toBe(1);
    expect(persisted.lead.fitVerdict).toBe('match');
  }, 20_000);

  it('makes a fit result queued behind a committed mapping fail closed on its stale identity fingerprint', async () => {
    const fixture = await createFixture(clients[0]);
    const lead = await clients[0].withWorkspace(fixture.workspaceId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: fixture.leadId } }),
    );
    const snapshot = await clients[0].withWorkspace(fixture.workspaceId, (tx) =>
      loadOrganizationIdentitySnapshot(tx, fixture.workspaceId, fixture.companyAId),
    );
    const mappingEntered = deferred();
    const releaseMapping = deferred();
    const mapping = clients[0].withWorkspace(
      fixture.workspaceId,
      async (tx) => {
        await lockWorkspaceSuppressionPolicy(tx, fixture.workspaceId);
        await lockWorkspaceOrganizationIdentity(tx, fixture.workspaceId);
        const decision = await tx.organizationIdentityDecision.create({
          data: {
            workspaceId: fixture.workspaceId,
            action: 'MERGE',
            canonicalCompanyId: fixture.companyBId,
            requestId: randomUUID(),
            expectedRevision: 1,
            reasonCode: 'postgres_race_mapping_before_fit',
            decidedBy: 'identity-v2-postgres-race',
            decisionHash: randomBytes(32).toString('hex'),
            factSnapshot: { source: 'postgres-race-mapping-before-fit' },
          },
        });
        await tx.organizationCanonicalMapping.create({
          data: {
            workspaceId: fixture.workspaceId,
            sourceCompanyId: fixture.companyAId,
            canonicalCompanyId: fixture.companyBId,
            mergeDecisionId: decision.id,
          },
        });
        mappingEntered.resolve();
        await releaseMapping.promise;
      },
      { timeout: 15_000 },
    );
    await mappingEntered.promise;

    const fit = clients[1].withWorkspace(
      fixture.workspaceId,
      (tx) =>
        upsertLeadFit(
          tx,
          fixture.workspaceId,
          lead.icpId,
          fixture.companyAId,
          {
            verdict: 'match',
            fitReasons: {
              material: 'supported',
              role: 'supported',
              process: 'supported',
              business_model: 'supported',
              reasons: ['must-not-persist'],
            },
          },
          snapshot.fingerprint,
        ),
      { timeout: 15_000 },
    );
    expect(await stillPending(fit)).toBe(true);

    releaseMapping.resolve();
    await mapping;
    await expect(fit).resolves.toBe(false);
    const persisted = await clients[2].withWorkspace(fixture.workspaceId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: fixture.leadId } }),
    );
    expect(persisted.fitVerdict).toBeNull();
    expect(persisted.version).toBe(1);
  }, 20_000);

  it('makes an existing Lead fit commit wait for a production-ordered domain suppression, then reports failure without updating the Lead', async () => {
    const fixture = await createFixture(clients[0]);
    const snapshot = await clients[0].withWorkspace(fixture.workspaceId, (tx) =>
      loadOrganizationIdentitySnapshot(tx, fixture.workspaceId, fixture.companyAId),
    );
    const suppressionEntered = deferred();
    const releaseSuppression = deferred();
    const suppression = clients[0].withWorkspace(
      fixture.workspaceId,
      async (tx) => {
        await lockWorkspaceSuppressionPolicy(tx, fixture.workspaceId);
        await tx.suppressionRecord.upsert({
          where: {
            workspaceId_type_value: {
              workspaceId: fixture.workspaceId,
              type: 'domain',
              value: fixture.companyADomain,
            },
          },
          update: { protectionClass: 'LEGAL' },
          create: {
            workspaceId: fixture.workspaceId,
            type: 'domain',
            value: fixture.companyADomain,
            reason: 'legal',
            protectionClass: 'LEGAL',
          },
        });
        suppressionEntered.resolve();
        await releaseSuppression.promise;
      },
      { timeout: 15_000 },
    );
    await suppressionEntered.promise;

    const fit = clients[1].withWorkspace(
      fixture.workspaceId,
      (tx) =>
        upsertLeadFit(
          tx,
          fixture.workspaceId,
          fixture.icpId,
          fixture.companyAId,
          acceptedFitJudgment('must-not-update'),
          snapshot.fingerprint,
        ),
      { timeout: 15_000 },
    );
    expect(await stillPending(fit)).toBe(true);

    releaseSuppression.resolve();
    await suppression;
    const committed = await fit;
    const stats = { judged: committed ? 1 : 0, failed: committed ? 0 : 1 };
    expect(committed).toBe(false);
    expect(stats).toEqual({ judged: 0, failed: 1 });

    const persisted = await clients[2].withWorkspace(fixture.workspaceId, (tx) =>
      tx.lead.findUniqueOrThrow({ where: { id: fixture.leadId } }),
    );
    expect(persisted.fitVerdict).toBeNull();
    expect(persisted.fitReasons).toBeNull();
    expect(persisted.version).toBe(1);
  }, 20_000);

  it('makes a new Lead fit commit wait for a production-ordered company-name suppression, then reports failure without creating a Lead', async () => {
    const fixture = await createFixture(clients[0], { createLead: false });
    const snapshot = await clients[0].withWorkspace(fixture.workspaceId, (tx) =>
      loadOrganizationIdentitySnapshot(tx, fixture.workspaceId, fixture.companyAId),
    );
    const suppressionEntered = deferred();
    const releaseSuppression = deferred();
    const suppressionValue = fixture.companyAName.toLocaleLowerCase('en-US');
    const suppression = clients[0].withWorkspace(
      fixture.workspaceId,
      async (tx) => {
        await lockWorkspaceSuppressionPolicy(tx, fixture.workspaceId);
        await tx.suppressionRecord.upsert({
          where: {
            workspaceId_type_value: {
              workspaceId: fixture.workspaceId,
              type: 'company_name',
              value: suppressionValue,
            },
          },
          update: { protectionClass: 'LEGAL' },
          create: {
            workspaceId: fixture.workspaceId,
            type: 'company_name',
            value: suppressionValue,
            reason: 'legal',
            protectionClass: 'LEGAL',
          },
        });
        suppressionEntered.resolve();
        await releaseSuppression.promise;
      },
      { timeout: 15_000 },
    );
    await suppressionEntered.promise;

    const fit = clients[1].withWorkspace(
      fixture.workspaceId,
      (tx) =>
        upsertLeadFit(
          tx,
          fixture.workspaceId,
          fixture.icpId,
          fixture.companyAId,
          acceptedFitJudgment('must-not-create'),
          snapshot.fingerprint,
        ),
      { timeout: 15_000 },
    );
    expect(await stillPending(fit)).toBe(true);

    releaseSuppression.resolve();
    await suppression;
    const committed = await fit;
    const stats = { judged: committed ? 1 : 0, failed: committed ? 0 : 1 };
    expect(committed).toBe(false);
    expect(stats).toEqual({ judged: 0, failed: 1 });

    const leadCount = await clients[2].withWorkspace(fixture.workspaceId, (tx) =>
      tx.lead.count({
        where: {
          workspaceId: fixture.workspaceId,
          icpId: fixture.icpId,
          canonicalCompanyId: fixture.companyAId,
        },
      }),
    );
    expect(leadCount).toBe(0);
  }, 20_000);
});
