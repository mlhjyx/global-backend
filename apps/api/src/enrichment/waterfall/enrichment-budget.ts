/**
 * P1-08：富集预算端口（reserve/settle 语义，计划 §2.3.4.5）。
 *
 * 编排层在每次 finder 调用前 `reserve(预估成本)`、调用后 `settle(预估, 实际)`；
 * 预留不足即停当前联系人（skipped_budget），不阻断同 run 其它公司。
 *
 * 本文件提供内存实现（CLI / 单测 / run activity 的按联系人闸门用）；P1-10 的 HTTP
 * 端点与 run 预算账（ExecutionBudget Grant / ensureRunBudget）通过同一端口注入，
 * 不改变编排层语义。
 */

export interface EnrichmentBudget {
  /** 剩余可花（微美元）；undefined = 不限。 */
  remainingMicrousd(): number | undefined;
  /** 预留一次调用的预估成本；不足返回 false。 */
  reserve(estimateMicrousd: number): boolean;
  /** 结算：释放预留并按实际成本扣减（实际可为 0；与预估的差额在这里归位）。 */
  settle(reservedMicrousd: number, actualMicrousd: number): void;
}

/** 单联系人默认成本上限（$0.15：3 家 finder × $0.0198 + 最多 6 次验证，留足余量）。 */
export const DEFAULT_PER_CONTACT_CAP_MICROUSD = 150_000;

/** 固定上限的内存预算（并发安全无需锁：编排对单个联系人是串行的）。 */
export class CapBudget implements EnrichmentBudget {
  private reserved = 0;
  private spent = 0;

  constructor(private readonly capMicrousd: number | undefined) {}

  remainingMicrousd(): number | undefined {
    if (this.capMicrousd === undefined) return undefined;
    return Math.max(0, this.capMicrousd - this.spent - this.reserved);
  }

  reserve(estimateMicrousd: number): boolean {
    const estimate = Math.max(0, Math.round(estimateMicrousd));
    const remaining = this.remainingMicrousd();
    if (remaining !== undefined && remaining < estimate) return false;
    this.reserved += estimate;
    return true;
  }

  settle(reservedMicrousd: number, actualMicrousd: number): void {
    this.reserved = Math.max(0, this.reserved - Math.max(0, Math.round(reservedMicrousd)));
    if (Number.isFinite(actualMicrousd)) {
      this.spent += Math.max(0, Math.round(actualMicrousd));
    }
  }
}

/**
 * 组合预算：每次预留必须同时通过所有子预算（各子预算各自 reserve，任一失败全部回滚）。
 * run 内用 `min(perContactCap, remainingRunBudget)` 的语义时直接建两个 CapBudget 即可。
 */
export class CompositeBudget implements EnrichmentBudget {
  constructor(private readonly budgets: EnrichmentBudget[]) {}

  remainingMicrousd(): number | undefined {
    const values = this.budgets
      .map((budget) => budget.remainingMicrousd())
      .filter((value): value is number => value !== undefined);
    return values.length === 0 ? undefined : Math.min(...values);
  }

  reserve(estimateMicrousd: number): boolean {
    const taken: EnrichmentBudget[] = [];
    for (const budget of this.budgets) {
      if (!budget.reserve(estimateMicrousd)) {
        for (const granted of taken) granted.settle(estimateMicrousd, 0);
        return false;
      }
      taken.push(budget);
    }
    return true;
  }

  settle(reservedMicrousd: number, actualMicrousd: number): void {
    for (const budget of this.budgets) budget.settle(reservedMicrousd, actualMicrousd);
  }
}
