/**
 * provider 消费了 token 但结构化输出不可用（空输出 / finish_reason=length 截断 / JSON 解析失败）
 * 时抛出。携带 `usage` 让网关 catch（router-model-gateway）能按真实消耗结算预算，而非静默记 0¢——
 * 否则「reasoning 预算耗尽/截断」这类**花了 token 却失败**的调用会绕过硬预算上界（M1-b fast-follow 改动 2）。
 */
export class ProviderOutputError extends Error {
  readonly usage?: { inputTokens?: number; outputTokens?: number };
  /** Number of provider requests represented by this error (schema repair may be two). */
  readonly callCount: number;
  readonly provider?: string;
  readonly model?: string;
  readonly reportedModel?: string;
  readonly modelResolutionSource?: ModelResolutionSource;

  constructor(
    message: string,
    usage?: { inputTokens?: number; outputTokens?: number },
    opts?: { cause?: unknown; callCount?: number } & ProviderErrorProvenance,
  ) {
    super(message, opts);
    this.name = 'ProviderOutputError';
    this.usage = usage;
    this.callCount = opts?.callCount ?? 1;
    this.provider = opts?.provider;
    this.model = opts?.model;
    this.reportedModel = opts?.reportedModel;
    this.modelResolutionSource = opts?.modelResolutionSource;
  }
}

/**
 * A provider returned a schema-valid artifact, but the caller's deterministic
 * business gate rejected it. Unlike a provider-format failure, retrying another
 * provider (especially the dev stub) cannot make that same model attempt valid;
 * the error must return to the AiTask model fallback loop after trace/settle.
 */
export class TaskOutputValidationError extends ProviderOutputError {
  constructor(
    message: string,
    usage?: { inputTokens?: number; outputTokens?: number },
    opts?: { cause?: unknown; callCount?: number } & ProviderErrorProvenance,
  ) {
    super(message, usage, opts);
    this.name = 'TaskOutputValidationError';
  }
}
import type { ModelResolutionSource } from '../types';

export interface ProviderErrorProvenance {
  provider?: string;
  model?: string;
  reportedModel?: string;
  modelResolutionSource?: ModelResolutionSource;
}
