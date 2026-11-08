/**
 * 三态熔断器（章节 §6.3.5）：Closed → Open(5min) → Half-Open(放 1 个探测) → Closed / Open(10min 起，指数封顶 1h)。
 *
 * 分层：breaker 管分钟级（保护上游与自身），failure streak 管天级（20/4、30/7，见 channel-health.ts），
 * 两者独立计数、互不清零。状态以 JSON 物化到 source_channel.health_state，每次变化写
 * source_channel_health_event（由调用方落库）。
 */

export type CircuitStateValue = 'closed' | 'open' | 'half_open';

export type CircuitEventName = 'CIRCUIT_CLOSED' | 'CIRCUIT_OPEN' | 'CIRCUIT_HALF_OPEN';

export interface CircuitSnapshot {
  readonly circuit: CircuitStateValue;
  readonly consecutiveFailures: number;
  readonly openedUntil: string | null;
  readonly lastErrorCode: string | null;
  readonly openMs: number | null;
}

export interface CircuitTransition {
  readonly from: CircuitStateValue;
  readonly to: CircuitStateValue;
  readonly event: CircuitEventName;
  readonly reason: string;
}

export interface CircuitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs?: number;
  readonly transition?: CircuitTransition;
}

export interface ChannelCircuitConfig {
  readonly failureThreshold: number;
  readonly windowMs: number;
  readonly minRequests: number;
  readonly failureRateThreshold: number;
  readonly openMs: number;
  readonly reopenMs: number;
  readonly maxOpenMs: number;
}

export const DEFAULT_CIRCUIT_CONFIG: ChannelCircuitConfig = Object.freeze({
  failureThreshold: 5,
  windowMs: 300_000,
  minRequests: 5,
  failureRateThreshold: 0.5,
  openMs: 300_000,
  reopenMs: 600_000,
  maxOpenMs: 3_600_000,
});

interface WindowEntry {
  at: number;
  ok: boolean;
}

export class ChannelCircuitBreaker {
  private circuit: CircuitStateValue;
  private consecutiveFailures: number;
  private openedUntilMs: number | null;
  private lastErrorCode: string | null;
  private openMs: number | null;
  private halfOpenProbeInFlight = false;
  private window: WindowEntry[] = [];

  private readonly config: ChannelCircuitConfig;
  private readonly now: () => number;

  constructor(
    initial: Partial<CircuitSnapshot> | null | undefined,
    config: Partial<ChannelCircuitConfig> = {},
    now: () => number = Date.now,
  ) {
    this.config = { ...DEFAULT_CIRCUIT_CONFIG, ...config };
    this.now = now;
    this.circuit = initial?.circuit ?? 'closed';
    this.consecutiveFailures = initial?.consecutiveFailures ?? 0;
    this.openedUntilMs = initial?.openedUntil ? Date.parse(initial.openedUntil) : null;
    this.lastErrorCode = initial?.lastErrorCode ?? null;
    this.openMs = initial?.openMs ?? null;
  }

  allowRequest(): CircuitDecision {
    const now = this.now();
    if (this.circuit === 'open') {
      if (this.openedUntilMs !== null && now >= this.openedUntilMs) {
        this.circuit = 'half_open';
        this.halfOpenProbeInFlight = true;
        return {
          allowed: true,
          transition: {
            from: 'open',
            to: 'half_open',
            event: 'CIRCUIT_HALF_OPEN',
            reason: 'open window elapsed; single probe admitted',
          },
        };
      }
      return { allowed: false, retryAfterMs: Math.max(0, (this.openedUntilMs ?? now) - now) };
    }
    if (this.circuit === 'half_open') {
      if (this.halfOpenProbeInFlight) return { allowed: false, retryAfterMs: 1000 };
      this.halfOpenProbeInFlight = true;
      return { allowed: true };
    }
    return { allowed: true };
  }

  recordSuccess(): CircuitTransition[] {
    this.consecutiveFailures = 0;
    this.halfOpenProbeInFlight = false;
    if (this.circuit !== 'closed') {
      this.circuit = 'closed';
      this.window = [];
      this.openedUntilMs = null;
      this.openMs = null;
      this.lastErrorCode = null;
      return [{ from: 'half_open', to: 'closed', event: 'CIRCUIT_CLOSED', reason: 'probe succeeded' }];
    }
    // 闭合态的普通成功只进窗口（供失败率统计），不清窗口。
    this.window.push({ at: this.now(), ok: true });
    this.pruneWindow(this.now());
    return [];
  }

  recordFailure(errorCode?: string): CircuitTransition[] {
    if (errorCode !== undefined) this.lastErrorCode = errorCode;
    const now = this.now();
    if (this.circuit === 'half_open') {
      this.halfOpenProbeInFlight = false;
      // 首次重开 10 分钟（reopenMs），之后每次半开失败翻倍，封顶 maxOpenMs。
      const duration = Math.min(Math.max((this.openMs ?? 0) * 2, this.config.reopenMs), this.config.maxOpenMs);
      this.trip(now, duration, 'probe failed in half-open');
      return [{ from: 'half_open', to: 'open', event: 'CIRCUIT_OPEN', reason: 'probe failed in half-open' }];
    }
    this.consecutiveFailures += 1;
    this.window.push({ at: now, ok: false });
    this.pruneWindow(now);

    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.trip(now, this.config.openMs, `${this.consecutiveFailures} consecutive failures`);
      return [{ from: 'closed', to: 'open', event: 'CIRCUIT_OPEN', reason: 'consecutive failures' }];
    }
    const total = this.window.length;
    const failures = this.window.filter((entry) => !entry.ok).length;
    if (total >= this.config.minRequests && failures / total >= this.config.failureRateThreshold) {
      this.trip(now, this.config.openMs, `failure rate ${failures}/${total} in window`);
      return [{ from: 'closed', to: 'open', event: 'CIRCUIT_OPEN', reason: 'window failure rate' }];
    }
    return [];
  }

  snapshot(): CircuitSnapshot {
    return {
      circuit: this.circuit,
      consecutiveFailures: this.consecutiveFailures,
      openedUntil: this.openedUntilMs === null ? null : new Date(this.openedUntilMs).toISOString(),
      lastErrorCode: this.lastErrorCode,
      openMs: this.openMs,
    };
  }

  private trip(now: number, durationMs: number, reason: string): void {
    this.circuit = 'open';
    this.openMs = durationMs;
    this.openedUntilMs = now + durationMs;
    this.halfOpenProbeInFlight = false;
    void reason;
  }

  private pruneWindow(now: number): void {
    const cutoff = now - this.config.windowMs;
    this.window = this.window.filter((entry) => entry.at >= cutoff);
  }
}
