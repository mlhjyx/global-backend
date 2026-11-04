import { describe, expect, it, vi } from 'vitest';
import { appendRunEvent } from './run-events';

function makeTx(maxSeq: bigint | null) {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data }));
  const aggregate = vi.fn(async () => ({ _max: { seq: maxSeq } }));
  const queryRaw = vi.fn(async () => [{ pg_advisory_xact_lock: null }]);
  return { tx: { $queryRaw: queryRaw, runEvent: { aggregate, create } }, aggregate, create, queryRaw };
}

describe('M0③ run 进度事件（append-only，seq 单调）', () => {
  it('allocates seq 1 for the first event and the next seq after the current max', async () => {
    const first = makeTx(null);
    await appendRunEvent(first.tx as never, {
      workspaceId: 'ws-1',
      runId: 'run-1',
      type: 'phase_started',
      payload: { phase: 'quick' },
    });
    expect(first.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ workspaceId: 'ws-1', runId: 'run-1', seq: 1n, level: 'info', type: 'phase_started' }),
    });

    const next = makeTx(41n);
    await appendRunEvent(next.tx as never, { workspaceId: 'ws-1', runId: 'run-1', type: 'phase_completed' });
    expect(next.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ seq: 42n }),
    });
  });

  it('serializes writers per run with a transaction-scoped advisory lock before allocating seq', async () => {
    const { tx, queryRaw, aggregate } = makeTx(7n);
    await appendRunEvent(tx as never, { workspaceId: 'ws-1', runId: 'run-1', type: 'company_done' });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    // Prisma 的标签模板把锁键作为绑定值传入，SQL 文本里只有占位符。
    const sql = (queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(String(queryRaw.mock.calls[0]![1])).toBe('run-event:run-1');
    expect(queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(aggregate.mock.invocationCallOrder[0]!);
  });

  it('does not retry a unique collision inside the transaction (PostgreSQL aborts it with 25P02)', async () => {
    const { tx, create, queryRaw } = makeTx(10n);
    // 2026-11-04 实测：唯一冲突后事务被 PostgreSQL 标为 aborted，事务内再取号只会报 25P02，
    // 且同事务的状态更新全部回滚。冲突必须直接上抛，由外层事务重试。
    create.mockImplementationOnce(async () => {
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    });
    await expect(
      appendRunEvent(tx as never, { workspaceId: 'ws-1', runId: 'run-1', type: 'company_done' }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('surfaces a non-unique database error without retrying', async () => {
    const { tx, create } = makeTx(3n);
    create.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'P2003' }));
    await expect(
      appendRunEvent(tx as never, { workspaceId: 'ws-1', runId: 'run-1', type: 'run_finished' }),
    ).rejects.toThrow('boom');
    expect(create).toHaveBeenCalledTimes(1);
  });
});
