/**
 * 退避与重试（章节 §6.3.5，AWS Builders' Library 原则）：
 * 只重试瞬时错误（429/5xx/超时/网络），有尝试上限（3 次）、累计等待上限（60s）、
 * 指数退避 + 抖动；429 优先 Retry-After（秒或 HTTP date）。不叠加多层重试。
 */

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly totalWaitCapMs: number;
  readonly respectRetryAfter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  totalWaitCapMs: 60_000,
  respectRetryAfter: true,
});

export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function parseRetryAfterMs(value: string | undefined, nowMs: number): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d{1,6}$/u.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

export interface BackoffOptions {
  readonly random?: () => number;
  readonly baseMs?: number;
  readonly capMs?: number;
}

export function backoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? 1000;
  const cap = options.capMs ?? 30_000;
  const exponential = Math.min(base * 2 ** Math.max(0, attempt - 1), cap);
  const jitter = Math.floor((options.random ?? Math.random)() * 250);
  return exponential + jitter;
}

export interface RunWithRetriesOptions<T> {
  readonly policy?: RetryPolicy;
  readonly isRetryable: (result: T) => boolean;
  readonly retryAfterOf?: (result: T) => number | null;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}

/**
 * 对「结果」做有界重试；抛出的异常由调用方先转成结果再进入。
 * 等待预算耗尽后返回最后一次结果（由调用方按失败分类）。
 */
export async function runWithRetries<T>(
  run: (attempt: number) => Promise<T>,
  options: RunWithRetriesOptions<T>,
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const now = options.now ?? Date.now;
  let waitedMs = 0;
  let last: T | null = null;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    last = await run(attempt);
    if (!options.isRetryable(last) || attempt === policy.maxAttempts) return last;
    const retryAfter = options.retryAfterOf?.(last) ?? null;
    // Retry-After 超过 30s 视为「上游要求长时间退避」：不硬等，按指数退避 + 等待预算处理。
    const delay =
      policy.respectRetryAfter && retryAfter !== null && retryAfterTrustworthy(retryAfter)
        ? retryAfter
        : backoffDelayMs(attempt, { random: options.random });
    if (waitedMs + delay > policy.totalWaitCapMs) return last;
    waitedMs += delay;
    await options.sleep(delay);
    void now;
  }
  return last as T;
}

function retryAfterTrustworthy(delayMs: number): boolean {
  return Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= 30_000;
}
