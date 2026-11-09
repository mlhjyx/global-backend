/**
 * P3 J02 W2：把 pipeline 活动抛出的异常在**活动边界**换成带稳定 failure code 的
 * `ApplicationFailure`。
 *
 * 为什么必须在边界做：worker 的 `DiagnosticFailureConverter`
 *（`temporal/diagnostic-failure-converter.ts`）出站时会把普通 Error 的类名与消息
 * 全部脱敏（非控制面 → `Temporal execution failed`；控制面 → `EXECUTIONCONTROLERROR`），
 * 只有 `ApplicationFailure.type` 能穿过转换器到达 workflow。因此分类必须发生在
 * 原始错误对象还完整的活动侧；workflow 侧的 `classifyPipelineFailure` 负责把
 * `type=<failure code>` 与历史形状（控制面哨兵、Temporal 超时等）归一回版本化码。
 *
 * 重试语义（J02 不改）：包出来的 ApplicationFailure 一律 `retryable`，
 * 与现状（普通 Error 按 RetryPolicy 重试）一致；按码收紧/放开的
 * `nonRetryableErrorTypes` 矩阵属于 J22。
 */
import { ApplicationFailure } from '@temporalio/activity';
import { classifyPipelineFailure } from './pipeline-failure-taxonomy';

const MAX_PROTOTYPE_DEPTH = 8;

function errorName(error: object): string | undefined {
  try {
    let current: object | null = error;
    for (let depth = 0; current && depth <= MAX_PROTOTYPE_DEPTH; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, 'name');
      if (descriptor) {
        return 'value' in descriptor && typeof descriptor.value === 'string'
          ? descriptor.value
          : undefined;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    /* 敌意对象：按无类名处理。 */
  }
  return undefined;
}

/**
 * 返回应抛出的错误：可分类的异常 → `ApplicationFailure(type=<failure code>)`；
 * 取消/已带类型的 ApplicationFailure 原样返回（保留取消与控制面语义）。
 */
export function toClassifiedActivityFailure(error: unknown): unknown {
  if (!error || typeof error !== 'object') return error;
  const name = errorName(error);
  if (name === 'CancelledFailure') return error;
  // 已是 ApplicationFailure（如 EXECUTION_BUDGET_LEGACY_HISTORY_PARKED，nonRetryable）
  // 时保留原 type 与重试标记；workflow 分类器认得这些 token。
  if (name === 'ApplicationFailure') return error;
  const failure = classifyPipelineFailure(error);
  return ApplicationFailure.retryable(failure.code, failure.code);
}

/** 活动包装器：失败时抛出可穿过 Temporal 边界、带稳定 type 的 ApplicationFailure。 */
export function withClassifiedFailure<Args extends unknown[], Result>(
  activity: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args: Args): Promise<Result> => {
    try {
      return await activity(...args);
    } catch (error) {
      throw toClassifiedActivityFailure(error);
    }
  };
}
