/**
 * 预算 reserve-then-settle（评审要求：非 advisory Dry Run）。
 * 每个 run 一个预算账户；执行前原子预留估算额，执行后按实际结算，退还差额。
 * 并发调用共享同一账户 → 各自预留，避免共同超支。
 *
 * 进程内实现（单 worker 足够）；多 worker 时后端换 Redis/DB 原子扣减，接口不变。
 */
export class BudgetExceededError extends Error {
  constructor(
    public readonly runId: string,
    public readonly needCents: number,
    public readonly remainingCents: number,
  ) {
    super(`budget exceeded for run ${runId}: need ${needCents}¢, remaining ${remainingCents}¢`);
    this.name = 'BudgetExceededError';
  }
}

interface Account {
  capCents: number;
  reservedCents: number;
  settledCents: number;
}

export class BudgetLedger {
  private readonly accounts = new Map<string, Account>();

  /** 为一个 run 设定预算上限（幂等：已存在则取较大值，允许追加）。 */
  open(runId: string, capCents: number): void {
    const acc = this.accounts.get(runId);
    if (acc) acc.capCents = Math.max(acc.capCents, capCents);
    else this.accounts.set(runId, { capCents, reservedCents: 0, settledCents: 0 });
  }

  /** 原子预留；余额不足抛 BudgetExceededError。返回预留句柄。 */
  reserve(runId: string, estCents: number): { runId: string; estCents: number } {
    const acc = this.accounts.get(runId);
    if (!acc) {
      // 未开账户 = 不限预算（如无预算约束的内部调用）
      return { runId, estCents: 0 };
    }
    const remaining = acc.capCents - acc.reservedCents - acc.settledCents;
    if (estCents > remaining) throw new BudgetExceededError(runId, estCents, remaining);
    acc.reservedCents += estCents;
    return { runId, estCents };
  }

  /** 按实际成本结算并退还预留差额。 */
  settle(handle: { runId: string; estCents: number }, actualCents: number): void {
    const acc = this.accounts.get(handle.runId);
    if (!acc) return;
    acc.reservedCents -= handle.estCents;
    acc.settledCents += actualCents;
  }

  remainingCents(runId: string): number {
    const acc = this.accounts.get(runId);
    if (!acc) return Infinity;
    return acc.capCents - acc.reservedCents - acc.settledCents;
  }

  close(runId: string): void {
    this.accounts.delete(runId);
  }
}

/** 进程级单例（worker/API 各自持有；预算按 run 隔离）。 */
export const budgetLedger = new BudgetLedger();
