/**
 * L0 可选搜索引擎滑动健康度熔断器（Batch 1.5-C）。
 *
 * 现网 run 607b314d 观察到 Exa 偶发 5xx、SearXNG 上游偶发 403 暂停，但每条查询仍会
 * 同步反复撞墙拖慢整轮检索。本模块维护进程内轻量的连续失败计数与冷却窗口：
 *  - 连续失败 >= 3 次 → 进入冷却（默认 120 秒），冷却期内自动跳过该可选引擎；
 *  - 冷却到期后自动半开放行一次试探，成功即清零恢复，失败则重新冷却；
 *  - 仅用于可选补充源（serper / brave / exa / google_places），不影响 SearXNG 主基线或预算控制错误。
 */

export interface SearchEngineCircuitOptions {
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

interface EngineHealthState {
  consecutiveFailures: number;
  openUntilMs: number;
}

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 120_000;

export class SearchEngineHealthTracker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly state = new Map<string, EngineHealthState>();

  constructor(opts: SearchEngineCircuitOptions = {}) {
    this.failureThreshold = Math.max(1, opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
    this.cooldownMs = Math.max(1_000, opts.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.now = opts.now ?? Date.now;
  }

  /** 当前是否允许调用该可选引擎（冷却期内返回 false，到期后允许半开试探）。 */
  isAvailable(engine: string): boolean {
    const entry = this.state.get(engine);
    if (!entry) return true;
    return this.now() >= entry.openUntilMs;
  }

  recordSuccess(engine: string): void {
    this.state.delete(engine);
  }

  recordFailure(engine: string): { opened: boolean; openUntilMs: number } {
    const prev = this.state.get(engine) ?? { consecutiveFailures: 0, openUntilMs: 0 };
    const consecutiveFailures = prev.consecutiveFailures + 1;
    const opened = consecutiveFailures >= this.failureThreshold;
    const openUntilMs = opened ? this.now() + this.cooldownMs : 0;
    this.state.set(engine, { consecutiveFailures, openUntilMs });
    return { opened, openUntilMs };
  }

  reset(): void {
    this.state.clear();
  }
}

/** 进程级共享健康度跟踪器（供 public_web / directory 复用，测试可调用 reset() 清理）。 */
export const sharedSearchEngineHealth = new SearchEngineHealthTracker();
