import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionBudgetGrantError } from './execution-budget-authority.types';
import {
  mayOpenRetryAccount,
  resolveRetryableWorkspaceAccountKey,
  type RetryCandidateState,
} from './execution-budget-retry-account';

const WORKSPACE_ID = 'e03abddd-1307-47cb-a731-7e7a786615a0';
const AUTHORITY_ID = '42c863b9-7c7e-4d28-8678-60ef9a20219b';
const EARLIER_AUTHORITY_ID = '9a0d4c55-3a31-4b8e-9d55-6f1d2c3b4a59';
const ICP_ID = 'f5ba98f2-a0e2-4e85-b799-e85568877702';
const REQUEST_SHA256 = 'a'.repeat(64);
const PRIMARY = `icp.query_plan:icp:${ICP_ID}:${REQUEST_SHA256}`;
const EARLIER_RETRY = `${PRIMARY}:retry:${EARLIER_AUTHORITY_ID}`;
const INPUT = Object.freeze({
  scopeKey: WORKSPACE_ID,
  authorityId: AUTHORITY_ID,
  purpose: 'icp.query_plan' as const,
  subjectType: 'icp',
  subjectId: ICP_ID,
  requestSha256: REQUEST_SHA256,
  primaryAccountKey: PRIMARY,
});
const NEVER_DISPATCHED: RetryCandidateState = Object.freeze({
  grantExpired: true,
  neverDispatched: true,
});

function stateRow(accountKey: string, overrides: Record<string, unknown> = {}) {
  return {
    account_key: accountKey,
    account_open: true,
    grant_expired: true,
    never_dispatched: true,
    ...overrides,
  };
}

type Query = { strings?: readonly string[]; values?: readonly unknown[] };
const sqlOf = (query: Query | undefined): string => query?.strings?.join('') ?? '';
const isLock = (query: Query): boolean => sqlOf(query).includes('pg_advisory_xact_lock');
const isClose = (query: Query): boolean => sqlOf(query).includes('close_tool_budget');
const isState = (query: Query): boolean => sqlOf(query).includes('"tool_budget_operation"');
const isEarlierAuthorities = (query: Query): boolean =>
  !isState(query) && sqlOf(query).includes('"execution_budget_authority"');

