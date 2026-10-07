import { Prisma } from '@prisma/client';
import {
  ExecutionBudgetGrantError,
  type ExecutionBudgetPurpose,
} from './execution-budget-authority.types';
import {
  RETRYABLE_WORKSPACE_PURPOSES,
  retryWorkspaceAccountKey,
} from './execution-budget-binding';

export interface RetryCandidateState {
  /** The grant is past the 60-second tolerance the ledger itself applies. */
  readonly grantExpired: boolean;
  /** Every operation was released before dispatch, or there is none. */
  readonly neverDispatched: boolean;
}

export interface RetryAccountInput {
  readonly scopeKey: string;
  readonly authorityId: string;
  readonly purpose: ExecutionBudgetPurpose;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly requestSha256: string;
  readonly primaryAccountKey: string;
}

interface CandidateAccount extends RetryCandidateState {
  readonly accountKey: string;
  readonly open: boolean;
}

function unavailable(): ExecutionBudgetGrantError {
  return new ExecutionBudgetGrantError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');
}

/**
 * A request may move to a fresh account only when no earlier attempt can have
 * reached a provider: a settled operation may hide a timeout, a 524 or a broken
 * stream whose upstream outcome is unknown, so only released operations count.
 */
export function mayOpenRetryAccount(
  candidates: readonly RetryCandidateState[],
): boolean {
  return (
    candidates.length > 0 &&
    candidates.every((candidate) => candidate.grantExpired && candidate.neverDispatched)
  );
}

/** Same advisory lock that reserve, settle, release and close take. */
async function lockLedgerAccount(
  tx: Prisma.TransactionClient,
  scopeKey: string,
  accountKey: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT 1 AS locked FROM pg_advisory_xact_lock(
      hashtextextended(${`tool-budget-account:${scopeKey}:${accountKey}`}, 0)
    )`,
  );
}

async function isReadCommitted(tx: Prisma.TransactionClient): Promise<boolean> {
  const rows = await tx.$queryRaw<unknown[]>(
    Prisma.sql`SELECT current_setting('transaction_isolation') AS level`,
  );
  const level = (rows[0] as { level?: unknown } | undefined)?.level;
  if (typeof level !== 'string') throw unavailable();
  return level === 'read committed';
}

async function earlierAuthorityIds(
  tx: Prisma.TransactionClient,
  input: RetryAccountInput,
): Promise<string[]> {
  const rows = await tx.$queryRaw<unknown[]>(
    Prisma.sql`SELECT "id"::text AS id
      FROM "execution_budget_authority"
     WHERE "workspace_id" = ${input.scopeKey}::uuid
       AND "purpose" = ${input.purpose}::"execution_budget_purpose"
       AND "scope_key" = ${input.scopeKey}
       AND "authority_kind" = 'WORKSPACE_GRANT'
       AND "subject_type" = ${input.subjectType}
       AND "subject_id" = ${input.subjectId}
       AND "request_sha256" = ${input.requestSha256}
       AND "id" <> ${input.authorityId}::uuid`,
  );
  return rows.map((row) => {
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') throw unavailable();
    return id;
  });
}

function parseCandidateRow(row: unknown): CandidateAccount {
  const candidate = (row ?? {}) as Record<string, unknown>;
  if (
    typeof candidate.account_key !== 'string' ||
    typeof candidate.account_open !== 'boolean' ||
    typeof candidate.grant_expired !== 'boolean' ||
    typeof candidate.never_dispatched !== 'boolean'
  ) {
    throw unavailable();
  }
  return {
    accountKey: candidate.account_key,
    open: candidate.account_open,
    grantExpired: candidate.grant_expired,
    neverDispatched: candidate.never_dispatched,
  };
}

/**
 * The expiry test mirrors the EXPIRED branch of
 * execution_budget_authority_time_state, which app_user may not execute.
 */
async function candidateAccounts(
  tx: Prisma.TransactionClient,
  scopeKey: string,
  accountKeys: readonly string[],
): Promise<CandidateAccount[]> {
  const rows = await tx.$queryRaw<unknown[]>(
    Prisma.sql`SELECT account."account_key" AS account_key,
        (account."closed_at" IS NULL) AS account_open,
        COALESCE(authority."expires_at"::timestamptz(3)
          < date_trunc('second', statement_timestamp())::timestamptz(3)
            - interval '60 seconds', false) AS grant_expired,
        COALESCE(bool_and(operation."status" = 'RELEASED'), true) AS never_dispatched
      FROM "tool_budget_account" account
      LEFT JOIN "execution_budget_authority" authority
        ON authority."scope_key" = account."scope_key"
       AND authority."id" = account."authority_id"
      LEFT JOIN "tool_budget_operation" operation
        ON operation."scope_key" = account."scope_key"
       AND operation."account_id" = account."id"
     WHERE account."scope_key" = ${scopeKey}
       AND account."account_key" IN (${Prisma.join(accountKeys)})
     GROUP BY account."id", authority."expires_at"`,
  );
  return rows.map(parseCandidateRow);
}

/**
 * A workspace account is keyed by its grant's request, so one failure used to
 * lock the subject for good: every later grant hit GRANT_REUSED. For purposes
 * whose success always leaves a durable result, a new grant opens
 * `<key>:retry:<authority id>` when every earlier account for the request never
 * dispatched a paid call and its grant is past the ledger's tolerance.
 *
 * Every retry of a request first queues on the original account's ledger lock,
 * so it sees any retry that committed before it. The earlier accounts are read
 * under their own ledger locks in a fresh READ COMMITTED snapshot, then closed,
 * so a reserve that was waiting behind those locks fails instead of spending.
 */
export async function resolveRetryableWorkspaceAccountKey(
  tx: Prisma.TransactionClient,
  input: RetryAccountInput,
): Promise<string> {
  const primary = input.primaryAccountKey;
  if (!RETRYABLE_WORKSPACE_PURPOSES.has(input.purpose)) return primary;
  const existing = await tx.$queryRaw<unknown[]>(
    Prisma.sql`SELECT 1 AS present FROM "tool_budget_account"
      WHERE "scope_key" = ${input.scopeKey} AND "account_key" = ${primary}`,
  );
  if (existing.length === 0) return primary;
  if (!(await isReadCommitted(tx))) return primary;

  await lockLedgerAccount(tx, input.scopeKey, primary);
  const earlierKeys = (await earlierAuthorityIds(tx, input))
    .map((id) => retryWorkspaceAccountKey(primary, id))
    .sort();
  for (const key of earlierKeys) {
    await lockLedgerAccount(tx, input.scopeKey, key);
  }
  const accounts = await candidateAccounts(tx, input.scopeKey, [primary, ...earlierKeys]);
  if (!mayOpenRetryAccount(accounts)) return primary;
  for (const account of accounts) {
    if (!account.open) continue;
    await tx.$queryRaw(
      Prisma.sql`SELECT close_tool_budget(${input.scopeKey}, ${account.accountKey}, ${true}) AS closed`,
    );
  }
  return retryWorkspaceAccountKey(primary, input.authorityId);
}
