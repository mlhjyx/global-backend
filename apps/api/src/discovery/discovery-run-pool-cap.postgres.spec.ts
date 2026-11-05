import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { createDiscoveryActivities } from '../temporal/discovery.activities';
import { DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION } from './discovery-company-materialization-ctx';
import { mapPublicWebCompanyToRecord } from './providers/public-web.provider';
import { mapWikidataCompanyToRecord } from './providers/wikidata.provider';
import { prepareRawSourceBatch, type RawSourcePolicySnapshot } from './raw-source-ingestion';
import { persistPreparedRawSourceRecord } from './raw-source-writer';
import { PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN } from './source-policy-scope';

// Batches heartbeat between transactions; outside a Temporal worker there is no activity context.
vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  heartbeat: vi.fn(),
}));

/*
 * Q33② run 总池帽（docs/superpowers/plans/2026-11-05-run-pool-cap.md）：在真库上证明
 * 单个 run 的物化公司总量不超过 DISCOVERY_RUN_POOL_CAP（默认 500）——恰好 500 边界、
 * 跨查询累计、public_web 与 wikidata 混合；达界行落 NOT_CANONICALIZABLE/RUN_POOL_CAP_REACHED，
 * run stats 与 run_event 留痕；env=off 恢复不设闸。
 *
 * 显式开启：DISCOVERY_RUN_POOL_CAP_DATABASE_TEST=1 + 一个空的 *_test 库的 owner URL（superuser，
 * 迁移需要）与 app_user URL（同一库、回环地址）。套件会把该库迁移到 head 并留下数据，用完删库。
 */
