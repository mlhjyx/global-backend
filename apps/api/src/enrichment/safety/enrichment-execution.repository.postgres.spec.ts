import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFrozenEnrichmentPlan } from './enrichment-call-plan';
import {
  EnrichmentExecutionRepository,
  listCompanyEnrichmentHeads,
} from './enrichment-execution.repository';
import type { ExecutionBudgetBinding } from '../../execution-budget/execution-budget-binding';
import type { VerifiedExecutionBudgetAuthority } from '../../execution-budget/execution-budget-authority.types';

// Real-PostgreSQL behaviour for the two business index tables: app_user writes
// the exact SQL shapes the repository uses, owner only seeds and reads fixtures.
const ownerUrl = process.env.CONTACT_ENRICHMENT_TEST_DATABASE_URL;
const appUrl = process.env.CONTACT_ENRICHMENT_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'contact enrichment execution test needs both CONTACT_ENRICHMENT_TEST_DATABASE_URL and CONTACT_ENRICHMENT_TEST_APP_DATABASE_URL',
  );
}
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/global_test' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('contact enrichment execution test requires a loopback test database');
  }
}

function sqlState(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2010') return null;
  const code = (error.meta as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

const hex64 = () => randomBytes(32).toString('hex');
const digestOf = () => randomBytes(32).toString('hex');

interface HeadSeed {
  workspaceId: string;
  companyId: string;
  authorityId: string;
  accountId: string;
  requestSha256: string;
  admissionRequestSha256: string;
  operationRef: string;
  entrypoint?: 'http' | 'discovery_run';
  businessRunId?: string | null;
  generation?: number;
  scopeKey?: string;
  status?: string;
  targetSnapshot?: unknown;
}

interface StepSeed {
  workspaceId: string;
  executionId: string;
  contactId: string | null;
  contactOrdinal: number;
  slotOrdinal: number;
  slotKey: string;
  phase?: 'FINDER' | 'VERIFY' | 'SMTP';
  provider?: string;
  quoteMicrousd?: bigint;
}

describe.runIf(Boolean(ownerUrl && appUrl))('contact enrichment execution on PostgreSQL as app_user', { timeout: 90_000 }, () => {
  let owner: PrismaClient;
  let app: PrismaClient;

  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const companyA = randomUUID();
  const companyB = randomUUID();
  const contactA = randomUUID();
  const contactB = randomUUID();
  const admitContact = randomUUID();
  const admitContact2 = randomUUID();
  const authorityA = randomUUID();
  const authorityB = randomUUID();
  const accountA1 = randomUUID();
  const accountA2 = randomUUID();
  const accountAdmit = randomUUID();
  const accountFail = randomUUID();
  const admitRequestSha256 = 'd'.repeat(64);
  const failRequestSha256 = 'f'.repeat(64);
  const accountB = randomUUID();
  const operationA1 = randomUUID();
  const operationA2 = randomUUID();
  const operationA3 = randomUUID();
  const operationB = randomUUID();
  const emptyCompany = randomUUID();
  const deletedCompany = randomUUID();

  class RolledBack extends Error {}

  const inWorkspace = <T>(workspace: string, work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    app.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspace}, true)`;
        return work(tx);
      },
      { timeout: 20_000 },
    );

  const attempt = async <T>(workspace: string, work: (tx: Prisma.TransactionClient) => Promise<T>) => {
    try {
      return { ok: true as const, value: await inWorkspace(workspace, work) };
    } catch (error) {
      return { ok: false as const, code: sqlState(error) ?? 'other error' };
    }
  };

  const failure = async (workspace: string, work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
    const result = await attempt(workspace, work);
    return result.ok ? null : result.code;
  };

  const rolledBack = async (workspace: string, work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
    try {
      await inWorkspace(workspace, async (tx) => {
        await work(tx);
        throw new RolledBack();
      });
    } catch (error) {
      return error instanceof RolledBack ? null : sqlState(error) ?? 'other error';
    }
    return null;
  };

  const headSql = (tx: Prisma.TransactionClient, seed: HeadSeed, id: string) => {
    const entrypoint = seed.entrypoint ?? 'http';
    const businessRunId = entrypoint === 'http' ? null : seed.businessRunId ?? randomUUID();
    const snapshot = seed.targetSnapshot ?? [{ contactId: contactA, contactOrdinal: 0 }];
    return tx.$executeRaw`
      INSERT INTO contact_enrichment_execution
        (id, workspace_id, company_id, entrypoint, business_run_id, authority_id, account_id,
         generation, request_sha256, admission_request_sha256, operation_ref, protocol_version,
         plan_sha256, frozen_limits, target_snapshot, status, quality_coverage, result_revision, scope_key)
      VALUES (${id}::uuid, ${seed.workspaceId}::uuid, ${seed.companyId}::uuid, ${entrypoint},
        ${businessRunId}::uuid, ${seed.authorityId}::uuid, ${seed.accountId}::uuid, ${seed.generation ?? 1},
        ${seed.requestSha256}, ${seed.admissionRequestSha256}, ${seed.operationRef}, 1, ${digestOf()},
        ${JSON.stringify({ caps: {}, admittedAtMs: 1, deadlineAtMs: 2, targetCount: 1, executionOptions: null })}::jsonb,
        ${JSON.stringify(snapshot)}::jsonb, ${seed.status ?? 'PREPARED'}, 'PREREQUISITE_ONLY', 1,
        ${seed.scopeKey ?? seed.workspaceId})`;
  };

  const stepSql = (tx: Prisma.TransactionClient, seed: StepSeed, id: string) =>
    tx.$executeRaw`
      INSERT INTO contact_enrichment_execution_step
        (id, workspace_id, execution_id, contact_id, contact_ordinal, slot_ordinal, slot_key,
         phase, provider, tool_id, tool_version, quote_microusd, pricing_version,
         depends_on_slot_key, input_fingerprint, operation_key, budget_operation_id,
         dispatch_phase, domain_state, revision)
      VALUES (${id}::uuid, ${seed.workspaceId}::uuid, ${seed.executionId}::uuid,
        ${seed.contactId}::uuid, ${seed.contactOrdinal}, ${seed.slotOrdinal}, ${seed.slotKey},
        ${seed.phase ?? 'FINDER'}, ${seed.provider ?? 'hunter'}, 'contact-email-find-hunter', 'v1',
        ${seed.quoteMicrousd ?? 1000n}::bigint, 'pricing-v1', NULL, NULL, NULL, NULL,
        'ADMITTED', 'PENDING', 1)`;

  const newHead = async (
    workspace: string,
    overrides: Partial<HeadSeed> & Pick<HeadSeed, 'companyId' | 'authorityId' | 'accountId'>,
  ): Promise<{ id: string; requestSha256: string }> => {
    const id = randomUUID();
    const requestSha256 = overrides.requestSha256 ?? digestOf();
    const result = await attempt(workspace, (tx) =>
      headSql(tx, {
        workspaceId: workspace,
        requestSha256,
        admissionRequestSha256: digestOf(),
        operationRef: digestOf(),
        ...overrides,
      }, id),
    );
    if (!result.ok) throw new Error(`head fixture failed: ${result.code}`);
    return { id, requestSha256 };
  };

  const newStep = async (
    workspace: string,
    headId: string,
    overrides: Partial<StepSeed> = {},
  ): Promise<string> => {
    const id = randomUUID();
    const result = await attempt(workspace, (tx) =>
      stepSql(tx, {
        workspaceId: workspace,
        executionId: headId,
        contactId: contactA,
        contactOrdinal: 0,
        slotOrdinal: 0,
        slotKey: `finder.${randomUUID()}`,
        ...overrides,
      }, id),
    );
    if (!result.ok) throw new Error(`step fixture failed: ${result.code}`);
    return id;
  };

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    const [identity] = await app.$queryRaw<{ current: string; superuser: string; bypassrls: boolean }[]>`
      SELECT current_user::text AS current, current_setting('is_superuser') AS superuser,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`;
    if (identity?.current !== 'app_user' || identity.superuser !== 'off' || identity.bypassrls !== false) {
      throw new Error('contact enrichment execution test must connect the app side as app_user without RLS bypass');
    }
    await owner.$executeRaw`
      INSERT INTO workspace (id, name, created_at, updated_at) VALUES
        (${workspaceA}::uuid, ${`Enrichment A ${workspaceA.slice(0, 8)}`}, now(), now()),
        (${workspaceB}::uuid, ${`Enrichment B ${workspaceB.slice(0, 8)}`}, now(), now())`;
    await owner.$executeRaw`
      INSERT INTO canonical_company (id, workspace_id, name, domain, status, dedupe_key, updated_at) VALUES
        (${companyA}::uuid, ${workspaceA}::uuid, ${`Enrich A ${companyA.slice(0, 8)}`},
          ${`enrich-a-${companyA.slice(0, 8)}.example`}, 'NEW', ${`domain:enrich-a-${companyA.slice(0, 8)}`}, now()),
        (${companyB}::uuid, ${workspaceB}::uuid, ${`Enrich B ${companyB.slice(0, 8)}`},
          ${`enrich-b-${companyB.slice(0, 8)}.example`}, 'NEW', ${`domain:enrich-b-${companyB.slice(0, 8)}`}, now())`;
    await owner.$executeRaw`
      INSERT INTO canonical_company (id, workspace_id, name, domain, status, dedupe_key, updated_at) VALUES
        (${emptyCompany}::uuid, ${workspaceA}::uuid, ${`Enrich empty ${emptyCompany.slice(0, 8)}`},
          ${`enrich-empty-${emptyCompany.slice(0, 8)}.example`}, 'NEW', ${`domain:enrich-empty-${emptyCompany.slice(0, 8)}`}, now()),
        (${deletedCompany}::uuid, ${workspaceA}::uuid, ${`Enrich deleted ${deletedCompany.slice(0, 8)}`},
          ${`enrich-deleted-${deletedCompany.slice(0, 8)}.example`}, 'NEW', ${`domain:enrich-deleted-${deletedCompany.slice(0, 8)}`}, now())`;
    await owner.$executeRaw`DELETE FROM canonical_company WHERE id=${deletedCompany}::uuid`;
    await owner.$executeRaw`
      INSERT INTO canonical_contact (id, workspace_id, company_id, full_name, dedupe_key) VALUES
        (${contactA}::uuid, ${workspaceA}::uuid, ${companyA}::uuid, ${`Contact A ${contactA.slice(0, 8)}`},
          ${`c:enrich-a-${contactA.slice(0, 8)}`}),
        (${contactB}::uuid, ${workspaceB}::uuid, ${companyB}::uuid, ${`Contact B ${contactB.slice(0, 8)}`},
          ${`c:enrich-b-${contactB.slice(0, 8)}`}),
        (${admitContact}::uuid, ${workspaceA}::uuid, ${companyA}::uuid, ${`Admit ${admitContact.slice(0, 8)}`},
          ${`c:enrich-admit-${admitContact.slice(0, 8)}`}),
        (${admitContact2}::uuid, ${workspaceA}::uuid, ${companyA}::uuid, ${`Admit2 ${admitContact2.slice(0, 8)}`},
          ${`c:enrich-admit2-${admitContact2.slice(0, 8)}`})`;
    for (const [authority, workspace, company] of [
      [authorityA, workspaceA, companyA],
      [authorityB, workspaceB, companyB],
    ] as const) {
      await owner.$executeRaw`
        INSERT INTO execution_budget_authority
          (id, scope_key, authority_kind, workspace_id, issuer, audience, jti, token_sha256,
           schema_version, purpose, subject_type, subject_id, request_sha256, currency, unit,
           cap_microusd, issued_at, not_before, expires_at, runs_consumed, consumed_at)
        VALUES (${authority}::uuid, ${workspace}, 'WORKSPACE_GRANT', ${workspace}::uuid,
          'https://control.example.test', 'global-backend:execution-budget', ${randomUUID()}::uuid,
          ${hex64()}, 'execution-budget-grant/v1', 'contact.enrich', 'company', ${company}::uuid,
          ${hex64()}, 'USD', 'microusd', 500000, now() - interval '1 second', now(),
          now() + interval '4 minutes', 1, now())`;
    }
    for (const [account, workspace, authority, key] of [
      [accountA1, workspaceA, authorityA, `contact.enrich:a:${workspaceA}`],
      [accountA2, workspaceA, authorityA, `contact.enrich:b:${workspaceA}`],
      [accountB, workspaceB, authorityB, `contact.enrich:b:${workspaceB}`],
    ] as const) {
      await owner.$executeRaw`
        INSERT INTO tool_budget_account
          (id, scope_key, account_key, generation, cap_cents, reserved_cents, charged_cents,
           reserved_microusd, charged_microusd, exhausted, ref_count, authority_id,
           authorized_cap_microusd, created_at, updated_at)
        VALUES (${account}::uuid, ${workspace}, ${key}, 1, 0, 0, 0, 0, 0, false, 1,
          ${authority}::uuid, 500000, now(), now())`;
    }
    for (const [account, requestSha] of [
      [accountAdmit, admitRequestSha256],
      [accountFail, failRequestSha256],
    ] as const) {
      await owner.$executeRaw`
        INSERT INTO tool_budget_account
          (id, scope_key, account_key, generation, cap_cents, reserved_cents, charged_cents,
           reserved_microusd, charged_microusd, exhausted, ref_count, authority_id,
           authorized_cap_microusd, created_at, updated_at)
        VALUES (${account}::uuid, ${workspaceA},
          ${`contact.enrich:company:${companyA}:${requestSha}`},
          1, 0, 0, 0, 0, 0, false, 1, ${authorityA}::uuid, 500000, now(), now())`;
    }
    for (const [operation, workspace, account, generation, key] of [
      [operationA1, workspaceA, accountA1, 1, `enrich:finder:${randomUUID()}`],
      [operationA2, workspaceA, accountA2, 1, `enrich:verify:${randomUUID()}`],
      [operationA3, workspaceA, accountA2, 2, `enrich:smtp:${randomUUID()}`],
      [operationB, workspaceB, accountB, 1, `enrich:finder:${randomUUID()}`],
    ] as const) {
      await owner.$executeRaw`
        INSERT INTO tool_budget_operation
          (id, scope_key, account_id, generation, operation_key, amount_unit, reserved_cents,
           reserved_microusd, status, attempt, created_at)
        VALUES (${operation}::uuid, ${workspace}, ${account}::uuid, ${generation}, ${key},
          'microusd', 0, 1000, 'RESERVED', 1, now())`;
    }
  });

  afterAll(async () => {
    if (!owner) return;
    const scopes = [workspaceA, workspaceB];
    try {
      await owner.$executeRaw`
        DELETE FROM contact_enrichment_execution_step WHERE workspace_id IN (${workspaceA}::uuid, ${workspaceB}::uuid)`;
      await owner.$executeRaw`
        DELETE FROM contact_enrichment_execution WHERE workspace_id IN (${workspaceA}::uuid, ${workspaceB}::uuid)`;
      await owner.$executeRaw`
        DELETE FROM tool_budget_operation WHERE scope_key IN (${scopes[0]}, ${scopes[1]})`;
      await owner.$executeRaw`
        DELETE FROM tool_budget_account WHERE scope_key IN (${scopes[0]}, ${scopes[1]})`;
      await owner.$executeRaw`
        DELETE FROM execution_budget_authority WHERE scope_key IN (${scopes[0]}, ${scopes[1]})`;
      await owner.$executeRaw`
        DELETE FROM canonical_company WHERE id IN (${companyA}::uuid, ${companyB}::uuid)`;
      await owner.$executeRaw`
        DELETE FROM workspace WHERE id IN (${workspaceA}::uuid, ${workspaceB}::uuid)`;
    } finally {
      await Promise.all([owner.$disconnect(), app?.$disconnect()]);
    }
  });

  it('distinguishes an unreadable company from a readable company with zero executions on real PostgreSQL', async () => {
    const database = {
      withWorkspace: (workspaceId: string, work: (tx: unknown) => Promise<unknown>) =>
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
          return work(tx);
        }),
    } as never;
    const page = { limit: 10, cursor: null, businessRunId: null };
    await expect(listCompanyEnrichmentHeads(database, { workspaceId: workspaceA, companyId: emptyCompany }, page)).resolves.toEqual([]);
    await expect(listCompanyEnrichmentHeads(database, { workspaceId: workspaceA, companyId: randomUUID() }, page)).resolves.toBeNull();
    await expect(listCompanyEnrichmentHeads(database, { workspaceId: workspaceA, companyId: deletedCompany }, page)).resolves.toBeNull();
    await expect(listCompanyEnrichmentHeads(database, { workspaceId: workspaceB, companyId: companyA }, page)).resolves.toBeNull();
  });

  it('app_user insert derives scope_key from the workspace even when a wrong value is supplied', async () => {
    const head = await newHead(workspaceA, {
      companyId: companyA,
      authorityId: authorityA,
      accountId: accountA1,
      scopeKey: 'bogus-scope',
    });
    const [row] = await inWorkspace(workspaceA, (tx) =>
      tx.$queryRaw<Array<{ scope_key: string; workspace_id: string }>>`
        SELECT scope_key, workspace_id::text AS workspace_id
        FROM contact_enrichment_execution WHERE id = ${head.id}::uuid`);
    expect(row).toEqual({ scope_key: workspaceA, workspace_id: workspaceA });
    const [other] = await inWorkspace(workspaceB, (tx) =>
      tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*)::bigint AS count FROM contact_enrichment_execution WHERE id = ${head.id}::uuid`);
    expect(other.count).toBe(0n);
    const duplicate = await attempt(workspaceA, (tx) =>
      headSql(tx, {
        workspaceId: workspaceA,
        companyId: companyA,
        authorityId: authorityA,
        accountId: accountA1,
        requestSha256: head.requestSha256,
        admissionRequestSha256: digestOf(),
        operationRef: digestOf(),
      }, randomUUID()));
    expect(duplicate).toMatchObject({ ok: false, code: '23505' });
  });

  it('same-transaction head and step inserts roll back together', async () => {
    const headId = randomUUID();
    const stepId = randomUUID();
    expect(
      await rolledBack(workspaceA, async (tx) => {
        await headSql(tx, {
          workspaceId: workspaceA,
          companyId: companyA,
          authorityId: authorityA,
          accountId: accountA1,
          requestSha256: digestOf(),
          admissionRequestSha256: digestOf(),
          operationRef: digestOf(),
        }, headId);
        await stepSql(tx, {
          workspaceId: workspaceA,
          executionId: headId,
          contactId: contactA,
          contactOrdinal: 0,
          slotOrdinal: 0,
          slotKey: `finder.${randomUUID()}`,
        }, stepId);
      }),
    ).toBeNull();
    const [headCount] = await owner.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM contact_enrichment_execution WHERE id = ${headId}::uuid`;
    const [stepCount] = await owner.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM contact_enrichment_execution_step WHERE id = ${stepId}::uuid`;
    expect(headCount.count).toBe(0n);
    expect(stepCount.count).toBe(0n);
  });

  it('pending fence blocks NULL duplicates, narrows by fingerprint and spans accounts but not terminals', async () => {
    const head = await newHead(workspaceA, { companyId: companyA, authorityId: authorityA, accountId: accountA1 });
    const step1 = await newStep(workspaceA, head.id, { slotOrdinal: 0, slotKey: `finder.${randomUUID()}` });
    const duplicate = await attempt(workspaceA, (tx) =>
      stepSql(tx, {
        workspaceId: workspaceA,
        executionId: head.id,
        contactId: contactA,
        contactOrdinal: 0,
        slotOrdinal: 1,
        slotKey: `finder.${randomUUID()}`,
      }, randomUUID()));
    expect(duplicate).toMatchObject({ ok: false, code: '23505' });
    const fingerprint1 = digestOf();
    const fingerprint2 = digestOf();
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET input_fingerprint = ${fingerprint1}, operation_key = ${`finder:key:${randomUUID()}`}, revision = revision + 1
          WHERE id = ${step1}::uuid`),
    ).toBeNull();
    const step2 = await newStep(workspaceA, head.id, { slotOrdinal: 1, slotKey: `finder.${randomUUID()}` });
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET input_fingerprint = ${fingerprint2}, operation_key = ${`finder:key:${randomUUID()}`}, revision = revision + 1
          WHERE id = ${step2}::uuid`),
    ).toBeNull();
    const head2 = await newHead(workspaceA, { companyId: companyA, authorityId: authorityA, accountId: accountA2 });
    const step3 = await newStep(workspaceA, head2.id, { slotOrdinal: 0, slotKey: `finder.${randomUUID()}` });
    const crossAccount = await attempt(workspaceA, (tx) =>
      tx.$executeRaw`UPDATE contact_enrichment_execution_step
        SET input_fingerprint = ${fingerprint1}, operation_key = ${`finder:key:${randomUUID()}`}, revision = revision + 1
        WHERE id = ${step3}::uuid`);
    expect(crossAccount).toMatchObject({ ok: false, code: '23505' });
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET budget_operation_id = ${operationA1}::uuid, dispatch_phase = 'RESERVED', revision = revision + 1
          WHERE id = ${step1}::uuid`),
    ).toBeNull();
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET result_digest = ${digestOf()}, receipt = ${JSON.stringify({ schemaVersion: 'durable-execution-receipt/v1' })}::jsonb,
              dispatch_phase = 'SETTLED_WAITING_APPLY', revision = revision + 1
          WHERE id = ${step1}::uuid`),
    ).toBeNull();
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET dispatch_phase = 'SETTLED', revision = revision + 1 WHERE id = ${step1}::uuid`),
    ).toBeNull();
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET input_fingerprint = ${fingerprint1}, operation_key = ${`finder:key:${randomUUID()}`}, revision = revision + 1
          WHERE id = ${step3}::uuid`),
    ).toBeNull();
  });

  it('sealing is one-way and RESERVED needs the original ledger operation', async () => {
    const head = await newHead(workspaceA, { companyId: companyA, authorityId: authorityA, accountId: accountA1 });
    const step = await newStep(workspaceA, head.id, { slotOrdinal: 0, slotKey: `verify.${randomUUID()}`, phase: 'VERIFY' });
    const fingerprint = digestOf();
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET input_fingerprint = ${fingerprint}, operation_key = ${`verify:key:${randomUUID()}`}, revision = revision + 1
          WHERE id = ${step}::uuid`),
    ).toBeNull();
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET input_fingerprint = ${digestOf()}, revision = revision + 1 WHERE id = ${step}::uuid`),
    ).toBe('23514');
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET dispatch_phase = 'RESERVED', revision = revision + 1 WHERE id = ${step}::uuid`),
    ).toBe('23514');
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET result_digest = ${digestOf()}, receipt = '{"schemaVersion":"durable-execution-receipt/v1"}'::jsonb,
              dispatch_phase = 'SETTLED_WAITING_APPLY', revision = revision + 1
          WHERE id = ${step}::uuid`),
    ).toBe('23514');
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET budget_operation_id = ${operationA2}::uuid, dispatch_phase = 'RESERVED', revision = revision + 1
          WHERE id = ${step}::uuid`),
    ).toBeNull();
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET result_digest = ${digestOf()}, receipt = '{"schemaVersion":"durable-execution-receipt/v1"}'::jsonb,
              artifact_reference = ${JSON.stringify({ artifactId: randomUUID(), operationId: operationA2 })}::jsonb,
              dispatch_phase = 'SETTLED_WAITING_APPLY', revision = revision + 1
          WHERE id = ${step}::uuid`),
    ).toBeNull();
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET domain_state = 'APPLIED', dispatch_phase = 'SETTLED', revision = revision + 1
          WHERE id = ${step}::uuid`),
    ).toBeNull();
  });

  it('RLS and the narrow grants deny cross-tenant writes, deletes and frozen columns', async () => {
    const head = await newHead(workspaceA, { companyId: companyA, authorityId: authorityA, accountId: accountA1 });
    const step = await newStep(workspaceA, head.id, { slotOrdinal: 0, slotKey: `finder.${randomUUID()}` });
    const crossWorkspace = await attempt(workspaceA, (tx) =>
      headSql(tx, {
        workspaceId: workspaceB,
        companyId: companyB,
        authorityId: authorityB,
        accountId: accountB,
        requestSha256: digestOf(),
        admissionRequestSha256: digestOf(),
        operationRef: digestOf(),
      }, randomUUID()));
    expect(crossWorkspace).toMatchObject({ ok: false, code: '42501' });
    const foreignUpdate = await attempt(workspaceB, (tx) =>
      tx.$executeRaw`UPDATE contact_enrichment_execution SET status = 'RUNNING' WHERE id = ${head.id}::uuid`);
    expect(foreignUpdate).toMatchObject({ ok: true, value: 0 });
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`DELETE FROM contact_enrichment_execution_step WHERE id = ${step}::uuid`),
    ).toBe('42501');
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution SET quality_coverage = 'X' WHERE id = ${head.id}::uuid`),
    ).toBe('42501');
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step SET quote_microusd = 1 WHERE id = ${step}::uuid`),
    ).toBe('42501');
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution SET scope_key = 'other' WHERE id = ${head.id}::uuid`),
    ).toBe('42501');
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution
          SET status = 'RUNNING', result_revision = result_revision + 1 WHERE id = ${head.id}::uuid`),
    ).toBeNull();
  });

  it('audited DSR clears personal links, keeps the UNKNOWN hold and leaves the ledger untouched', async () => {
    const head = await newHead(workspaceA, {
      companyId: companyA,
      authorityId: authorityA,
      accountId: accountA2,
      targetSnapshot: [{ contactId: contactA, contactOrdinal: 0 }],
    });
    const step = await newStep(workspaceA, head.id, { slotOrdinal: 0, slotKey: `smtp.${randomUUID()}`, phase: 'SMTP', provider: 'smtp' });
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET input_fingerprint = ${digestOf()}, operation_key = ${`smtp:key:${randomUUID()}`}, revision = revision + 1
          WHERE id = ${step}::uuid`),
    ).toBeNull();
    expect(
      await failure(workspaceA, (tx) =>
        tx.$executeRaw`UPDATE contact_enrichment_execution_step
          SET budget_operation_id = ${operationA3}::uuid, dispatch_phase = 'RESULT_UNKNOWN', revision = revision + 1
          WHERE id = ${step}::uuid`),
    ).toBeNull();
    for (let pass = 0; pass < 2; pass += 1) {
      expect(
        await failure(workspaceA, (tx) =>
          tx.$executeRaw`UPDATE contact_enrichment_execution_step
            SET contact_id = NULL, candidate_ref = NULL, input_fingerprint = NULL, domain_state = 'REDACTED'
            WHERE workspace_id = ${workspaceA}::uuid AND contact_id = ${contactA}::uuid`),
      ).toBeNull();
      expect(
        await failure(workspaceA, (tx) =>
          tx.$executeRaw`UPDATE contact_enrichment_execution
            SET target_snapshot = '[]'::jsonb, status = 'REDACTED',
                result_snapshot = '{"version":1,"targetCount":1,"newCandidatePoints":0,"contacts":[]}'::jsonb
            WHERE workspace_id = ${workspaceA}::uuid AND company_id = ${companyA}::uuid`),
      ).toBeNull();
    }
    const [redactedStep] = await owner.$queryRaw<
      Array<{ contact_id: string | null; input_fingerprint: string | null; dispatch_phase: string; domain_state: string; operation: string | null }>
    >`
      SELECT contact_id::text AS contact_id, input_fingerprint, dispatch_phase, domain_state,
        budget_operation_id::text AS operation
      FROM contact_enrichment_execution_step WHERE id = ${step}::uuid`;
    expect(redactedStep).toEqual({
      contact_id: null,
      input_fingerprint: null,
      dispatch_phase: 'RESULT_UNKNOWN',
      domain_state: 'REDACTED',
      operation: operationA3,
    });
    const [redactedHead] = await owner.$queryRaw<Array<{ status: string; targets: unknown }>>`
      SELECT status, target_snapshot AS targets FROM contact_enrichment_execution WHERE id = ${head.id}::uuid`;
    expect(redactedHead).toEqual({ status: 'REDACTED', targets: [] });
    const [operation] = await owner.$queryRaw<Array<{ status: string; reserved: bigint; generation: number }>>`
      SELECT status, reserved_microusd AS reserved, generation
      FROM tool_budget_operation WHERE id = ${operationA3}::uuid`;
    expect(operation).toEqual({ status: 'RESERVED', reserved: 1000n, generation: 2 });
  });

  const admissionPlan = (contactId = admitContact, requestSha256 = admitRequestSha256, admittedAtMs = 1000, deadlineAtMs = 601000) =>
    buildFrozenEnrichmentPlan({
      workspaceId: workspaceA,
      companyId: companyA,
      entrypoint: 'http',
      businessRunId: null,
      requestSha256,
      admittedAtMs,
      deadlineAtMs,
      targets: [
        { contactId, contactOrdinal: 0, inputVersion: 'v1', beforeDigest: 'b'.repeat(64), pointRefs: [] },
      ],
      slots: [
        {
          slotKey: 'f1',
          contactId,
          contactOrdinal: 0,
          phase: 'FINDER',
          provider: 'hunter',
          toolId: 'contact_email.find.hunter',
          toolVersion: '1.0.0',
          quoteMicrousd: '1780',
          pricingVersion: 'p1',
          dependsOnSlotKey: null,
        },
      ],
      limits: {
        authorityCapMicrousd: '500000',
        companyCapMicrousd: '500000',
        contactCapMicrousd: '150000',
        finderCompanyMax: 10,
        finderContactMax: 3,
        verifyAddressMax: 6,
        maxContacts: 10,
      },
    });
  const admissionAuthorityFor = (requestSha256 = admitRequestSha256): VerifiedExecutionBudgetAuthority => ({
    schemaVersion: 'execution-budget-grant/v1',
    authorityKind: 'WORKSPACE_GRANT',
    issuer: 'https://control.example.test',
    audience: 'global-backend:execution-budget',
    jti: 'admission-test',
    purpose: 'contact.enrich',
    workspaceId: workspaceA,
    subjectType: 'company',
    subjectId: companyA,
    requestSha256,
    scheduleId: null,
    currency: 'USD',
    unit: 'microusd',
    capMicrousd: 500000n,
    capPerRunMicrousd: null,
    campaignCapMicrousd: null,
    maxRuns: null,
    tokenSha256: 'c'.repeat(64),
    issuedAt: 1,
    notBefore: 1,
    expiresAt: 999,
  });
  const admissionAuthority = admissionAuthorityFor();
  const admissionBinding = (requestSha256 = admitRequestSha256): ExecutionBudgetBinding => ({
    authorityId: authorityA,
    replay: false,
    scopeKey: workspaceA,
    accountKey: `contact.enrich:company:${companyA}:${requestSha256}`,
    purpose: 'contact.enrich',
    subjectType: 'company',
    subjectId: companyA,
    requestSha256,
  });
  const admissionRepository = (binding = admissionBinding()) =>
    new EnrichmentExecutionRepository(
      {
        withWorkspace: (workspaceId: string, work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          app.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
            return work(tx);
          }, { timeout: 20_000 }),
      } as never,
      { consumeVerifiedWorkspaceGrantInTransaction: async () => binding },
    );

  it('admits an execution as app_user through the definer locks without UPDATE grants', async () => {
    const view = await admissionRepository().admitHttp({
      authority: admissionAuthority,
      plan: admissionPlan(),
      admissionRequestSha256: 'e'.repeat(64),
    });
    expect(view).toMatchObject({
      status: 'PREPARED',
      authorityId: authorityA,
      accountId: accountAdmit,
      generation: 1,
    });
    const [row] = await owner.$queryRaw<Array<{ status: string; scope_key: string; authority_id: string }>>`
      SELECT status, scope_key, authority_id::text AS authority_id
      FROM contact_enrichment_execution WHERE id = ${view.executionId}::uuid`;
    expect(row).toEqual({ status: 'PREPARED', scope_key: workspaceA, authority_id: authorityA });
    const grants = await owner.$queryRaw<Array<{ table_name: string; privilege_type: string }>>`
      SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'app_user' AND table_name IN ('execution_budget_authority', 'tool_budget_account')
      ORDER BY table_name, privilege_type`;
    expect(grants).toEqual([
      { table_name: 'execution_budget_authority', privilege_type: 'SELECT' },
      { table_name: 'tool_budget_account', privilege_type: 'SELECT' },
    ]);
    const [functions] = await owner.$queryRaw<Array<{ authority: boolean; account: boolean }>>`
      SELECT has_function_privilege('app_user', 'lock_enrichment_authority_v1(uuid,uuid)', 'EXECUTE') AS authority,
        has_function_privilege('app_user', 'lock_enrichment_account_v1(uuid,uuid,text)', 'EXECUTE') AS account`;
    expect(functions).toEqual({ authority: true, account: true });
    const directLock = await attempt(workspaceA, (tx) =>
      tx.$queryRaw`SELECT id FROM execution_budget_authority WHERE scope_key = ${workspaceA} AND id = ${authorityA}::uuid FOR UPDATE`);
    expect(directLock).toMatchObject({ ok: false, code: '42501' });
    const crossScope = await attempt(workspaceB, (tx) =>
      tx.$queryRaw`SELECT * FROM public.lock_enrichment_authority_v1(${workspaceA}::uuid, ${authorityA}::uuid)`);
    expect(crossScope).toMatchObject({ ok: false, code: '42501' });
  });

  it('keeps admission inside one workspace and leaves no head when the transaction fails', async () => {
    const before = await owner.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM contact_enrichment_execution
      WHERE workspace_id = ${workspaceA}::uuid AND request_sha256 = ${admitRequestSha256}`;
    const failing = await attempt(workspaceA, () =>
      admissionRepository(admissionBinding(failRequestSha256)).admitHttp({
        authority: admissionAuthorityFor(failRequestSha256),
        plan: admissionPlan(contactB, failRequestSha256),
        admissionRequestSha256: 'f'.repeat(64),
      }));
    expect(failing).toMatchObject({ ok: false });
    const after = await owner.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM contact_enrichment_execution
      WHERE workspace_id = ${workspaceA}::uuid AND request_sha256 = ${admitRequestSha256}`;
    expect(after).toEqual(before);
  });

  it('refuses a foreign authority through the scoped definer lock', async () => {
    const before = await owner.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM contact_enrichment_execution
      WHERE workspace_id = ${workspaceA}::uuid AND request_sha256 = ${admitRequestSha256}`;
    const cross = await attempt(workspaceA, () =>
      admissionRepository({ ...admissionBinding(), authorityId: authorityB }).admitHttp({
        authority: admissionAuthority,
        plan: admissionPlan(),
        admissionRequestSha256: 'a1'.repeat(32),
      }));
    expect(cross).toMatchObject({ ok: false });
    const after = await owner.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS count FROM contact_enrichment_execution
      WHERE workspace_id = ${workspaceA}::uuid AND request_sha256 = ${admitRequestSha256}`;
    expect(after).toEqual(before);
  });

  it('binds a step as app_user through the anchor and step definer locks', async () => {
    const view = await admissionRepository(admissionBinding(failRequestSha256)).admitHttp({
      authority: admissionAuthorityFor(failRequestSha256),
      plan: admissionPlan(admitContact2, failRequestSha256, Date.now(), Date.now() + 600_000),
      admissionRequestSha256: 'c2'.repeat(32),
    });
    const [step] = await owner.$queryRaw<Array<{ id: string; pricing_version: string }>>`
      SELECT id::text AS id, pricing_version FROM contact_enrichment_execution_step
      WHERE workspace_id = ${workspaceA}::uuid AND execution_id = ${view.executionId}::uuid`;
    const guards = {
      assertCurrentSubjectAndPolicy: async (_tx: Prisma.TransactionClient, row: { pricing_version: string }) => ({ pricingVersion: row.pricing_version }),
      assertCandidateOrigin: async () => undefined,
    };
    const guardsRepository = new EnrichmentExecutionRepository(
      {
        withWorkspace: (workspaceId: string, work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          app.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
            return work(tx);
          }, { timeout: 20_000 }),
      } as never,
      { consumeVerifiedWorkspaceGrantInTransaction: async () => admissionBinding(failRequestSha256) },
      guards as never,
    );
    const bound = await guardsRepository.bindStepInput({
      workspaceId: workspaceA,
      companyId: companyA,
      stepId: step!.id,
      expectedRevision: 1,
      inputFingerprint: 'a'.repeat(64),
      operationKey: `find:${step!.id}`,
      candidateRef: null,
    });
    expect(bound).toMatchObject({ stepId: step!.id, revision: 2 });
    const claimOperation = randomUUID();
    await owner.$executeRaw`
      INSERT INTO tool_budget_operation
        (id, scope_key, account_id, generation, operation_key, amount_unit, reserved_cents,
         reserved_microusd, status, attempt, created_at)
      VALUES (${claimOperation}::uuid, ${workspaceA}, ${view.accountId}::uuid, 1,
        ${`find:${step!.id}`}, 'microusd', 0, 1780, 'RESERVED', 1, now())`;
    const claimed = await guardsRepository.claimStepBeforeWire({
      workspaceId: workspaceA,
      companyId: companyA,
      stepId: step!.id,
      expectedRevision: 2,
      operationKey: `find:${step!.id}`,
      expectedPricingVersion: step!.pricing_version,
    });
    expect(claimed).toMatchObject({ stepId: step!.id, budgetOperationId: claimOperation });
    const [claimedRow] = await owner.$queryRaw<Array<{ dispatch_phase: string; budget_operation_id: string | null }>>`
      SELECT dispatch_phase, budget_operation_id::text AS budget_operation_id
      FROM contact_enrichment_execution_step WHERE id = ${step!.id}::uuid`;
    expect(claimedRow).toEqual({ dispatch_phase: 'RESERVED', budget_operation_id: claimOperation });
    const cross = await attempt(workspaceB, () =>
      guardsRepository.bindStepInput({
        workspaceId: workspaceB,
        companyId: companyB,
        stepId: step!.id,
        expectedRevision: 1,
        inputFingerprint: 'b'.repeat(64),
        operationKey: `find:${step!.id}`,
        candidateRef: null,
      }));
    expect(cross).toMatchObject({ ok: false });
  });

  it('column-list SET NULL clears only the personal link, never the workspace', async () => {
    const head = await newHead(workspaceA, { companyId: companyA, authorityId: authorityA, accountId: accountA1 });
    const step = await newStep(workspaceA, head.id, { slotOrdinal: 0, slotKey: `finder.${randomUUID()}` });
    await owner.$executeRaw`DELETE FROM canonical_contact WHERE id = ${contactA}::uuid`;
    const [row] = await owner.$queryRaw<Array<{ contact_id: string | null; workspace_id: string }>>`
      SELECT contact_id::text AS contact_id, workspace_id::text AS workspace_id
      FROM contact_enrichment_execution_step WHERE id = ${step}::uuid`;
    expect(row).toEqual({ contact_id: null, workspace_id: workspaceA });
    const [headRow] = await owner.$queryRaw<Array<{ company_id: string | null; workspace_id: string }>>`
      SELECT company_id::text AS company_id, workspace_id::text AS workspace_id
      FROM contact_enrichment_execution WHERE id = ${head.id}::uuid`;
    expect(headRow).toEqual({ company_id: companyA, workspace_id: workspaceA });
    await owner.$executeRaw`DELETE FROM canonical_company WHERE id = ${companyA}::uuid`;
    const [afterCompany] = await owner.$queryRaw<Array<{ company_id: string | null; workspace_id: string }>>`
      SELECT company_id::text AS company_id, workspace_id::text AS workspace_id
      FROM contact_enrichment_execution WHERE id = ${head.id}::uuid`;
    expect(afterCompany).toEqual({ company_id: null, workspace_id: workspaceA });
  });
});