function fakeTx(answers: {
  primaryExists?: boolean;
  isolation?: string;
  earlierAuthorities?: unknown[];
  states?: unknown[];
} = {}) {
  const queries: Query[] = [];
  const tx = {
    $queryRaw: vi.fn(async (query: Query) => {
      queries.push(query);
      const sql = sqlOf(query);
      if (sql.includes('AS present')) return answers.primaryExists === false ? [] : [{ present: 1 }];
      if (sql.includes('transaction_isolation')) return [{ level: answers.isolation ?? 'read committed' }];
      if (isLock(query)) return [{ locked: 1 }];
      if (isClose(query)) return [{ closed: true }];
      if (isState(query)) return answers.states ?? [stateRow(PRIMARY), stateRow(EARLIER_RETRY)];
      if (isEarlierAuthorities(query)) {
        return (answers.earlierAuthorities ?? [EARLIER_AUTHORITY_ID]).map((id) => ({ id }));
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    }),
  };
  return { tx: tx as unknown as Prisma.TransactionClient, queries };
}

describe('mayOpenRetryAccount', () => {
  it('allows a retry account only when no earlier attempt dispatched and every grant is past its tolerance', () => {
    expect(mayOpenRetryAccount([NEVER_DISPATCHED, NEVER_DISPATCHED])).toBe(true);
  });

  it.each([
    ['an earlier grant still inside the 60-second tolerance', { grantExpired: false }],
    ['an earlier operation that was dispatched, settled or still open', { neverDispatched: false }],
  ])('keeps the original account for %s', (_case, override) => {
    expect(mayOpenRetryAccount([NEVER_DISPATCHED, { ...NEVER_DISPATCHED, ...override }])).toBe(false);
  });

  it('keeps the original account when no earlier account is visible', () => {
    expect(mayOpenRetryAccount([])).toBe(false);
  });
});

describe('resolveRetryableWorkspaceAccountKey', () => {
  it('never looks for retry accounts for a purpose that is not retryable', async () => {
    const { tx, queries } = fakeTx();
    await expect(
      resolveRetryableWorkspaceAccountKey(tx, { ...INPUT, purpose: 'understanding.run' }),
    ).resolves.toBe(PRIMARY);
    expect(queries).toHaveLength(0);
  });

  it('treats a request without an account as a first attempt and takes no lock', async () => {
    const { tx, queries } = fakeTx({ primaryExists: false });
    await expect(resolveRetryableWorkspaceAccountKey(tx, INPUT)).resolves.toBe(PRIMARY);
    expect(queries).toHaveLength(1);
    expect(sqlOf(queries[0])).toContain('"account_key" =');
  });

  it('refuses to rotate outside a READ COMMITTED transaction', async () => {
    const { tx, queries } = fakeTx({ isolation: 'repeatable read' });
    await expect(resolveRetryableWorkspaceAccountKey(tx, INPUT)).resolves.toBe(PRIMARY);
    expect(queries.some(isLock)).toBe(false);
  });

  it('serialises on the original ledger lock, reads every earlier account under its lock and closes them', async () => {
    const { tx, queries } = fakeTx();

    await expect(resolveRetryableWorkspaceAccountKey(tx, INPUT)).resolves.toBe(
      `${PRIMARY}:retry:${AUTHORITY_ID}`,
    );

    const locks = queries.filter(isLock);
    expect(locks.map((query) => query.values)).toEqual(
      [PRIMARY, EARLIER_RETRY].map((key) => [`tool-budget-account:${WORKSPACE_ID}:${key}`]),
    );
    const earlier = queries.findIndex(isEarlierAuthorities);
    expect(earlier).toBeGreaterThan(queries.indexOf(locks[0]!));
    expect(earlier).toBeLessThan(queries.indexOf(locks[1]!));
    const state = queries.find(isState)!;
    expect(queries.indexOf(state)).toBeGreaterThan(queries.indexOf(locks[1]!));
    expect(state.values).toEqual(expect.arrayContaining([PRIMARY, EARLIER_RETRY]));
    expect(sqlOf(state)).not.toMatch(/left\(|LIKE|starts_with/i);
    expect(sqlOf(state)).toContain("interval '60 seconds'");
    expect(sqlOf(state)).toContain("'RELEASED'");
    const closes = queries.filter(isClose);
    expect(closes.map((query) => query.values)).toEqual([
      [WORKSPACE_ID, PRIMARY, true],
      [WORKSPACE_ID, EARLIER_RETRY, true],
    ]);
    expect(queries.indexOf(closes[0]!)).toBeGreaterThan(queries.indexOf(state));
  });

  it('closes only the earlier accounts that are still open', async () => {
    const { tx, queries } = fakeTx({
      states: [stateRow(PRIMARY, { account_open: false }), stateRow(EARLIER_RETRY)],
    });
    await expect(resolveRetryableWorkspaceAccountKey(tx, INPUT)).resolves.toBe(
      `${PRIMARY}:retry:${AUTHORITY_ID}`,
    );
    expect(queries.filter(isClose).map((query) => query.values)).toEqual([
      [WORKSPACE_ID, EARLIER_RETRY, true],
    ]);
  });

  it.each([
    ['an earlier attempt dispatched a paid call', { never_dispatched: false }],
    ['an earlier grant is still inside its tolerance', { grant_expired: false }],
  ])('keeps the original account and closes nothing when %s', async (_case, override) => {
    const { tx, queries } = fakeTx({ states: [stateRow(PRIMARY), stateRow(EARLIER_RETRY, override)] });
    await expect(resolveRetryableWorkspaceAccountKey(tx, INPUT)).resolves.toBe(PRIMARY);
    expect(queries.some(isClose)).toBe(false);
  });

  it.each([
    ['a malformed state row', { states: [{ grant_expired: 'yes' }] }],
    ['a malformed earlier authority id', { earlierAuthorities: [42] }],
  ])('fails closed on %s', async (_case, answers) => {
    const { tx } = fakeTx(answers);
    await expect(resolveRetryableWorkspaceAccountKey(tx, INPUT)).rejects.toBeInstanceOf(
      ExecutionBudgetGrantError,
    );
  });
});
