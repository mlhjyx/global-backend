// 确定性账本/控制错误的非重试分类（B2，审计 F4/F5，2026-11-08）。
//
// Temporal 活动默认按重试策略重跑，但「同一 operation_key 再次 reserve 必撞同一行」这类
// 错误是**确定性**的：重试只会立刻再撞同一行，或把整段 15–30 分钟活动从头再跑一遍
// （2026-11-07 run 7662d391 空转 95 分钟的根因）。活动边界把它们统一转成 nonRetryable，
// 失败的 run 交给 B3 看门狗收尾、孤儿预留交给 B4 清收器——而不是让 Temporal 重试预算去撞墙。
//
// 白名单宁窄勿宽：任何 `*_UNAVAILABLE`（存储/平台瞬时故障）保持可重试；provider 429/5xx
// 的等待重试逻辑（upstream-unavailable-retry）不受影响。分类只发生在活动边界，域内捕获
// （例如联系人发现吸收 remnant）语义不变。
import { ApplicationFailure } from '@temporalio/activity';

import {
  BudgetAccountUnavailableError,
  BudgetExceededError,
  BudgetOperationReplayError,
  BudgetUnsettledOperationsError,
} from '../tools/budget-store';
import { ExecutionBudgetGrantError } from '../execution-budget/execution-budget-authority.types';
import { ExecutionControlError } from '../execution-budget/execution-control-error';
import { ToolDurableResultProjectionError } from '../tools/tool-broker';
import { ModelDurableResultProjectionError } from '../model-gateway/router-model-gateway';

const MAX_CAUSE_DEPTH = 8;

/**
 * ExecutionControlError 的确定性码形态：同一输入必然同一判定，重试无意义。
 * 顺序有意义：先排除 `*_UNAVAILABLE`（瞬时故障），再匹配确定性形态。
 */
const DETERMINISTIC_CODE_SUFFIXES = Object.freeze([
  '_INVALID',
  '_MISMATCH',
  '_REQUIRED',
  '_REUSED',
  '_REVOKED',
  '_EXHAUSTED',
  '_EXPIRED',
] as const);
const DETERMINISTIC_CODE_INFIXES = Object.freeze(['_MIXED_'] as const);

function isDeterministicControlCode(code: string): boolean {
  if (code.endsWith('_UNAVAILABLE')) return false;
  return (
    DETERMINISTIC_CODE_SUFFIXES.some((suffix) => code.endsWith(suffix)) ||
    DETERMINISTIC_CODE_INFIXES.some((infix) => code.includes(infix))
  );
}

function classifies(error: object): boolean {
  // replay 错误只在 remnant 时是确定性的：重试必然再撞同一行。origin='live' 表示
  // 本次尝试的物理调用已发生而结果未能存证——按 #642 的设计，让 Temporal 重试一次，
  // 重试会读到已结清行（含投影则直接复用结果）或把 remnant 吸收掉，整段活动得以续跑。
  if (error instanceof BudgetOperationReplayError) {
    return error.origin === 'remnant';
  }
  if (
    error instanceof BudgetExceededError ||
    error instanceof BudgetAccountUnavailableError ||
    error instanceof BudgetUnsettledOperationsError ||
    error instanceof ToolDurableResultProjectionError ||
    error instanceof ModelDurableResultProjectionError
  ) {
    return true;
  }
  // 授权 Grant 被拒（过期/作用域不符/已用/撤销/耗尽）是确定性判定；唯一瞬时的
  // EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE 以 _UNAVAILABLE 结尾、保持可重试。
  if (error instanceof ExecutionBudgetGrantError) {
    return !error.code.endsWith('_UNAVAILABLE');
  }
  if (error instanceof ExecutionControlError) {
    return isDeterministicControlCode(error.code);
  }
  return false;
}

/**
 * 命中确定性账本/控制错误时返回 nonRetryable 的 ApplicationFailure（保留 type/code，
 * 供 workflow 的 isExecutionControlError 继续按原语义分类），否则返回 null。
 * 沿 cause 链识别被包装的错误；转换作用在最外层错误上。
 */
export function classifyDeterministicLedgerFailure(error: unknown): ApplicationFailure | null {
  if (!error || typeof error !== 'object') return null;
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== 'object' || seen.has(current)) return null;
    seen.add(current);
    if (classifies(current)) {
      // 已经是 nonRetryable 就不再包一层。
      if (current instanceof ApplicationFailure && current.nonRetryable) return null;
      return toNonRetryableFailure(error);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** 把错误转成 nonRetryable 的 ApplicationFailure；type 继承 error.name，cause 链保留。 */
export function toNonRetryableFailure(error: unknown): ApplicationFailure {
  return ApplicationFailure.fromError(error, { nonRetryable: true });
}
