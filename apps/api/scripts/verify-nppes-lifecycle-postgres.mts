/**
 * NPPES A -> D lifecycle acceptance against an isolated PostgreSQL database.
 *
 * This verifier intentionally uses controlled, official-shaped D observations:
 * a real registry entry cannot be made to change status on demand. It proves
 * persistence, RLS and lifecycle semantics; it is not evidence that NPPES
 * changed either sample during this run.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { commitNppesLifecycleFact } from '../src/discovery/nppes-lifecycle';
import { lockWorkspaceSuppressionPolicy } from '../src/discovery/suppression-policy-lock';
import { lockWorkspaceOrganizationIdentity } from '../src/discovery/organization-identity-root';

if (process.env.NPPES_LIFECYCLE_ACCEPTANCE !== '1') {
  console.log(JSON.stringify({ status: 'SKIPPED', reason: 'set NPPES_LIFECYCLE_ACCEPTANCE=1' }));
  process.exit(0);
}

const databaseUrl = process.env.APP_DATABASE_URL;
if (!databaseUrl) throw new Error('APP_DATABASE_URL is required');
const target = new URL(databaseUrl);
const databaseName = decodeURIComponent(target.pathname.replace(/^\/+|\/+$/gu, ''));
if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(target.hostname)) {
  throw new Error('NPPES lifecycle acceptance requires a loopback PostgreSQL target');
}
if (!/(acceptance|test|experiment)/iu.test(databaseName)) {
  throw new Error('NPPES lifecycle acceptance database name must contain acceptance, test, or experiment');
}

const db = new PrismaClient({ datasourceUrl: databaseUrl });
const workspaceId = randomUUID();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`NPPES lifecycle acceptance failed: ${message}`);
}

async function withWorkspace<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return inWorkspace(workspaceId, fn);
}

async function inWorkspace<T>(
  targetWorkspaceId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${targetWorkspaceId}, true)`;
    return fn(tx);
  });
}

type Seeded = {
  companyId: string;
  leadId: string;
  activeRawId: string;
  deactivatedRawId: string;
  npi: string;
};

async function seedScenario(input: { npi: string; delivered: boolean }): Promise<Seeded> {
  return withWorkspace(async (tx) => {
    const seller = await tx.companyProfile.create({
      data: { workspaceId, name: `NPPES lifecycle seller ${input.npi}`, industry: 'healthcare equipment' },
    });
    const icp = await tx.icpDefinition.create({
      data: {
        workspaceId,
        companyId: seller.id,
        name: `US healthcare organizations ${input.npi}`,
        status: 'ACTIVE',
        companyAttributes: { industry: 'healthcare' },
        triggerSignals: ['official NPI-2 registry presence'],
      },
    });
    const company = await tx.canonicalCompany.create({
      data: {
        workspaceId,
        name: `Lifecycle Clinic ${input.npi}`,
        country: 'US',
        status: 'NEW',
        dedupeKey: `id:us_npi:${input.npi}`,
        attributes: { nppes: { npi: input.npi, entity_type: 'NPI-2', status: 'A' } },
      },
    });
    const plan = await tx.discoveryQueryPlan.create({
      data: {
        workspaceId,
        icpId: icp.id,
        status: 'EXECUTED',
        queries: [{
          source_class: 'company_registry',
          filters: { source_hint: 'nppes', country: 'US', healthcare: true, npi: input.npi },
          keywords: [],
          priority: 1,
          limit: 1,
        }],
      },
    });
    const run = await tx.discoveryRun.create({
      data: { workspaceId, planId: plan.id, icpId: icp.id, status: 'DONE', completedAt: new Date('2026-08-13T14:00:00.000Z') },
    });
    const activeRaw = await tx.rawSourceRecord.create({
      data: {
        workspaceId,
        runId: run.id,
        providerKey: 'nppes',
        sourceClass: 'company_registry',
        externalId: `nppes:${input.npi}:active`,
        payload: { name: company.name, country: 'US', attributes: { nppes: { status: 'A' } } },
        sourceUrl: `https://npiregistry.cms.hhs.gov/api/?version=2.1&enumeration_type=NPI-2&number=${input.npi}`,
        fetchedAt: new Date('2026-08-13T12:00:00.000Z'),
        contentHash: 'a'.repeat(64),
        parserVersion: 'nppes-v2.1/1',
        ingestVersion: 'raw-source/v1',
        ingestStatus: 'ACCEPTED',
      },
    });
    await tx.organizationIdentifier.create({
      data: {
        workspaceId,
        companyId: company.id,
        scheme: 'us_npi',
        jurisdiction: 'US',
        normalizedValue: input.npi,
        authorityProviderKey: 'nppes',
        rawRecordId: activeRaw.id,
        confidence: 1,
        normalizerVersion: 'identity-normalizer-v1',
        validatorVersion: 'npi-v1',
        status: 'ACTIVE',
      },
    });
    await tx.identityLink.create({
      data: {
        workspaceId,
        canonicalType: 'company',
        canonicalId: company.id,
        rawRecordId: activeRaw.id,
        matchRule: 'identity_v2',
        confidence: 1,
        status: 'ACTIVE',
        resolverVersion: 'organization-identity-v2',
        inputHash: 'b'.repeat(64),
      },
    });
    const lead = await tx.lead.create({
      data: {
        workspaceId,
        icpId: icp.id,
        canonicalCompanyId: company.id,
        status: 'REVIEW',
        queue: 'needs_review',
      },
    });
    if (input.delivered) {
      await tx.outboxEvent.create({
        data: {
          workspaceId,
          eventType: 'LeadQualified',
          schemaVersion: 1,
          aggregateType: 'lead',
          aggregateId: lead.id,
          payload: { acceptanceFixture: true },
        },
      });
    }
    const deactivatedRaw = await tx.rawSourceRecord.create({
      data: {
        workspaceId,
        runId: run.id,
        providerKey: 'nppes',
        sourceClass: 'company_registry',
        externalId: `nppes:${input.npi}:deactivated`,
        payload: {
          name: company.name,
          country: 'US',
          identifiers: [{ scheme: 'us_npi', jurisdiction: 'US', value: input.npi }],
          attributes: { nppes: { status: 'D', observation_scope: 'exact_npi', candidate_eligible: false } },
        },
        sourceUrl: `https://npiregistry.cms.hhs.gov/api/?version=2.1&enumeration_type=NPI-2&number=${input.npi}`,
        fetchedAt: new Date('2026-08-13T13:00:00.000Z'),
        contentHash: 'd'.repeat(64),
        parserVersion: 'nppes-v2.1/1',
        ingestVersion: 'raw-source/v1',
        ingestStatus: 'ACCEPTED',
      },
    });
    return {
      companyId: company.id,
      leadId: lead.id,
      activeRawId: activeRaw.id,
      deactivatedRawId: deactivatedRaw.id,
      npi: input.npi,
    };
  });
}

async function applyDeactivation(seed: Seeded) {
  return withWorkspace(async (tx) => {
    await lockWorkspaceSuppressionPolicy(tx, workspaceId);
    return commitNppesLifecycleFact(tx, {
      workspaceId,
      raw: {
        id: seed.deactivatedRawId,
        providerKey: 'nppes',
        sourceUrl: `https://npiregistry.cms.hhs.gov/api/?version=2.1&enumeration_type=NPI-2&number=${seed.npi}`,
        fetchedAt: new Date('2026-08-13T13:00:00.000Z'),
        contentHash: 'd'.repeat(64),
        parserVersion: 'nppes-v2.1/1',
      },
      record: {
        name: `Lifecycle Clinic ${seed.npi}`,
        country: 'US',
        identifiers: [{ scheme: 'us_npi', jurisdiction: 'US', value: seed.npi }],
        attributes: {
          nppes: {
            npi: seed.npi,
            entity_type: 'NPI-2',
            status: 'D',
            candidate_eligible: false,
            observation_scope: 'exact_npi',
          },
        },
      },
      now: new Date('2026-08-13T13:00:01.000Z'),
    });
  });
}

async function simulatedAccept(
  seed: Seeded,
  onLocked?: () => Promise<void>,
): Promise<boolean> {
  return withWorkspace(async (tx) => {
    await lockWorkspaceSuppressionPolicy(tx, workspaceId);
    await lockWorkspaceOrganizationIdentity(tx, workspaceId);
    await tx.$queryRaw`SELECT id FROM canonical_company WHERE workspace_id = ${workspaceId}::uuid AND id = ${seed.companyId}::uuid FOR UPDATE`;
    const company = await tx.canonicalCompany.findUniqueOrThrow({ where: { id: seed.companyId }, select: { status: true } });
    if (company.status === 'SUPPRESSED') return false;
    if (onLocked) await onLocked();
    await tx.lead.update({ where: { id: seed.leadId }, data: { status: 'QUALIFIED', version: { increment: 1 } } });
    await tx.outboxEvent.create({
      data: {
        workspaceId,
        eventType: 'LeadQualified',
        schemaVersion: 1,
        aggregateType: 'lead',
        aggregateId: seed.leadId,
        payload: { acceptanceFixture: true, concurrent: true },
      },
    });
    return true;
  });
}

await db.$connect();
try {
  const role = await db.$queryRaw<{ role: string; superuser: boolean; bypassrls: boolean }[]>`
    SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS bypassrls
    FROM pg_roles WHERE rolname = current_user`;
  assert(role[0] && !role[0].superuser && !role[0].bypassrls, 'database role must enforce RLS');
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    await tx.workspace.create({ data: { id: workspaceId, name: 'NPPES lifecycle PostgreSQL acceptance' } });
  });

  const mutable = await seedScenario({ npi: '1881018208', delivered: false });
  const delivered = await seedScenario({ npi: '1922074434', delivered: true });
  const mutableResult = await applyDeactivation(mutable);
  const deliveredResult = await applyDeactivation(delivered);
  const replayResult = await applyDeactivation(mutable);

  // D commits first: a later accept must observe SUPPRESSED and emit no event.
  const deactivationFirst = await seedScenario({ npi: '1912403536', delivered: false });
  await applyDeactivation(deactivationFirst);
  const acceptedAfterDeactivation = await simulatedAccept(deactivationFirst);
  assert(!acceptedAfterDeactivation, 'accept must stop after a committed D fact');

  // Accept owns the shared locks first. D waits, then preserves the committed
  // commercial fact while suppressing the company from new acquisition work.
  const acceptFirst = await seedScenario({ npi: '1821326570', delivered: false });
  let releaseAccept!: () => void;
  let announceAcceptLocked!: () => void;
  const acceptLocked = new Promise<void>((resolve) => { announceAcceptLocked = resolve; });
  const acceptRelease = new Promise<void>((resolve) => { releaseAccept = resolve; });
  const acceptPromise = simulatedAccept(acceptFirst, async () => {
    announceAcceptLocked();
    await acceptRelease;
  });
  await acceptLocked;
  let deactivationSettled = false;
  const blockedDeactivation = applyDeactivation(acceptFirst).finally(() => { deactivationSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(!deactivationSettled, 'D must wait behind the accept lock');
  releaseAccept();
  assert(await acceptPromise, 'accept-first branch must commit its commercial fact');
  const acceptFirstResult = await blockedDeactivation;
  assert(acceptFirstResult.kind === 'deactivated' && acceptFirstResult.requiresManualFollowup, 'D must preserve accept-first fact');

  const otherWorkspaceId = randomUUID();
  await inWorkspace(otherWorkspaceId, async (tx) => {
    await tx.workspace.create({ data: { id: otherWorkspaceId, name: 'NPPES lifecycle RLS isolation control' } });
  });
  const crossTenant = await inWorkspace(otherWorkspaceId, async (tx) => ({
    companies: await tx.canonicalCompany.count({ where: { id: mutable.companyId } }),
    leads: await tx.lead.count({ where: { id: mutable.leadId } }),
    identifiers: await tx.organizationIdentifier.count({ where: { companyId: mutable.companyId } }),
    raw: await tx.rawSourceRecord.count({ where: { id: mutable.deactivatedRawId } }),
  }));
  assert(Object.values(crossTenant).every((count) => count === 0), 'workspace B must not observe workspace A lifecycle rows');

  const evidence = await withWorkspace(async (tx) => ({
    companies: await tx.canonicalCompany.findMany({
      where: { id: { in: [mutable.companyId, delivered.companyId] } },
      select: { id: true, status: true, version: true },
      orderBy: { id: 'asc' },
    }),
    leads: await tx.lead.findMany({
      where: { id: { in: [mutable.leadId, delivered.leadId] } },
      select: { id: true, status: true, queue: true, version: true },
      orderBy: { id: 'asc' },
    }),
    identifiers: await tx.organizationIdentifier.findMany({
      where: { companyId: { in: [mutable.companyId, delivered.companyId] } },
      select: { companyId: true, normalizedValue: true, status: true },
      orderBy: { normalizedValue: 'asc' },
    }),
    lifecycleLinks: await tx.identityLink.count({
      where: { rawRecordId: { in: [mutable.deactivatedRawId, delivered.deactivatedRawId] }, status: 'ACTIVE' },
    }),
    lifecycleEvidence: await tx.fieldEvidence.count({
      where: {
        entityId: { in: [mutable.companyId, delivered.companyId] },
        field: 'nppes.status',
        value: { equals: 'D' },
      },
    }),
    rawCount: await tx.rawSourceRecord.count({
      where: { id: { in: [mutable.activeRawId, mutable.deactivatedRawId, delivered.activeRawId, delivered.deactivatedRawId] } },
    }),
    deactivationFirst: {
      company: await tx.canonicalCompany.findUniqueOrThrow({ where: { id: deactivationFirst.companyId }, select: { status: true } }),
      lead: await tx.lead.findUniqueOrThrow({ where: { id: deactivationFirst.leadId }, select: { status: true } }),
      delivered: await tx.outboxEvent.count({ where: { eventType: 'LeadQualified', aggregateId: deactivationFirst.leadId } }),
    },
    acceptFirst: {
      company: await tx.canonicalCompany.findUniqueOrThrow({ where: { id: acceptFirst.companyId }, select: { status: true } }),
      lead: await tx.lead.findUniqueOrThrow({ where: { id: acceptFirst.leadId }, select: { status: true } }),
      delivered: await tx.outboxEvent.count({ where: { eventType: 'LeadQualified', aggregateId: acceptFirst.leadId } }),
    },
  }));

  const mutableLead = evidence.leads.find((lead) => lead.id === mutable.leadId);
  const deliveredLead = evidence.leads.find((lead) => lead.id === delivered.leadId);
  assert(mutableResult.kind === 'deactivated' && !mutableResult.requiresManualFollowup, 'mutable result');
  assert(deliveredResult.kind === 'deactivated' && deliveredResult.requiresManualFollowup, 'delivered result');
  assert(replayResult.kind === 'deactivated' && replayResult.suppressedLeads === 0, 'idempotent replay');
  assert(evidence.companies.every((company) => company.status === 'SUPPRESSED'), 'companies suppressed');
  assert(mutableLead?.status === 'SUPPRESSED' && mutableLead.queue === 'suppressed', 'mutable lead suppressed');
  assert(deliveredLead?.status === 'REVIEW' && deliveredLead.queue === 'needs_review', 'delivered lead preserved');
  assert(evidence.identifiers.length === 2 && evidence.identifiers.every((identifier) => identifier.status === 'ACTIVE'), 'NPI identity remains active');
  assert(evidence.lifecycleLinks === 2, 'lifecycle identity links retained');
  assert(evidence.lifecycleEvidence === 2, 'lifecycle evidence retained once per Raw');
  assert(evidence.rawCount === 4, 'all active/deactivated Raw facts retained');
  assert(evidence.deactivationFirst.company.status === 'SUPPRESSED', 'D-first company suppressed');
  assert(evidence.deactivationFirst.lead.status === 'SUPPRESSED' && evidence.deactivationFirst.delivered === 0, 'D-first accept blocked');
  assert(evidence.acceptFirst.company.status === 'SUPPRESSED', 'accept-first company later suppressed');
  assert(evidence.acceptFirst.lead.status === 'QUALIFIED' && evidence.acceptFirst.delivered === 1, 'accept-first commercial fact preserved');

  console.log(JSON.stringify({
    status: 'PASS',
    evidenceType: 'controlled-official-shaped-lifecycle-observation',
    workspaceId,
    database: databaseName,
    role: role[0],
    mutable: { ...mutable, result: mutableResult, lead: mutableLead },
    delivered: { ...delivered, result: deliveredResult, lead: deliveredLead },
    replay: replayResult,
    concurrency: {
      deactivationFirst: evidence.deactivationFirst,
      acceptFirst: evidence.acceptFirst,
    },
    crossTenant,
    retained: {
      raw: evidence.rawCount,
      identifiers: evidence.identifiers,
      lifecycleLinks: evidence.lifecycleLinks,
      lifecycleEvidence: evidence.lifecycleEvidence,
    },
  }, null, 2));
} finally {
  await db.$disconnect();
}
