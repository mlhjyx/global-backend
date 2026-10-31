import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { createDiscoveryActivities } from '../temporal/discovery.activities';
import { DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION } from './discovery-company-materialization-ctx';
import { mapPublicWebCompanyToRecord } from './providers/public-web.provider';
import { prepareRawSourceBatch, type RawSourcePolicySnapshot } from './raw-source-ingestion';
import { persistPreparedRawSourceRecord } from './raw-source-writer';
import { PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN } from './source-policy-scope';

// Batches heartbeat between transactions; outside a Temporal worker there is no activity context.
vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: vi.fn(),
}));

/*
 * Release B of governed Discovery company materialization (C-TX), on a dedicated empty PostgreSQL.
 * The suite migrates the database with `prisma migrate deploy` to everything except the
 * activation migration, writes a v1-marked run whose query phase is complete and a pre-C run
 * without the marker, and proves canonicalize refuses the v1 run there. It then applies the
 * activation migration the way a deploy does (`prisma migrate deploy` over the real migrations)
 * and proves that the same run is admitted and materializes its ACCEPTED public_web Raw record
 * into a canonical company (also across two batch transactions), that row triggers reject any
 * UPDATE, DELETE or second INSERT of the activation row, that new runs must carry
 * the marker, and that the pre-C run keeps the legacy path. Canonicalize runs through the
 * production activity (createDiscoveryActivities().canonicalizeRun) as app_user.
 *
 * Explicitly opted-in only: DISCOVERY_MATERIALIZATION_ACTIVATION_DATABASE_TEST=1 with an owner
 * URL (a superuser, as the migrations require) and an app_user URL, both on a loopback host and
 * on the same empty database named *_test. The suite leaves that database migrated; drop it.
 */
