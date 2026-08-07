/**
 * Isolated PostgreSQL verifier for runtime ops durability.
 *
 * This script never loads `.env` and rejects shared/remote/non-disposable
 * targets before Prisma creates a client. The caller must pre-create and
 * migrate a loopback database named `runtime_ops_disposable_<suffix>` and set
 * the explicit admission variables documented in runtime-ops-evidence.md.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { admitRuntimeOpsPostgresVerifier } from '../src/runtime-ops/postgres-verifier-admission';

class VerificationRollback extends Error {}

function randomReceiptKey(): string {
  return `${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`;
}

function appendOnlyBlocked(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as {
    message?: unknown;
    meta?: { message?: unknown };
  };
  return [candidate.message, candidate.meta?.message].some(
    (message) =>
      typeof message === 'string' &&
      message.includes('runtime ops receipts are append-only'),
  );
}

async function verify(): Promise<void> {
  const admission = admitRuntimeOpsPostgresVerifier(process.env);
  const db = new PrismaClient({ datasourceUrl: admission.databaseUrl });
  let rolledBack = false;
  try {
    await db.$connect();
    const identity = await db.$queryRaw<Array<{ database_name: string }>>`
      SELECT current_database()::text AS database_name
    `;
    if (identity[0]?.database_name !== admission.databaseName) {
      throw new Error('DATABASE_IDENTITY_MISMATCH');
    }

    const catalog = await db.$queryRaw<
      Array<{ table_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >`
      SELECT c.relname::text AS table_name,
             c.relrowsecurity,
             c.relforcerowsecurity
      FROM pg_class c
      WHERE c.relname IN (
        'signal_ingest',
        'workflow_run_receipt',
        'worker_heartbeat',
        'schedule_drift_receipt'
      )
      ORDER BY c.relname
    `;
    if (catalog.length !== 4) throw new Error('RUNTIME_OPS_TABLES_MISSING');
    const workflowReceipt = catalog.find((row) => row.table_name === 'workflow_run_receipt');
    if (!workflowReceipt?.relrowsecurity || !workflowReceipt.relforcerowsecurity) {
      throw new Error('WORKFLOW_RECEIPT_RLS_MISSING');
    }

    const triggers = await db.$queryRaw<Array<{ trigger_name: string }>>`
      SELECT tgname::text AS trigger_name
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname IN (
          'workflow_run_receipt_append_only',
          'schedule_drift_receipt_append_only'
        )
      ORDER BY tgname
    `;
    if (triggers.length !== 2) throw new Error('APPEND_ONLY_TRIGGER_MISSING');

    const privileges = await db.$queryRaw<
      Array<{
        workflow_select: boolean;
        workflow_insert: boolean;
        heartbeat_select: boolean;
        heartbeat_update: boolean;
        schedule_select: boolean;
        schedule_insert: boolean;
      }>
    >`
      SELECT
        has_table_privilege('app_user', 'workflow_run_receipt', 'SELECT') AS workflow_select,
        has_table_privilege('app_user', 'workflow_run_receipt', 'INSERT') AS workflow_insert,
        has_table_privilege('app_user', 'worker_heartbeat', 'SELECT') AS heartbeat_select,
        has_table_privilege('app_user', 'worker_heartbeat', 'UPDATE') AS heartbeat_update,
        has_table_privilege('app_user', 'schedule_drift_receipt', 'SELECT') AS schedule_select,
        has_table_privilege('app_user', 'schedule_drift_receipt', 'INSERT') AS schedule_insert
    `;
    const grants = privileges[0];
    if (
      !grants?.workflow_select ||
      grants.workflow_insert ||
      !grants.heartbeat_select ||
      grants.heartbeat_update ||
      !grants.schedule_select ||
      grants.schedule_insert
    ) {
      throw new Error('RUNTIME_OPS_APP_ROLE_PRIVILEGE_MISMATCH');
    }

    const rlsWorkspace = randomUUID();
    const hiddenWorkspace = randomUUID();
    const visibleReceiptKey = randomReceiptKey();
    const hiddenReceiptKey = randomReceiptKey();
    let rlsRolledBack = false;
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "workflow_run_receipt" (
            "receipt_key", "workspace_id", "workflow_id", "run_id",
            "workflow_type", "task_queue", "worker_build_sha", "phase",
            "stage", "stats", "retry_attempt"
          ) VALUES
          (${visibleReceiptKey}, ${rlsWorkspace}::uuid,
           'verify-visible', ${randomUUID()}::uuid, 'verifyWorkflow',
           'acquisition', ${'a'.repeat(40)}, 'STARTED', 'started', '{}'::jsonb, 1),
          (${hiddenReceiptKey}, ${hiddenWorkspace}::uuid,
           'verify-hidden', ${randomUUID()}::uuid, 'verifyWorkflow',
           'acquisition', ${'a'.repeat(40)}, 'STARTED', 'started', '{}'::jsonb, 1)
        `;
        await tx.$executeRawUnsafe('SET LOCAL ROLE app_user');
        await tx.$queryRaw`
          SELECT set_config('app.current_workspace_id', ${rlsWorkspace}, true)
        `;
        const visible = await tx.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*)::bigint AS count
          FROM "workflow_run_receipt"
          WHERE "receipt_key" IN (${visibleReceiptKey}, ${hiddenReceiptKey})
        `;
        if (visible[0]?.count !== 1n) {
          throw new Error('WORKFLOW_RECEIPT_RLS_ISOLATION_FAILED');
        }
        throw new VerificationRollback('rollback RLS verifier fixtures');
      });
    } catch (error) {
      if (!(error instanceof VerificationRollback)) throw error;
      rlsRolledBack = true;
    }
    if (!rlsRolledBack) throw new Error('RLS_FIXTURE_WAS_NOT_ROLLED_BACK');

    let workflowMutationBlocked = false;
    try {
      await db.$transaction(async (tx) => {
        const receiptKey = randomReceiptKey();
        await tx.$executeRaw`
          INSERT INTO "workflow_run_receipt" (
            "receipt_key", "workflow_id", "run_id", "workflow_type",
            "task_queue", "worker_build_sha", "phase", "stage", "stats",
            "retry_attempt"
          ) VALUES (
            ${receiptKey}, 'verify-append', ${randomUUID()}::uuid,
            'verifyWorkflow', 'maintenance', ${'a'.repeat(40)}, 'STARTED',
            'started', '{}'::jsonb, 1
          )
        `;
        await tx.$executeRaw`
          UPDATE "workflow_run_receipt"
          SET "stage" = 'mutated'
          WHERE "receipt_key" = ${receiptKey}
        `;
      });
    } catch (error) {
      if (!appendOnlyBlocked(error)) throw error;
      workflowMutationBlocked = true;
    }
    if (!workflowMutationBlocked) throw new Error('WORKFLOW_RECEIPT_MUTATION_ALLOWED');

    let scheduleMutationBlocked = false;
    try {
      await db.$transaction(async (tx) => {
        const scheduleId = `verify-${randomUUID()}`;
        await tx.$executeRaw`
          INSERT INTO "schedule_drift_receipt" (
            "schedule_id", "disposition", "desired_hash", "changed_fields",
            "worker_build_sha"
          ) VALUES (
            ${scheduleId}, 'IN_SYNC', ${'b'.repeat(64)}, '[]'::jsonb,
            ${'a'.repeat(40)}
          )
        `;
        await tx.$executeRaw`
          DELETE FROM "schedule_drift_receipt"
          WHERE "schedule_id" = ${scheduleId}
        `;
      });
    } catch (error) {
      if (!appendOnlyBlocked(error)) throw error;
      scheduleMutationBlocked = true;
    }
    if (!scheduleMutationBlocked) throw new Error('SCHEDULE_RECEIPT_MUTATION_ALLOWED');

    const unique = randomUUID();
    const ingestId = randomUUID();
    const leaseToken = randomUUID();
    try {
      await db.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "signal_ingest" (
            "id", "provider_key", "query_fingerprint", "window_key", "query_spec",
            "status", "lease_owner", "lease_token", "lease_fence",
            "lease_expires_at", "started_at", "attempt"
          ) VALUES (
            ${ingestId}::uuid, ${`verify-${unique}`}, ${unique.replaceAll('-', '')}, ${new Date().toISOString()},
            ${JSON.stringify({})}::jsonb, 'PENDING', 'isolated-verifier', ${leaseToken}::uuid,
            1, NOW() + INTERVAL '5 minutes', NOW(), 1
          )
        `;
        const contender = await tx.$executeRaw`
          UPDATE "signal_ingest"
          SET "lease_owner" = 'contender', "lease_fence" = "lease_fence" + 1
          WHERE "provider_key" = ${`verify-${unique}`}
            AND "status" = 'PENDING'
            AND "lease_expires_at" < NOW()
        `;
        if (contender !== 0) throw new Error('LIVE_LEASE_STOLEN');
        const owner = await tx.$executeRaw`
          UPDATE "signal_ingest"
          SET "status" = 'OK',
              "lease_owner" = NULL,
              "lease_token" = NULL,
              "lease_expires_at" = NULL,
              "completed_at" = NOW()
          WHERE "provider_key" = ${`verify-${unique}`}
            AND "status" = 'PENDING'
            AND "lease_token" = ${leaseToken}::uuid
            AND "lease_fence" = 1
        `;
        if (owner !== 1) throw new Error('LEASE_OWNER_CANNOT_SETTLE');
        throw new VerificationRollback('rollback isolated verifier fixture');
      });
    } catch (error) {
      if (!(error instanceof VerificationRollback)) throw error;
      rolledBack = true;
    }
    if (!rolledBack) throw new Error('ISOLATED_FIXTURE_WAS_NOT_ROLLED_BACK');
  } finally {
    await db.$disconnect();
  }
  process.stdout.write(`RUNTIME_OPS_POSTGRES_VERIFIED database=${admission.databaseName}\n`);
}

verify().catch(() => {
  process.stderr.write('RUNTIME_OPS_POSTGRES_VERIFY_FAILED\n');
  process.exitCode = 1;
});
