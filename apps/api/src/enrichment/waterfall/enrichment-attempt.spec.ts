import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  ENRICHMENT_HIT_CACHE_MS,
  ENRICHMENT_MISS_CACHE_MS,
  findReusableAttempt,
  recordEnrichmentAttempt,
  updateAttemptEmailState,
} from './enrichment-attempt';

/**
 * P1-08：富集尝试账——幂等写入（P2002→回读）、TTL 复用口径、emailState 回填。
 */
const NOW = new Date('2026-11-09T12:00:00.000Z');
const WORKSPACE = '00000000-0000-4000-8000-0000000000aa';
const CONTACT = '00000000-0000-4000-8000-0000000000bb';
const HASH = 'a'.repeat(64);

interface Row {
  id: string;
  providerKey: string;
  requestHash: string;
  outcome: string;
  errorCode: string | null;
  emailState: string | null;
  costMicrousd: bigint;
  attemptedAt: Date;
}

function fakeTx(seed: { exact?: Row; recentHit?: Row } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const tx = {
    contactEnrichmentAttempt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: `attempt-${created.length + 1}`,
          providerKey: data.providerKey as string,
          requestHash: data.requestHash as string,
          outcome: data.outcome as string,
          errorCode: (data.errorCode as string | null) ?? null,
          emailState: (data.emailState as string | null) ?? null,
          costMicrousd: data.costMicrousd as bigint,
          attemptedAt: (data.attemptedAt as Date | undefined) ?? NOW,
        };
        created.push(data);
        return row;
      }),
      findUnique: vi.fn(async () => seed.exact ?? null),
      findFirst: vi.fn(async () => seed.recentHit ?? null),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updated.push(data);
        return { id: 'attempt-1', ...data };
      }),
    },
    $executeRawUnsafe: vi.fn(async () => 1),
  };
  return { tx, created, updated };
}

const row = (overrides: Partial<Row> = {}): Row => ({
  id: 'attempt-old',
  providerKey: 'hunter',
  requestHash: HASH,
  outcome: 'hit',
  errorCode: null,
  emailState: 'VALID',
  costMicrousd: 1_700n,
  attemptedAt: NOW,
  ...overrides,
});

const baseInput = {
  workspaceId: WORKSPACE,
  contactId: CONTACT,
  providerKey: 'hunter',
  requestHash: HASH,
  outcome: 'hit' as const,
  costMicrousd: 1_700,
  latencyMs: 120,
  accountKey: 'acct-1',
  attemptedAt: NOW,
};

describe('recordEnrichmentAttempt', () => {
  it('写入一行：成本转 bigint、证据 JsonNull、返回快照', async () => {
    const { tx, created } = fakeTx();
    const result = await recordEnrichmentAttempt(tx as never, {
      ...baseInput,
      emailState: 'VALID',
      evidence: null,
      runId: 'run-1',
    });
    expect(result.duplicate).toBe(false);
    expect(result.attempt).toMatchObject({
      id: 'attempt-1',
      providerKey: 'hunter',
      outcome: 'hit',
      costMicrousd: 1_700,
    });
    expect(created[0]).toMatchObject({
      costMicrousd: 1_700n,
      latencyMs: 120,
      evidence: Prisma.JsonNull,
      emailState: 'VALID',
      runId: 'run-1',
    });
  });

  it('唯一键冲突（P2002）→ SAVEPOINT 回滚 + 回读，duplicate=true', async () => {
    const { tx } = fakeTx({ exact: row() });
    const create = tx.contactEnrichmentAttempt.create as ReturnType<typeof vi.fn>;
    create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' }),
    );
    const result = await recordEnrichmentAttempt(tx as never, baseInput);
    expect(result.duplicate).toBe(true);
    expect(result.attempt?.id).toBe('attempt-old');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT cea_write');
  });

  it('非有限成本按 0 记（不抛）', async () => {
    const { tx, created } = fakeTx();
    await recordEnrichmentAttempt(tx as never, { ...baseInput, costMicrousd: Number.NaN });
    expect(created[0]?.costMicrousd).toBe(0n);
  });
});

describe('findReusableAttempt：TTL 复用口径', () => {
  const input = { workspaceId: WORKSPACE, contactId: CONTACT, providerKey: 'hunter', requestHash: HASH };

  it('同 request_hash 的 hit 在 90 天内 → 复用', async () => {
    const { tx } = fakeTx({ exact: row({ attemptedAt: new Date(NOW.getTime() - 1000) }) });
    expect(await findReusableAttempt(tx as never, { ...input, now: NOW })).toMatchObject({
      id: 'attempt-old',
      outcome: 'hit',
    });
  });

  it('同 request_hash 的 hit 超过 90 天且无更近 hit → null', async () => {
    const { tx } = fakeTx({
      exact: row({ attemptedAt: new Date(NOW.getTime() - ENRICHMENT_HIT_CACHE_MS - 1) }),
    });
    expect(await findReusableAttempt(tx as never, { ...input, now: NOW })).toBeNull();
  });

  it('miss 在 24 小时内复用；超过 24 小时可重试', async () => {
    const fresh = fakeTx({
      exact: row({ outcome: 'miss', emailState: null, attemptedAt: new Date(NOW.getTime() - 3_600_000) }),
    });
    expect(await findReusableAttempt(fresh.tx as never, { ...input, now: NOW })).toMatchObject({
      outcome: 'miss',
    });
    const stale = fakeTx({
      exact: row({
        outcome: 'miss',
        emailState: null,
        attemptedAt: new Date(NOW.getTime() - ENRICHMENT_MISS_CACHE_MS - 1),
      }),
    });
    expect(await findReusableAttempt(stale.tx as never, { ...input, now: NOW })).toBeNull();
  });

  it('换输入版本（不同 request_hash）但同联系人同 provider 有 90 天内 hit → 复用（不重复购买）', async () => {
    const { tx } = fakeTx({
      recentHit: row({ requestHash: 'b'.repeat(64), attemptedAt: new Date(NOW.getTime() - 1000) }),
    });
    const reused = await findReusableAttempt(tx as never, { ...input, now: NOW });
    expect(reused?.requestHash).toBe('b'.repeat(64));
  });

  it('无任何行 → null', async () => {
    const { tx } = fakeTx();
    expect(await findReusableAttempt(tx as never, { ...input, now: NOW })).toBeNull();
  });
});

describe('updateAttemptEmailState', () => {
  it('只更新 emailState 列', async () => {
    const { tx, updated } = fakeTx();
    await updateAttemptEmailState(tx as never, 'attempt-1', 'CATCH_ALL_RISKY');
    expect(updated[0]).toEqual({ emailState: 'CATCH_ALL_RISKY' });
  });
});