const enabled = process.env.DISCOVERY_MATERIALIZATION_ACTIVATION_DATABASE_TEST === '1';
const ownerUrl = process.env.DISCOVERY_MATERIALIZATION_ACTIVATION_TEST_DATABASE_URL;
const appUrl = process.env.DISCOVERY_MATERIALIZATION_ACTIVATION_TEST_APP_DATABASE_URL;
if (enabled && (!ownerUrl || !appUrl)) {
  throw new Error(
    'DISCOVERY_MATERIALIZATION_ACTIVATION_DATABASE_TEST=1 needs DISCOVERY_MATERIALIZATION_ACTIVATION_TEST_DATABASE_URL and DISCOVERY_MATERIALIZATION_ACTIVATION_TEST_APP_DATABASE_URL',
  );
}
const urls = [ownerUrl, appUrl].filter((value): value is string => Boolean(value)).map((value) => new URL(value));
if (
  urls.some((url) =>
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !/^\/[a-z0-9_]+_test$/u.test(url.pathname) ||
    url.host !== urls[0]!.host ||
    url.pathname !== urls[0]!.pathname)
) {
  throw new Error('discovery materialization activation test requires one loopback *_test database');
}

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCHEMA = join(REPOSITORY_ROOT, 'packages/db/prisma/schema.prisma');
const MIGRATIONS = join(REPOSITORY_ROOT, 'packages/db/prisma/migrations');
const RELEASE_B = '20261011100000_discovery_company_materialization_activation';
const CONTRACT_SHA256 = '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe';
const Q_CONTRACT_SHA256 = 'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c';
const A_CONTRACT_SHA256 = 'dd2f4144f58de22f7415dfc11be56c4828c137e52d34e916852e64cfde38a2e1';
const TIMEOUT = 300_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** `prisma migrate deploy` exactly as a deploy runs it, against the schema's migrations directory. */
function migrateDeploy(schemaPath: string): string {
  const prismaCli = createRequire(join(REPOSITORY_ROOT, 'packages/db/package.json'))
    .resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', schemaPath], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: ownerUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    timeout: 240_000,
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** A copy of the migrations directory without the activation migration: the release before B. */
function releaseBeforeActivation(): string {
  const root = mkdtempSync(join(tmpdir(), 'discovery-materialization-release-a-'));
  copyFileSync(SCHEMA, join(root, 'schema.prisma'));
  mkdirSync(join(root, 'migrations'));
  for (const entry of readdirSync(MIGRATIONS, { withFileTypes: true })) {
    if (entry.name === RELEASE_B) continue;
    cpSync(join(MIGRATIONS, entry.name), join(root, 'migrations', entry.name), { recursive: true });
  }
  return root;
}

type RawFixture = Readonly<{ id: string; payloadHash: string; domain: string; name: string }>;
type RunFixture = Readonly<{
  runId: string;
  rawRecordId: string;
  domain: string;
  name: string;
  raws: readonly RawFixture[];
  input: Readonly<{
    workspaceId: string;
    runId: string;
    executionContractVersion: 2;
    executionBudget: Readonly<Record<string, unknown>>;
  }>;
}>;

describe.runIf(enabled)('Discovery company materialization activation (Release B) on PostgreSQL', () => {
  // Created only when the suite runs: collecting a skipped suite still executes this body.
  let owner: PrismaClient;
  let app: PrismaService;
  let activities: ReturnType<typeof createDiscoveryActivities>;
  let releaseA: string | undefined;
  const workspaceId = randomUUID();
  // Starts with a letter: an all-digit suffix (about 1 run in 40) made `<subject>-<digits>.de` a
  // phone-like run of 7+ digits, and the Raw contact check rejected the fixture records.
  const suffix = `a${randomBytes(4).toString('hex')}`;
  let governed: RunFixture;
  let legacy: RunFixture;
  let governedItemId: string;

  function binding(subject: string) {
    const requestSha256 = sha256(`discovery-materialization-activation:${subject}:${suffix}`);
    return {
      authorityId: randomUUID(),
      replay: false,
      scopeKey: workspaceId,
      accountKey: `discovery.run:discovery_run:request:${requestSha256}:${requestSha256}`,
      purpose: 'discovery.run',
      subjectType: 'discovery_run',
      subjectId: `request:${requestSha256}`,
      requestSha256,
    } as const;
  }

  /** The planner's READY plan; its ICP chain is upstream of canonicalize and not under test. */
  async function insertPlan(planId: string, queries: unknown[]): Promise<void> {
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`
        INSERT INTO discovery_query_plan(id, workspace_id, icp_id, status, queries, updated_at)
        VALUES (${planId}::uuid, ${workspaceId}::uuid, ${randomUUID()}::uuid, 'READY',
          ${JSON.stringify(queries)}::jsonb, now())`;
    });
  }

  /** An ACCEPTED public_web record, prepared and persisted by the real Raw ingestion path. */
  async function writeRawRecord(runId: string, domain: string, name: string): Promise<{ id: string; payloadHash: string }> {
    const record = mapPublicWebCompanyToRecord({
      domain,
      hitUrls: [`https://${domain}/produkte`],
      sourceText: `- ${name}\n  URL: https://${domain}/produkte`,
      extracted: { is_company_site: true, name, country: 'Germany', products: ['pumps'] },
      sourceClass: 'public_intelligence',
      fetchedAt: new Date().toISOString(),
    });
    const policies: RawSourcePolicySnapshot[] = await app.sourcePolicy.findMany({
      select: { id: true, domain: true, retentionDays: true, reviewStatus: true, allowedPurpose: true, updatedAt: true },
    });
    const [row] = prepareRawSourceBatch({ providerKey: 'public_web', records: [record], policies }).rows;
    expect(row?.ingestStatus).toBe('ACCEPTED');
    const receipt = await app.withWorkspace(workspaceId, (tx) =>
      persistPreparedRawSourceRecord(tx, {
        workspaceId,
        runId,
        sourceEntityId: null,
        providerKey: 'public_web',
        sourceClass: 'public_intelligence',
        row: row!,
      }));
    expect(receipt).toMatchObject({ ingestStatus: 'ACCEPTED', inserted: true });
    return { id: receipt.id, payloadHash: receipt.payloadHash };
  }

  /** One READY plan with a single public_web query, its run, and `records` ACCEPTED Raw records. */
  async function createRun(subject: string, marker: string | null, records = 1): Promise<RunFixture> {
    const runId = randomUUID();
    const planId = randomUUID();
    await insertPlan(planId, [{ source: 'public_web' }]);
    await owner.$executeRaw`
      INSERT INTO discovery_run(id, workspace_id, plan_id, icp_id, status, materialization_contract_version)
      VALUES (${runId}::uuid, ${workspaceId}::uuid, ${planId}::uuid, ${randomUUID()}::uuid, 'RUNNING', ${marker})`;
    const raws: RawFixture[] = [];
    for (let index = 0; index < records; index += 1) {
      const domain = records === 1 ? `${subject}-${suffix}.de` : `${subject}-${index}-${suffix}.de`;
      const name = subject === 'governed' ? 'Pumpen Aktivierung GmbH'
        : subject === 'legacy' ? 'Ventile Bestand GmbH' : `Pumpen Charge ${index} GmbH`;
      raws.push({ ...(await writeRawRecord(runId, domain, name)), domain, name });
    }
    return {
      runId,
      rawRecordId: raws[0]!.id,
      domain: raws[0]!.domain,
      name: raws[0]!.name,
      raws,
      input: { workspaceId, runId, executionContractVersion: 2, executionBudget: binding(subject) },
    };
  }

  /*
   * The query phase's governed lineage for the run's one query, one ACCEPTED item per Raw record:
   * a consumed workspace Grant, its settled operation and domain ack, the Q receipt/outcome/attempt
   * and one A relation from the operation to each Raw record, as the Q-TX writer leaves them.
   */
  async function completeQueryPhase(run: RunFixture): Promise<string[]> {
    const budget = run.input.executionBudget as ReturnType<typeof binding>;
    const accountId = randomUUID();
    const operationId = randomUUID();
    const records = run.raws.length;
    const queryKey = sha256(`query:${run.runId}`);
    const domainAckKey = sha256(`ack-key:${run.runId}`);
    const domainRevision = sha256(`ack-revision:${run.runId}`);
    await owner.$executeRaw`
      INSERT INTO execution_budget_authority(id, scope_key, authority_kind, workspace_id, issuer, audience, jti,
        token_sha256, schema_version, purpose, subject_type, subject_id, request_sha256, currency, unit,
        cap_microusd, runs_consumed, issued_at, not_before, expires_at, consumed_at)
      VALUES (${budget.authorityId}::uuid, ${workspaceId}, 'WORKSPACE_GRANT', ${workspaceId}::uuid,
        'https://control.example.test', 'global-backend:execution-budget', ${randomUUID()}::uuid,
        ${sha256(`token:${run.runId}`)}, 'execution-budget-grant/v1', 'discovery.run', 'discovery_run',
        ${budget.subjectId}, ${budget.requestSha256}, 'USD', 'microusd', 1000, 1,
        now() - interval '30 seconds', now() - interval '20 seconds', now() + interval '4 minutes',
        now() - interval '10 seconds')`;
    await owner.$executeRaw`
      INSERT INTO tool_budget_account(id, scope_key, account_key, generation, cap_cents, reserved_cents,
        charged_cents, exhausted, ref_count, authority_id, authorized_cap_microusd, reserved_microusd,
        charged_microusd, created_at, updated_at)
      VALUES (${accountId}::uuid, ${workspaceId}, ${budget.accountKey}, 1, 0, 0, 0, false, 1,
        ${budget.authorityId}::uuid, 1000, 0, 50, now(), now())`;
    await owner.$executeRaw`
      WITH projection AS (
        SELECT value, generic_operation_projection_digest(value) AS digest
        FROM (SELECT jsonb_build_object('schemaVersion', 'generic-operation-projection/v1', 'kind', 'model',
          'schema', 'discovery-extract-company/v1', 'data', jsonb_build_object('companies', '[]'::jsonb)) AS value) base
      )
      INSERT INTO tool_budget_operation(id, scope_key, account_id, generation, operation_key, amount_unit,
        reserved_cents, reserved_microusd, observed_microusd, charged_microusd, result_schema_version,
        result_schema, result_digest, result_json, status, receipt_usage, receipt_cost_basis, settled_at, created_at)
      SELECT ${operationId}::uuid, ${workspaceId}, ${accountId}::uuid, 1, ${`mine-domain:${run.domain}`}, 'microusd',
        0, 100, 50, 50, 'generic-operation-projection/v1', 'discovery-extract-company/v1', projection.digest,
        projection.value || jsonb_build_object('digest', projection.digest), 'SETTLED',
        jsonb_build_object('currency', 'USD', 'unit', 'microusd', 'callCount', 1, 'upperBoundMicrousd', '100'),
        'estimated_upper_bound', now(), now()
      FROM projection`;
    await app.withWorkspace(workspaceId, (tx) => tx.$queryRaw`
      SELECT status FROM apply_execution_domain_ack_v1(${workspaceId}::text, ${operationId}::uuid,
        'PublicWebDiscoveryProvider.mineDomain'::text, 'RawSourceRecord'::text, ${domainAckKey}::text,
        ${domainRevision}::text)`);
    const [ack] = await owner.$queryRaw<Array<{ ack_id: string; result_digest: string }>>`
      SELECT a.ack_id::text AS ack_id, o.result_digest::text AS result_digest
      FROM execution_domain_ack a JOIN tool_budget_operation o ON o.id = a.operation_id
      WHERE a.operation_id = ${operationId}::uuid`;
    expect(ack).toBeDefined();
    await owner.$executeRaw`
      INSERT INTO discovery_query_receipt(workspace_id, run_id, plan_id, authority_id, account_key, purpose,
        subject_type, subject_id, request_sha256, query_key, query_ordinal, source_class, providers,
        provider_count, record_count, accepted_count, quarantined_count, rejected_count, duplicate_count,
        governance_denied_count, usage_quantity, cost_cents, contract_sha256)
      SELECT ${workspaceId}::uuid, run.id, run.plan_id, ${budget.authorityId}::uuid, ${budget.accountKey},
        'discovery.run', 'discovery_run', ${budget.subjectId}, ${budget.requestSha256}, ${queryKey}, 0,
        'public_intelligence', '["public_web"]'::jsonb, 1, ${records}, ${records}, 0, 0, 0, 0, ${records}, 0,
        ${Q_CONTRACT_SHA256}
      FROM discovery_run run WHERE run.id = ${run.runId}::uuid`;
    await owner.$executeRaw`
      INSERT INTO discovery_query_execution_outcome(workspace_id, run_id, query_key, budget_truncated, contract_sha256)
      VALUES (${workspaceId}::uuid, ${run.runId}::uuid, ${queryKey}, false, ${Q_CONTRACT_SHA256})`;
    await owner.$executeRaw`
      INSERT INTO discovery_query_operation_attempt(workspace_id, run_id, query_key, provider_key, producer_id,
        operation_id, scope_key, authority_id, account_id, operation_generation, ack_id, consumer,
        domain_aggregate_type, domain_ack_key, domain_revision, result_digest, result_schema, lineage_schema,
        provider_record_count, covered_item_count, contract_sha256)
      VALUES (${workspaceId}::uuid, ${run.runId}::uuid, ${queryKey}, 'public_web', 'discovery.extract_company',
        ${operationId}::uuid, ${workspaceId}, ${budget.authorityId}::uuid, ${accountId}::uuid, 1, ${ack!.ack_id},
        'PublicWebDiscoveryProvider.mineDomain', 'RawSourceRecord', ${domainAckKey}, ${domainRevision},
        ${ack!.result_digest}, 'discovery-extract-company/v1', 'discovery-company-result-lineage/v1',
        ${records}, ${records}, ${Q_CONTRACT_SHA256})`;
    const itemIds: string[] = [];
    for (const [recordIndex, raw] of run.raws.entries()) {
      const itemId = randomUUID();
      const relationKey = `discovery.raw_source_record:${recordIndex}`;
      const [relation] = await app.withWorkspace(workspaceId, (tx) => tx.$queryRaw<Array<{
        operation_subject_id: string; child_subject_id: string; relation_id: string;
      }>>`
        SELECT operation_subject_id::text, child_subject_id::text, relation_id::text
        FROM append_workspace_governed_child_relation_v1(
          ${workspaceId}::uuid, ${budget.authorityId}::uuid, ${accountId}::uuid, ${operationId}::uuid, 1,
          ${ack!.ack_id}::char(64), ${ack!.result_digest}::char(64), 'tool_operation', ${operationId}::uuid,
          'NON_PERSONAL', NULL, NULL, NULL, 'raw_source_record', ${raw.id}::uuid, 'NON_PERSONAL',
          NULL, NULL, ${relationKey}, 'MATERIALIZED_CHILD', 'discovery_query_attempt_item',
          ${itemId}::uuid, NULL, ${A_CONTRACT_SHA256}::char(64))`);
      expect(relation).toBeDefined();
      await owner.$executeRaw`
        INSERT INTO discovery_query_attempt_item(id, workspace_id, run_id, query_key, provider_key, operation_id,
          record_index, resolution_kind, raw_record_id, raw_payload_hash, raw_ingest_status, relation_key,
          operation_subject_id, child_subject_id, relation_id, contract_sha256)
        VALUES (${itemId}::uuid, ${workspaceId}::uuid, ${run.runId}::uuid, ${queryKey}, 'public_web',
          ${operationId}::uuid, ${recordIndex}, 'INSERTED', ${raw.id}::uuid, ${raw.payloadHash}, 'ACCEPTED',
          ${relationKey}, ${relation!.operation_subject_id}::uuid,
          ${relation!.child_subject_id}::uuid, ${relation!.relation_id}::uuid, ${A_CONTRACT_SHA256})`;
      itemIds.push(itemId);
    }
    return itemIds;
  }

  async function admissionOf(runId: string) {
    return owner.$queryRaw<Array<{ mode: string; reason_code: string; materialization_contract_version: string | null }>>`
      SELECT mode::text, reason_code::text, materialization_contract_version
      FROM discovery_company_materialization_admission WHERE run_id = ${runId}::uuid`;
  }

  async function activationRows() {
    return owner.$queryRaw<Array<{ activation_id: number; contract_version: string; contract_sha256: string }>>`
      SELECT activation_id::int AS activation_id, contract_version, contract_sha256::text AS contract_sha256
      FROM discovery_company_materialization_activation ORDER BY activation_id`;
  }

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    const [state] = await owner.$queryRaw<Array<{ superuser: string; tables: bigint }>>`
      SELECT current_setting('is_superuser') AS superuser,
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')) AS tables`;
    if (state?.superuser !== 'on' || state.tables !== 0n) {
      throw new Error('the activation suite needs a superuser URL to an empty database it migrates itself');
    }
    releaseA = releaseBeforeActivation();
    migrateDeploy(join(releaseA, 'schema.prisma'));

    const previousAppUrl = process.env.APP_DATABASE_URL;
    process.env.APP_DATABASE_URL = appUrl;
    try {
      app = new PrismaService();
    } finally {
      if (previousAppUrl === undefined) delete process.env.APP_DATABASE_URL;
      else process.env.APP_DATABASE_URL = previousAppUrl;
    }
    const [principal] = await app.$queryRaw<Array<{ session: string; superuser: string; bypass: boolean }>>`
      SELECT session_user::text AS session, current_setting('is_superuser') AS superuser,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass`;
    if (principal?.session !== 'app_user' || principal.superuser !== 'off' || principal.bypass !== false) {
      throw new Error('the app URL must log in as app_user, which RLS binds');
    }
    activities = createDiscoveryActivities({
      prisma: app,
      providers: {} as never,
      gateway: {} as never,
      // Only the legacy path attests the run's Grant; that attestation is not under test here.
      budgetStore: { attestAuthorized: async () => undefined } as never,
    });

    await owner.$executeRaw`
      INSERT INTO workspace(id, name, created_at, updated_at)
      VALUES (${workspaceId}::uuid, 'discovery materialization activation', now(), now())`;
    await owner.$executeRaw`
      INSERT INTO data_provider(id, key, class, status, cost_per_call_cents, created_at)
      VALUES (gen_random_uuid(), 'public_web', 'public_intelligence', 'ENABLED', 0, now())
      ON CONFLICT (key) DO UPDATE SET status = 'ENABLED'`;
    await owner.$executeRaw`
      INSERT INTO source_policy(id, domain, source_type, access_mode, allowed_purpose, retention_days,
        review_status, notes, created_at, updated_at)
      VALUES (gen_random_uuid(), ${PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN}, 'official_website', 'crawl',
        '["discovery","enrichment"]'::jsonb, 365, 'APPROVED',
        'discovery-company-materialization-activation.postgres.spec', now(), now())`;

    // Both runs exist before Release B: the image already writes the v1 marker, and a pre-C run
    // without it may still be in flight when the activation migration is applied.
    governed = await createRun('governed', DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION);
    legacy = await createRun('legacy', null);
    [governedItemId] = await completeQueryPhase(governed) as [string];
  }, TIMEOUT);

  afterAll(async () => {
    if (releaseA) rmSync(releaseA, { recursive: true, force: true });
    await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
  });

  it('refuses a v1 run whose query phase is complete while the contract is not activated', async () => {
    expect(await activationRows()).toEqual([]);
    await expect(activities.canonicalizeRun(governed.input as never)).rejects.toMatchObject({
      type: 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_UNAVAILABLE',
      nonRetryable: true,
    });
    expect(await admissionOf(governed.runId)).toEqual([]);
  }, TIMEOUT);

  it('activates the v1 contract once through prisma migrate deploy', async () => {
    const output = migrateDeploy(SCHEMA);
    expect(output).toContain(RELEASE_B);
    const applied = await owner.$queryRaw<Array<{ migration_name: string; finished: boolean }>>`
      SELECT migration_name, finished_at IS NOT NULL AND rolled_back_at IS NULL AS finished
      FROM _prisma_migrations WHERE migration_name = ${RELEASE_B}`;
    expect(applied).toEqual([{ migration_name: RELEASE_B, finished: true }]);
    expect(await activationRows()).toEqual([
      { activation_id: 1, contract_version: DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION, contract_sha256: CONTRACT_SHA256 },
    ]);
  }, TIMEOUT);

  it('admits the same run and materializes its ACCEPTED public_web record into a canonical company', async () => {
    await expect(activities.canonicalizeRun(governed.input as never)).resolves.toEqual({ companies: 1, suppressed: 0 });
    expect(await admissionOf(governed.runId)).toEqual([{
      mode: 'GOVERNED_C_TX',
      reason_code: 'GOVERNED_Q_V2_COMPLETE',
      materialization_contract_version: DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION,
    }]);
    const outcomes = await owner.$queryRaw<Array<{ outcome: string; mutation_class: string | null; canonical_company_id: string | null }>>`
      SELECT outcome::text, mutation_class::text, canonical_company_id::text
      FROM discovery_company_materialization_outcome WHERE query_item_id = ${governedItemId}::uuid`;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ outcome: 'CANONICALIZED', mutation_class: 'CREATED' });
    const companies = await owner.$queryRaw<Array<{ id: string; name: string; domain: string | null }>>`
      SELECT c.id::text, c.name, c.domain FROM canonical_company c
      JOIN identity_link l ON l.canonical_id = c.id AND l.canonical_type = 'company'
      WHERE l.raw_record_id = ${governed.rawRecordId}::uuid`;
    expect(companies).toEqual([{ id: outcomes[0]!.canonical_company_id, name: governed.name, domain: governed.domain }]);
    const receipts = await owner.$queryRaw<Array<{ companies_count: number; suppressed_count: number }>>`
      SELECT companies_count::int AS companies_count, suppressed_count::int AS suppressed_count
      FROM discovery_company_materialization_run_receipt WHERE run_id = ${governed.runId}::uuid`;
    expect(receipts).toEqual([{ companies_count: 1, suppressed_count: 0 }]);

    // A Temporal retry replays the run receipt and writes nothing new.
    await expect(activities.canonicalizeRun(governed.input as never)).resolves.toEqual({ companies: 1, suppressed: 0 });
    const [counts] = await owner.$queryRaw<Array<{ companies: bigint; outcomes: bigint }>>`
      SELECT (SELECT count(*) FROM canonical_company WHERE workspace_id = ${workspaceId}::uuid) AS companies,
        (SELECT count(*) FROM discovery_company_materialization_outcome WHERE run_id = ${governed.runId}::uuid) AS outcomes`;
    expect(counts).toEqual({ companies: 1n, outcomes: 1n });
  }, TIMEOUT);

  it('materializes a full 128-item batch and the next one, each in its own transaction', async () => {
    // 129 items: batch 0 holds 128 and batch 1 holds one, so the cursor resumes across transactions.
    const run = await createRun('batch', DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION, 129);
    await completeQueryPhase(run);
    await expect(activities.canonicalizeRun(run.input as never)).resolves.toEqual({ companies: 129, suppressed: 0 });
    const batches = await owner.$queryRaw<Array<{ batch_ordinal: number }>>`
      SELECT batch_ordinal::int AS batch_ordinal FROM discovery_company_materialization_batch_receipt
      WHERE run_id = ${run.runId}::uuid ORDER BY batch_ordinal`;
    expect(batches).toEqual([{ batch_ordinal: 0 }, { batch_ordinal: 1 }]);
    const [state] = await owner.$queryRaw<Array<{ canonicalized: bigint; companies: bigint }>>`
      SELECT (SELECT count(*) FROM discovery_company_materialization_outcome
          WHERE run_id = ${run.runId}::uuid AND outcome = 'CANONICALIZED') AS canonicalized,
        (SELECT count(DISTINCT l.canonical_id) FROM identity_link l
          JOIN raw_source_record r ON r.id = l.raw_record_id
          WHERE r.run_id = ${run.runId}::uuid AND l.canonical_type = 'company') AS companies`;
    expect(state).toEqual({ canonicalized: 129n, companies: 129n });
  }, TIMEOUT);

  it('rejects any UPDATE, DELETE or second INSERT of the activation row and requires the marker on new runs', async () => {
    const before = await activationRows();
    await expect(owner.$executeRaw`
      UPDATE discovery_company_materialization_activation SET activated_at = clock_timestamp()`)
      .rejects.toThrow(/DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_IMMUTABLE/u);
    await expect(owner.$executeRaw`DELETE FROM discovery_company_materialization_activation`)
      .rejects.toThrow(/DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_IMMUTABLE/u);
    await expect(owner.$executeRaw`
      INSERT INTO discovery_company_materialization_activation(activation_id, contract_version, contract_sha256)
      VALUES (1, ${DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION}, ${CONTRACT_SHA256})`)
      .rejects.toThrow(/DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_ACTIVATION_DENIED/u);
    await expect(owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.discovery_company_materialization_activation_v1', ${CONTRACT_SHA256}, true)`;
      await tx.$executeRaw`
        INSERT INTO discovery_company_materialization_activation(activation_id, contract_version, contract_sha256)
        VALUES (1, ${DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION}, ${CONTRACT_SHA256})`;
    })).rejects.toThrow(/Code: `23505`[\s\S]*\(activation_id\)=\(1\) already exists/u);
    expect(await activationRows()).toEqual(before);

    await expect(owner.$executeRaw`
      INSERT INTO discovery_run(id, workspace_id, plan_id, icp_id, status, materialization_contract_version)
      VALUES (${randomUUID()}::uuid, ${workspaceId}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, 'RUNNING', NULL)`)
      .rejects.toThrow(/DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_MARKER_REQUIRED/u);
  }, TIMEOUT);

  it('keeps the legacy path for a pre-C run created before the activation', async () => {
    await expect(activities.canonicalizeRun(legacy.input as never)).resolves.toEqual({ companies: 1, suppressed: 0 });
    expect(await admissionOf(legacy.runId)).toEqual([{
      mode: 'LEGACY',
      reason_code: 'PRE_C_NULL_MARKER',
      materialization_contract_version: null,
    }]);
    const [governedState] = await owner.$queryRaw<Array<{ outcomes: bigint; receipts: bigint }>>`
      SELECT (SELECT count(*) FROM discovery_company_materialization_outcome WHERE run_id = ${legacy.runId}::uuid) AS outcomes,
        (SELECT count(*) FROM discovery_company_materialization_run_receipt WHERE run_id = ${legacy.runId}::uuid) AS receipts`;
    expect(governedState).toEqual({ outcomes: 0n, receipts: 0n });
    const companies = await owner.$queryRaw<Array<{ name: string; domain: string | null }>>`
      SELECT c.name, c.domain FROM canonical_company c
      JOIN identity_link l ON l.canonical_id = c.id AND l.canonical_type = 'company'
      WHERE l.raw_record_id = ${legacy.rawRecordId}::uuid`;
    expect(companies).toEqual([{ name: legacy.name, domain: legacy.domain }]);
  }, TIMEOUT);
});
