/**
 * provider 消费了 token 但结构化输出不可用（空输出 / finish_reason=length 截断 / JSON 解析失败）
 * 时抛出。携带 `usage` 让网关 catch（router-model-gateway）能按真实消耗结算预算，而非静默记 0¢——
 * 否则「reasoning 预算耗尽/截断」这类**花了 token 却失败**的调用会绕过硬预算上界（M1-b fast-follow 改动 2）。
 */
export class ProviderOutputError extends Error {
  readonly usage?: { inputTokens?: number; outputTokens?: number };
  /** Number of provider requests represented by this error (schema repair may be two). */
  readonly callCount: number;

  constructor(
    message: string,
    usage?: { inputTokens?: number; outputTokens?: number },
    opts?: { cause?: unknown; callCount?: number },
  ) {
    super(message, opts);
    this.name = 'ProviderOutputError';
    this.usage = usage;
    this.callCount = opts?.callCount ?? 1;
  }
}
