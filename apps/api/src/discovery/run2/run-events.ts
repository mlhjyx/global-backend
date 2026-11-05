/**
 * M0③ run 进度事件写入（RunEvent，append-only）。
 *
 * seq 在事务内按 (run_id) 取 max+1。并发写者（父/子工作流、重试活动）先对 run 取事务级
 * advisory lock 再取号，同一 run 的事件写入因此串行、seq 连续无洞；读方按 seq 增量拉取，从不丢序。
 * 事件与状态更新放在同一事务里，避免「状态变了但事件没写」。
 *
 * 为什么不是「唯一冲突 → 重试取号」（2026-11-04 验收在 16 并发深挖下暴露）：PostgreSQL 一旦
 * 报唯一冲突就把当前事务标为 aborted，事务内后续语句一律 25P02，重试注定失败；更糟的是同事务
 * 里的状态更新（如 company job 阶段推进）会跟着回滚——曾把一家公司卡死在 profiling。锁先行
 * 即从源头避免冲突；任何仍出现的数据库错误（含唯一冲突）直接上抛，由调用方的外层事务重试。
 */

export type RunEventType =
  | 'phase_started'
  | 'phase_completed'
  | 'company_entered_stage'
  | 'company_done'
  | 'company_failed'
  | 'budget_exhausted'
  | 'lease_skipped'
  | 'pool_cap_reached'
  | 'run_finished';

export interface RunEventInput {
  workspaceId: string;
  runId: string;
  type: RunEventType;
  level?: 'info' | 'warn' | 'error';
  payload?: Record<string, unknown>;
}

interface RunEventTx {
  $queryRaw: (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown>;
  runEvent: {
    aggregate: (args: {
      where: { runId: string };
      _max: { seq: true };
    }) => Promise<{ _max: { seq: bigint | null } }>;
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
}

export async function appendRunEvent(
  tx: RunEventTx,
  input: RunEventInput,
): Promise<void> {
  // 同一 run 的写入串行化；事务级锁随调用方事务提交/回滚自动释放。
  // Prisma 无法反序列化 PostgreSQL void：锁函数的结果必须显式转成 text
  // （2026-11-04 首次上生产即以 42501 式的反序列化错误卡死 quickScan）。
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`run-event:${input.runId}`}, 0))::text AS locked`;
  const current = await tx.runEvent.aggregate({
    where: { runId: input.runId },
    _max: { seq: true },
  });
  const seq = (current._max.seq ?? 0n) + 1n;
  await tx.runEvent.create({
    data: {
      workspaceId: input.workspaceId,
      runId: input.runId,
      seq,
      level: input.level ?? 'info',
      type: input.type,
      ...(input.payload ? { payload: input.payload } : {}),
    },
  });
}
