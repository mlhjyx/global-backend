import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  buildVerificationRequestHash,
  recordContactPointVerificationEvent,
} from './contact-point-verification-event';

/**
 * P1：验证事件账写入器的并发/幂等契约——SAVEPOINT 回滚点保证 P2002 之后同一事务仍可读，
 * 重复尝试返回 duplicate=true；畸形成本归 0 不抛。
 */
const INPUT = {
  workspaceId: '00000000-0000-4000-8000-0000000000aa',
  contactPointId: '00000000-0000-4000-8000-0000000000bb',
  providerKey: 'millionverifier',
  method: 'third_party_api' as const,
  verdict: 'valid' as const,
  detail: 'ok:ok.mailbox',
  catchAll: 'not_catch_all' as const,
  catchAllClass: 'not_catch_all' as const,
  score: 95,
  costMicrousd: 1_780,
  lawfulBasis: null,
  actorId: 'reverify-sweep:cli',
  requestHash: buildVerificationRequestHash('00000000-0000-4000-8000-0000000000bb', 'millionverifier', 'v1'),
  latencyMs: 42,
};

function fakeTx(overrides?: {
  create?: ReturnType<typeof vi.fn>;
  findUnique?: ReturnType<typeof vi.fn>;
}) {
  const executeRawUnsafe = vi.fn(async () => 1);
  const create = overrides?.create ?? vi.fn(async () => ({ id: 'event-1' }));
  const findUnique = overrides?.findUnique ?? vi.fn(async () => null);
  const tx = {
    contactPointVerificationEvent: {
      count: vi.fn(async () => 0),
      create,
      findUnique,
    },
    $executeRawUnsafe: executeRawUnsafe,
  };
  return { tx, create, findUnique, executeRawUnsafe };
}

describe('buildVerificationRequestHash', () => {
  it('确定性 + 长度前缀编码（字段含分隔符不跨元组碰撞）', () => {
    const a = buildVerificationRequestHash('p', 'prov', 'value|bucket');
    expect(a).toBe(buildVerificationRequestHash('p', 'prov', 'value|bucket'));
    expect(a).not.toBe(buildVerificationRequestHash('p|prov', 'value|bucket', ''));
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('recordContactPointVerificationEvent', () => {
  it('常规路径：先 SAVEPOINT 再插入，成本 micro 换算为 BigInt', async () => {
    const { tx, create, executeRawUnsafe } = fakeTx();
    await expect(
      recordContactPointVerificationEvent(tx as never, INPUT),
    ).resolves.toEqual({ id: 'event-1', duplicate: false });
    expect(executeRawUnsafe).toHaveBeenCalledWith('SAVEPOINT cpve_write');
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]?.data?.costMicrousd).toBe(1_780n);
  });

  it('P2002 竞态：ROLLBACK TO SAVEPOINT 后回读已存在行（事务仍可用）', async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const { tx, executeRawUnsafe, findUnique } = fakeTx({
      create: vi.fn(async () => {
        throw duplicate;
      }),
      findUnique: vi.fn(async () => ({ id: 'event-existing' })),
    });
    await expect(
      recordContactPointVerificationEvent(tx as never, INPUT),
    ).resolves.toEqual({ id: 'event-existing', duplicate: true });
    expect(executeRawUnsafe).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT cpve_write');
    expect(findUnique).toHaveBeenCalledOnce();
  });

  it('竞态对手未提交：回读为空时 duplicate=true 且 id=null（调用方跳过链接）', async () => {
    const duplicate = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const { tx } = fakeTx({
      create: vi.fn(async () => {
        throw duplicate;
      }),
      findUnique: vi.fn(async () => null),
    });
    await expect(recordContactPointVerificationEvent(tx as never, INPUT)).resolves.toEqual({
      id: null,
      duplicate: true,
    });
  });

  it('非 P2002 错误原样抛出（不吞真实故障）', async () => {
    const { tx } = fakeTx({
      create: vi.fn(async () => {
        throw new Error('connection lost');
      }),
    });
    await expect(recordContactPointVerificationEvent(tx as never, INPUT)).rejects.toThrow(
      'connection lost',
    );
  });

  it('NaN/Infinity 成本归 0，不抛 BigInt RangeError', async () => {
    const { tx, create } = fakeTx();
    await recordContactPointVerificationEvent(tx as never, { ...INPUT, costMicrousd: Number.NaN });
    expect(create.mock.calls[0]?.[0]?.data?.costMicrousd).toBe(0n);
    await recordContactPointVerificationEvent(tx as never, { ...INPUT, costMicrousd: Number.POSITIVE_INFINITY });
    expect(create.mock.calls[1]?.[0]?.data?.costMicrousd).toBe(0n);
  });
});
