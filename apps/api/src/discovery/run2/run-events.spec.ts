import { describe, expect, it, vi } from 'vitest';
import { appendRunEvent } from './run-events';

function makeTx(maxSeq: bigint | null) {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data }));
  const aggregate = vi.fn(async () => ({ _max: { seq: maxSeq } }));
  return { tx: { runEvent: { aggregate, create } }, aggregate, create };
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

  it('retries the allocation when a concurrent writer took the same seq', async () => {
    const { tx, create, aggregate } = makeTx(10n);
    create
      .mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
      .mockResolvedValueOnce({});
    aggregate
      .mockResolvedValueOnce({ _max: { seq: 10n } })
      .mockResolvedValueOnce({ _max: { seq: 11n } });

    await appendRunEvent(tx as never, { workspaceId: 'ws-1', runId: 'run-1', type: 'company_done' });
    expect(create).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[1]![0] as { data: { seq: bigint } }).data.seq).toBe(12n);
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
