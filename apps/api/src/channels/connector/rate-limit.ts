/**
 * 渠道级限速（章节 §6.3.5）：令牌桶（rps/burst）+ 每域延迟（perDomainDelayMs）。
 * 与 ToolBroker 的全局工具级限流两层取严；本模块只管 manifest 声明的渠道级配额，
 * 不把渠道配置写进全局工具配置。
 */

export const DEFAULT_RPS = 0.5;
export const DEFAULT_BURST = 2;
export const DEFAULT_PER_DOMAIN_DELAY_MS = 2000;

export interface ChannelRateConfig {
  readonly rps?: number;
  readonly burst?: number;
  readonly perDomainDelayMs?: number;
}

/**
 * 令牌桶：纯计算「这次请求要等多久」；实际 sleep 由调用方执行（可注入假时钟测试）。
 */
export class ChannelTokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  private readonly rps: number;
  private readonly burst: number;

  constructor(config: ChannelRateConfig, now: () => number = Date.now) {
    this.rps = clamp(config.rps ?? DEFAULT_RPS, 0.05, 50);
    this.burst = Math.max(1, Math.min(100, Math.trunc(config.burst ?? DEFAULT_BURST)));
    this.tokens = this.burst;
    this.lastRefillMs = now();
  }

  /** 返回需要等待的毫秒数（0 表示可立即发）；调用方等待后应再调用 commit。 */
  acquire(nowMs: number): number {
    const elapsed = Math.max(0, nowMs - this.lastRefillMs);
    this.tokens = Math.min(this.burst, this.tokens + (elapsed / 1000) * this.rps);
    this.lastRefillMs = nowMs;
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.rps) * 1000);
  }

  commit(): void {
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function perDomainDelayMs(config: ChannelRateConfig): number {
  return clamp(config.perDomainDelayMs ?? DEFAULT_PER_DOMAIN_DELAY_MS, 0, 60_000);
}
