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
  /** open/close 配对计数——并发共享同键账户（多页活动/重试）时，先完成者 close 不再误删他人在用的账。 */
  refs: number;
}

export class BudgetLedger {
  private readonly accounts = new Map<string, Account>();
  /**
   * 曾发生 reserve 失败（预算打穿）的账户键集合。这是「本 run/sweep 是否被预算截断」的**唯一真相点**：
   * provider 的 fail-safe catch 会把 BudgetExceededError 吞成空结果（对源失败是对的），编排层无法从
   * 返回值判断是「真没数据」还是「预算打穿被吞」。故在 reserve 抛错处打标，编排层用 {@link wasExhausted}
   * 独立于 provider 是否吞错地检出截断。账户 close（真正删除）时一并清除，生命周期与账户一致。
   */
  private readonly exhausted = new Set<string>();

  /** 为一个 run 设定预算上限（幂等：已存在则取较大值 + 引用计数 +1，允许追加）。 */
  open(runId: string, capCents: number): void {
    const acc = this.accounts.get(runId);
    if (acc) {
      acc.capCents = Math.max(acc.capCents, capCents);
      acc.refs += 1;
    } else {
      this.accounts.set(runId, { capCents, reservedCents: 0, settledCents: 0, refs: 1 });
    }
  }

  /** 原子预留；余额不足抛 BudgetExceededError。返回预留句柄。 */
  reserve(runId: string, estCents: number): { runId: string; estCents: number } {
    const acc = this.accounts.get(runId);
    if (!acc) {
      // 未开账户 = 不限预算（如无预算约束的内部调用）
      return { runId, estCents: 0 };
    }
    const remaining = acc.capCents - acc.reservedCents - acc.settledCents;
    if (estCents > remaining) {
      this.exhausted.add(runId); // 唯一真相点：打穿即打标，供编排层 wasExhausted 检出（哪怕 provider 吞了错）
      throw new BudgetExceededError(runId, estCents, remaining);
    }
    acc.reservedCents += estCents;
    return { runId, estCents };
  }

  /** 按实际成本结算并退还预留差额（对已被关闭/重开账户的迟到句柄钳制到 0，不打负）。 */
  settle(handle: { runId: string; estCents: number }, actualCents: number): void {
    const acc = this.accounts.get(handle.runId);
    if (!acc) return;
    acc.reservedCents = Math.max(0, acc.reservedCents - handle.estCents);
    acc.settledCents += actualCents;
  }

  remainingCents(runId: string): number {
    const acc = this.accounts.get(runId);
    if (!acc) return Infinity;
    return acc.capCents - acc.reservedCents - acc.settledCents;
  }

  /**
   * 本账户在其生命周期内是否曾 reserve 失败（预算打穿）。编排层据此判定「run/sweep 被预算截断」——
   * 无需 provider 把 BudgetExceededError 透传（provider 可继续 fail-safe 返回已拿到的部分结果）。
   */
  wasExhausted(runId: string): boolean {
    return this.exhausted.has(runId);
  }

  /**
   * 引用计数 -1，归零才真正删账（open/close 配对；多余 close 容忍为 no-op）。
   * force=true 无视计数直接删（run 生命周期终点，如 finalizeRun——run 内多个活动各 open 过）。
   */
  close(runId: string, opts?: { force?: boolean }): void {
    const acc = this.accounts.get(runId);
    if (!acc) return;
    acc.refs -= 1;
    if (opts?.force || acc.refs <= 0) {
      this.accounts.delete(runId);
      this.exhausted.delete(runId); // 打穿标记与账户同生命周期：下次 open 同键从干净状态起（防跨轮/跨测泄漏）
    }
  }
}

/** 进程级单例（worker/API 各自持有；预算按 run 隔离）。 */
export const budgetLedger = new BudgetLedger();

// ── 预算上限配置（收口②「真开账」：编排层用这些 cap 调 open()，超限 reserve 抛错=真拦截）──

function intFromEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/** 单个 discovery run 的预算上限（¢）。默认宽松（$20），先让账真实开起来，再按 backtest 收紧。 */
export function runBudgetCents(): number {
  return intFromEnv('RUN_BUDGET_CENTS', 2000);
}

/** 单轮 sweep（backlog 等·per-workspace）的预算上限（¢）。 */
export function sweepBudgetCents(): number {
  return intFromEnv('SWEEP_BUDGET_CENTS', 5000);
}

/** LLM 调用无任务契约 maxCostCents 时的保守预留估算（¢）。 */
export const DEFAULT_LLM_EST_CENTS = 20;
