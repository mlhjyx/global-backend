/**
 * M0③ run 进度事件写入（RunEvent，append-only）。
 *
 * seq 在事务内按 (run_id) 取 max+1；并发写者（父/子工作流、重试活动）撞上同一 seq 时
 * 由数据库唯一约束（run_id, seq）拒绝，写入方重试重新取号——读方按 seq 增量拉取，从不丢序。
 * 事件与状态更新放在同一事务里，避免「状态变了但事件没写」。
 */

export type RunEventType =
  | 'phase_started'
  | 'phase_completed'
  | 'company_entered_stage'
  | 'company_done'
  | 'company_failed'
  | 'budget_exhausted'
  | 'lease_skipped'
  | 'run_finished';

export interface RunEventInput {
  workspaceId: string;
  runId: string;
  type: RunEventType;
  level?: 'info' | 'warn' | 'error';
  payload?: Record<string, unknown>;
}

interface RunEventTx {
  runEvent: {
    aggregate: (args: {
      where: { runId: string };
      _max: { seq: true };
    }) => Promise<{ _max: { seq: bigint | null } }>;
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
}

const MAX_SEQ_ATTEMPTS = 3;

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002';
}

export async function appendRunEvent(
  tx: RunEventTx,
  input: RunEventInput,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt += 1) {
    const current = await tx.runEvent.aggregate({
      where: { runId: input.runId },
      _max: { seq: true },
    });
    const seq = (current._max.seq ?? 0n) + 1n;
    try {
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
      return;
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === MAX_SEQ_ATTEMPTS - 1) throw error;
    }
  }
}