const enabled = process.env.DISCOVERY_RUN_POOL_CAP_DATABASE_TEST === '1';
const ownerUrl = process.env.DISCOVERY_RUN_POOL_CAP_TEST_DATABASE_URL;
const appUrl = process.env.DISCOVERY_RUN_POOL_CAP_TEST_APP_DATABASE_URL;
if (enabled && (!ownerUrl || !appUrl)) {
  throw new Error(
    'DISCOVERY_RUN_POOL_CAP_DATABASE_TEST=1 needs DISCOVERY_RUN_POOL_CAP_TEST_DATABASE_URL and DISCOVERY_RUN_POOL_CAP_TEST_APP_DATABASE_URL',
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
  throw new Error('the run pool cap suite requires one loopback *_test database');
}

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SCHEMA = join(REPOSITORY_ROOT, 'packages/db/prisma/schema.prisma');
const Q_CONTRACT_SHA256 = 'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c';
const A_CONTRACT_SHA256 = 'dd2f4144f58de22f7415dfc11be56c4828c137e52d34e916852e64cfde38a2e1';
// A cold database migrates the whole history (≈4 minutes under load); leave the hook and the
// deploy both enough room.
const TIMEOUT = 600_000;
const CAP = 500;
/** public_web 260 + wikidata 260：跨两个查询累计、跨 provider 混合，超出 cap 20 家。 */
const PUBLIC_WEB_RECORDS = 260;
const WIKIDATA_RECORDS = 260;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** `prisma migrate deploy` exactly as a deploy runs it. */
function migrateDeploy(): string {
  const prismaCli = createRequire(join(REPOSITORY_ROOT, 'packages/db/package.json'))
    .resolve('prisma/build/index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', SCHEMA], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: ownerUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    timeout: 540_000,
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed: ${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

interface RawFixture { id: string; payloadHash: string; domain: string; name: string }
interface QueryFixture { queryKey: string; providerKey: string; raws: RawFixture[] }
interface RunFixture {
  runId: string;
  queries: QueryFixture[];
  input: Record<string, unknown>;
}

describe.runIf(enabled)('Discovery run pool cap on PostgreSQL', () => {
  const suffix = randomUUID().slice(0, 8);
  const workspaceId = randomUUID();
  let owner: PrismaClient;
  let app: PrismaService;
  let activities: ReturnType<typeof createDiscoveryActivities>;

  function binding(subject: string) {
    const requestSha256 = sha256(`discovery-run-pool-cap:${subject}:${suffix}`);
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

  async function insertPlan(planId: string, queries: unknown[]): Promise<void> {
    await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      await tx.$executeRaw`
        INSERT INTO discovery_query_plan(id, workspace_id, icp_id, status, queries, updated_at)
        VALUES (${planId}::uuid, ${workspaceId}::uuid, ${randomUUID()}::uuid, 'READY',
          ${JSON.stringify(queries)}::jsonb, now())`;
    });
  }

  /** One ACCEPTED Raw record through the real ingestion path, provider-shaped. */
  async function writeRawRecord(
    runId: string, providerKey: 'public_web' | 'wikidata', index: number,
  ): Promise<RawFixture> {
    const fetchedAt = new Date().toISOString();
    const sourceClass = providerKey === 'public_web' ? 'public_intelligence' : 'company_registry';
    const record = providerKey === 'public_web'
      ? mapPublicWebCompanyToRecord({
          domain: `cap-pw-${index}-${suffix}.example`,
          hitUrls: [`https://cap-pw-${index}-${suffix}.example/produkte`],
          sourceText: `- Pumpen Cap ${index} GmbH\n  URL: https://cap-pw-${index}-${suffix}.example/produkte`,
          extracted: { is_company_site: true, name: `Pumpen Cap ${index} GmbH`, country: 'Germany', products: ['pumps'] },
          sourceClass: 'public_intelligence',
          fetchedAt,
        })
      : mapWikidataCompanyToRecord({
          company: {
            qid: `Q${900000 + index}`,
            name: `Ventile Cap ${index} GmbH`,
            website: `https://cap-wd-${index}-${suffix}.example`,
            employees: 10,
            countryCode: 'DE',
          },
          // Raw ingestion pins wikidata's source_class to company_registry | industry_data.
          sourceClass: 'company_registry',
          fetchedAt,
        });
    const policies: RawSourcePolicySnapshot[] = await app.sourcePolicy.findMany({
      select: { id: true, domain: true, retentionDays: true, reviewStatus: true, allowedPurpose: true, updatedAt: true },
    });
    const [row] = prepareRawSourceBatch({ providerKey, records: [record], policies }).rows;
    if (row?.ingestStatus !== 'ACCEPTED') throw new Error(`raw record was ${row?.ingestStatus}`);
    const receipt = await app.withWorkspace(workspaceId, (tx) =>
      persistPreparedRawSourceRecord(tx, {
        workspaceId, runId, sourceEntityId: null, providerKey,
        sourceClass, row: row!,
      }));
    if (!receipt.inserted || receipt.ingestStatus !== 'ACCEPTED') {
      throw new Error(`raw record was not inserted as ACCEPTED (${receipt.ingestStatus})`);
    }
    return { id: receipt.id, payloadHash: receipt.payloadHash,
      domain: `cap-${providerKey === 'public_web' ? 'pw' : 'wd'}-${index}-${suffix}.example`,
      name: providerKey === 'public_web' ? `Pumpen Cap ${index} GmbH` : `Ventile Cap ${index} GmbH` };
  }

  async function createRun(
    subject: string,
    counts: readonly [number, number],
    // Domains and names are keyed by this offset: a later run must not reuse an earlier run's
    // identities, or its outcomes would link (LINKED, not counted) instead of create.
    offset = 0,
  ): Promise<RunFixture> {
    const runId = randomUUID();
    const planId = randomUUID();
    await insertPlan(planId, [{ source: 'public_web' }, { source: 'wikidata' }]);
    await owner.$executeRaw`
      INSERT INTO discovery_run(id, workspace_id, plan_id, icp_id, status, materialization_contract_version)
      VALUES (${runId}::uuid, ${workspaceId}::uuid, ${planId}::uuid, ${randomUUID()}::uuid, 'RUNNING',
        ${DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION})`;
    const queries: QueryFixture[] = [];
    for (const [ordinal, providerKey] of (['public_web', 'wikidata'] as const).entries()) {
      const raws: RawFixture[] = [];
      for (let index = 0; index < counts[ordinal]!; index += 1) {
        raws.push(await writeRawRecord(runId, providerKey, offset + ordinal * 1_000 + index));
      }
      queries.push({ queryKey: sha256(`query:${runId}:${ordinal}`), providerKey, raws });
    }
    return {
      runId, queries,
      input: { workspaceId, runId, executionContractVersion: 2, executionBudget: binding(subject) },
    };
  }

  /*
   * The query phase's governed lineage per query: a consumed workspace Grant, its settled
   * operation and domain ack, the Q receipt/outcome/attempt, and one A relation per Raw record —
   * as the Q-TX writer leaves them.
   */
  async function completeQueryPhase(run: RunFixture): Promise<void> {
    const budget = run.input.executionBudget as ReturnType<typeof binding>;
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
    for (const [ordinal, query] of run.queries.entries()) {
      const accountId = randomUUID();
      const operationId = randomUUID();
      const domainAckKey = sha256(`ack-key:${run.runId}:${ordinal}`);
      const domainRevision = sha256(`ack-revision:${run.runId}:${ordinal}`);
      const records = query.raws.length;
      await owner.$executeRaw`
        INSERT INTO tool_budget_account(id, scope_key, account_key, generation, cap_cents, reserved_cents,
          charged_cents, exhausted, ref_count, authority_id, authorized_cap_microusd, reserved_microusd,
          charged_microusd, created_at, updated_at)
        VALUES (${accountId}::uuid, ${workspaceId}, ${`${budget.accountKey}:${ordinal}`}, 1, 0, 0, 0, false, 1,
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
        SELECT ${operationId}::uuid, ${workspaceId}, ${accountId}::uuid, 1,
          ${`mine-domain:${run.runId}:${ordinal}`}, 'microusd',
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
      if (!ack) throw new Error('domain ack missing');
      await owner.$executeRaw`
        INSERT INTO discovery_query_receipt(workspace_id, run_id, plan_id, authority_id, account_key, purpose,
          subject_type, subject_id, request_sha256, query_key, query_ordinal, source_class, providers,
          provider_count, record_count, accepted_count, quarantined_count, rejected_count, duplicate_count,
          governance_denied_count, usage_quantity, cost_cents, contract_sha256)
        SELECT ${workspaceId}::uuid, run.id, run.plan_id, ${budget.authorityId}::uuid, ${budget.accountKey},
          'discovery.run', 'discovery_run', ${budget.subjectId}, ${budget.requestSha256}, ${query.queryKey}, ${ordinal},
          ${query.providerKey === 'public_web' ? 'public_intelligence' : 'company_registry'},
          ${JSON.stringify([query.providerKey])}::jsonb, 1, ${records}, ${records},
          0, 0, 0, 0, ${records}, 0, ${Q_CONTRACT_SHA256}
        FROM discovery_run run WHERE run.id = ${run.runId}::uuid`;
      await owner.$executeRaw`
        INSERT INTO discovery_query_execution_outcome(workspace_id, run_id, query_key, budget_truncated, contract_sha256)
        VALUES (${workspaceId}::uuid, ${run.runId}::uuid, ${query.queryKey}, false, ${Q_CONTRACT_SHA256})`;
      await owner.$executeRaw`
        INSERT INTO discovery_query_operation_attempt(workspace_id, run_id, query_key, provider_key, producer_id,
          operation_id, scope_key, authority_id, account_id, operation_generation, ack_id, consumer,
          domain_aggregate_type, domain_ack_key, domain_revision, result_digest, result_schema, lineage_schema,
          provider_record_count, covered_item_count, contract_sha256)
        VALUES (${workspaceId}::uuid, ${run.runId}::uuid, ${query.queryKey}, ${query.providerKey},
          'discovery.extract_company', ${operationId}::uuid, ${workspaceId}, ${budget.authorityId}::uuid,
          ${accountId}::uuid, 1, ${ack.ack_id}, 'PublicWebDiscoveryProvider.mineDomain', 'RawSourceRecord',
          ${domainAckKey}, ${domainRevision}, ${ack.result_digest}, 'discovery-extract-company/v1',
          'discovery-company-result-lineage/v1', ${records}, ${records}, ${Q_CONTRACT_SHA256})`;
      for (const [recordIndex, raw] of query.raws.entries()) {
        const itemId = randomUUID();
        const relationKey = `discovery.raw_source_record:${recordIndex}`;
        const [relation] = await app.withWorkspace(workspaceId, (tx) => tx.$queryRaw<Array<{
          operation_subject_id: string; child_subject_id: string; relation_id: string;
        }>>`
          SELECT operation_subject_id::text, child_subject_id::text, relation_id::text
          FROM append_workspace_governed_child_relation_v1(
            ${workspaceId}::uuid, ${budget.authorityId}::uuid, ${accountId}::uuid, ${operationId}::uuid, 1,
            ${ack.ack_id}::char(64), ${ack.result_digest}::char(64), 'tool_operation', ${operationId}::uuid,
            'NON_PERSONAL', NULL, NULL, NULL, 'raw_source_record', ${raw.id}::uuid, 'NON_PERSONAL',
            NULL, NULL, ${relationKey}, 'MATERIALIZED_CHILD', 'discovery_query_attempt_item',
            ${itemId}::uuid, NULL, ${A_CONTRACT_SHA256}::char(64))`);
        if (!relation) throw new Error('governed relation missing');
        await owner.$executeRaw`
          INSERT INTO discovery_query_attempt_item(id, workspace_id, run_id, query_key, provider_key, operation_id,
            record_index, resolution_kind, raw_record_id, raw_payload_hash, raw_ingest_status, relation_key,
            operation_subject_id, child_subject_id, relation_id, contract_sha256)
          VALUES (${itemId}::uuid, ${workspaceId}::uuid, ${run.runId}::uuid, ${query.queryKey},
            ${query.providerKey}, ${operationId}::uuid, ${recordIndex}, 'INSERTED', ${raw.id}::uuid,
            ${raw.payloadHash}, 'ACCEPTED', ${relationKey}, ${relation!.operation_subject_id}::uuid,
            ${relation!.child_subject_id}::uuid, ${relation!.relation_id}::uuid, ${A_CONTRACT_SHA256})`;
      }
    }
  }

  async function outcomeCounts(runId: string) {
    return owner.$queryRaw<Array<{ outcome: string; reason: string | null; provider: string; count: bigint }>>`
      SELECT outcome::text, not_canonicalizable_reason_code AS reason, provider_key::text AS provider, count(*)
      FROM discovery_company_materialization_outcome
      WHERE workspace_id = ${workspaceId}::uuid AND run_id = ${runId}::uuid
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
  }

  async function poolSize(runId: string): Promise<number> {
    const [row] = await owner.$queryRaw<Array<{ companies: bigint }>>`
      SELECT count(DISTINCT canonical_company_id) AS companies
      FROM discovery_company_materialization_outcome
      WHERE workspace_id = ${workspaceId}::uuid AND run_id = ${runId}::uuid AND outcome = 'CANONICALIZED'`;
    return Number(row?.companies ?? 0n);
  }

  async function runEvents(runId: string) {
    return owner.$queryRaw<Array<{ type: string; level: string; payload: unknown }>>`
      SELECT type::text, level::text, payload FROM run_event
      WHERE workspace_id = ${workspaceId}::uuid AND run_id = ${runId}::uuid ORDER BY seq`;
  }

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    const [state] = await owner.$queryRaw<Array<{ superuser: string; tables: bigint }>>`
      SELECT current_setting('is_superuser') AS superuser,
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')) AS tables`;
    if (state?.superuser !== 'on' || state.tables !== 0n) {
      throw new Error('the run pool cap suite needs a superuser URL to an empty database it migrates itself');
    }
    migrateDeploy();

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
      budgetStore: { attestAuthorized: async () => undefined } as never,
    });

    await owner.$executeRaw`
      INSERT INTO workspace(id, name, created_at, updated_at)
      VALUES (${workspaceId}::uuid, 'discovery run pool cap', now(), now())`;
    for (const providerKey of ['public_web', 'wikidata']) {
      await owner.$executeRaw`
        INSERT INTO data_provider(id, key, class, status, cost_per_call_cents, created_at)
        VALUES (gen_random_uuid(), ${providerKey}, 'public_intelligence', 'ENABLED', 0, now())
        ON CONFLICT (key) DO UPDATE SET status = 'ENABLED'`;
    }
    // Raw ingestion quarantines records without an APPROVED governing policy: public_web company
    // sites ride the scope pseudo-domain, wikidata rides its provenance host.
    for (const [domain, sourceType, accessMode] of [
      [PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN, 'official_website', 'crawl'],
      ['wikidata.org', 'official_website', 'api'],
    ] as const) {
      await owner.$executeRaw`
        INSERT INTO source_policy(id, domain, source_type, access_mode, allowed_purpose, retention_days,
          review_status, notes, created_at, updated_at)
        VALUES (gen_random_uuid(), ${domain}, ${sourceType}, ${accessMode},
          '["discovery","enrichment"]'::jsonb, 365, 'APPROVED',
          'discovery-run-pool-cap.postgres.spec', now(), now())`;
    }
  }, TIMEOUT);

  afterAll(async () => {
    await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
  });

  it(`caps the run pool at ${CAP} across two queries and providers`, async () => {
    const run = await createRun('cap', [PUBLIC_WEB_RECORDS, WIKIDATA_RECORDS]);
    await completeQueryPhase(run);
    vi.stubEnv('DISCOVERY_RUN_POOL_CAP', String(CAP));
    try {
      const result = await activities.canonicalizeRun(run.input as never);
      const total = PUBLIC_WEB_RECORDS + WIKIDATA_RECORDS;
      expect(result).toEqual({ companies: CAP, suppressed: 0,
        poolCap: { cap: CAP, skipped: total - CAP } });
    } finally {
      vi.unstubAllEnvs();
    }
    // 跨查询累计：第 2 个查询（wikidata）的公司先补到 500，其后 20 家被跳过。
    expect(await poolSize(run.runId)).toBe(CAP);
    const counts = await outcomeCounts(run.runId);
    expect(counts).toEqual([
      { outcome: 'CANONICALIZED', reason: null, provider: 'public_web', count: BigInt(PUBLIC_WEB_RECORDS) },
      { outcome: 'CANONICALIZED', reason: null, provider: 'wikidata', count: BigInt(CAP - PUBLIC_WEB_RECORDS) },
      { outcome: 'NOT_CANONICALIZABLE', reason: 'RUN_POOL_CAP_REACHED', provider: 'wikidata',
        count: BigInt(WIKIDATA_RECORDS - (CAP - PUBLIC_WEB_RECORDS)) },
    ]);
    expect(await runEvents(run.runId)).toEqual([{
      type: 'pool_cap_reached', level: 'warn',
      payload: { cap: CAP, skipped: WIKIDATA_RECORDS - (CAP - PUBLIC_WEB_RECORDS) },
    }]);
  }, TIMEOUT);

  it('DISCOVERY_RUN_POOL_CAP=off restores uncapped materialization without the run event', async () => {
    const run = await createRun('off', [3, 3], 5_000);
    await completeQueryPhase(run);
    vi.stubEnv('DISCOVERY_RUN_POOL_CAP', 'off');
    let result: Awaited<ReturnType<typeof activities.canonicalizeRun>>;
    try {
      result = await activities.canonicalizeRun(run.input as never);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(result).toEqual({ companies: 6, suppressed: 0 });
    expect(await poolSize(run.runId)).toBe(6);
    expect(await runEvents(run.runId)).toEqual([]);
  }, TIMEOUT);
});
