/**
 * 限流：全局令牌桶（每工具 rps/concurrency）+ 每域串行延迟（对齐 source_policy）。
 * 保护自托管实例（SearXNG/Crawl4AI）与公共 API（Overpass/crt.sh）。进程内实现。
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
  rps: number;
  running: number;
  concurrency: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly lastDomainHit = new Map<string, number>();

  configure(toolId: string, rps: number, concurrency: number): void {
    if (!this.buckets.has(toolId)) {
      this.buckets.set(toolId, { tokens: rps, lastRefill: 0, rps, running: 0, concurrency });
    }
  }

  /** 获取一个许可（受 rps + concurrency 限制）。返回释放函数。 */
  async acquire(toolId: string, nowMs: number): Promise<() => void> {
    const b = this.buckets.get(toolId);
    if (!b) return () => {};
    // 简化的令牌补充（按经过时间）；nowMs 由调用方传入（避免 Date.now 在受限环境）
    for (let attempt = 0; attempt < 1000; attempt++) {
      this.refill(b, nowMs + attempt * 50);
      if (b.tokens >= 1 && b.running < b.concurrency) {
        b.tokens -= 1;
        b.running += 1;
        return () => {
          b.running = Math.max(0, b.running - 1);
        };
      }
      await sleep(50);
    }
    // 兜底：放行但计数（避免死锁）
    b.running += 1;
    return () => {
      b.running = Math.max(0, b.running - 1);
    };
  }

  /** 每域串行延迟：同一域名两次抓取间至少 delayMs。 */
  async respectDomainDelay(domain: string, delayMs: number, nowMs: number): Promise<void> {
    if (!delayMs) return;
    const last = this.lastDomainHit.get(domain) ?? 0;
    const wait = last + delayMs - nowMs;
    if (wait > 0) await sleep(wait);
    this.lastDomainHit.set(domain, nowMs + Math.max(0, wait));
  }

  private refill(b: Bucket, nowMs: number): void {
    if (!b.lastRefill) {
      b.lastRefill = nowMs;
      return;
    }
    const elapsed = (nowMs - b.lastRefill) / 1000;
    if (elapsed > 0) {
      b.tokens = Math.min(b.rps, b.tokens + elapsed * b.rps);
      b.lastRefill = nowMs;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

export const rateLimiter = new RateLimiter();
