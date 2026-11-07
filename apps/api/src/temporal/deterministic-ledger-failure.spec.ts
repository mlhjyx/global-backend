import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it } from 'vitest';

import {
  BudgetAccountUnavailableError,
  BudgetExceededError,
  BudgetOperationReplayError,
  BudgetStoreUnavailableError,
  BudgetUnsettledOperationsError,
} from '../tools/budget-store';
import {
  ExecutionControlError,
  isExecutionControlError,
} from '../execution-budget/execution-control-error';
import { ExecutionBudgetGrantError } from '../execution-budget/execution-budget-authority.types';
import { ToolDurableResultProjectionError } from '../tools/tool-broker';
import { ModelDurableResultProjectionError } from '../model-gateway/router-model-gateway';
import {
  classifyDeterministicLedgerFailure,
  toNonRetryableFailure,
} from './deterministic-ledger-failure';

/**
 * B2（审计 F5）：「同一 operation_key 二次 reserve 必撞同一行」这类确定性账本错误在活动
 * 边界必须 nonRetryable——否则 Temporal 会烧光重试预算（本周 run 空转 95 分钟的根因）。
 * 存储/平台瞬时故障（*_UNAVAILABLE）与 provider 429/5xx 保持可重试。
 */
describe('确定性账本/控制错误分类（B2）', () => {
  it.each([
    ['replay（remnant）', new BudgetOperationReplayError('op-1', 'remnant')],
    ['预算耗尽', new BudgetExceededError('acct', 10n, 0n)],
    ['账户不可用', new BudgetAccountUnavailableError('acct')],
    ['存在未结操作', new BudgetUnsettledOperationsError('acct')],
    ['工具投影拒绝', new ToolDurableResultProjectionError('op-1')],
    ['模型投影拒绝', new ModelDurableResultProjectionError('op-1')],
    ['确定性控制错误（INVALID）', new ExecutionControlError('DURABLE_EXECUTION_RECEIPT_FACTS_INVALID')],
    ['确定性控制错误（MISMATCH）', new ExecutionControlError('DOMAIN_ACK_RECEIPT_BINDING_MISMATCH')],
    ['确定性控制错误（MIXED）', new ExecutionControlError('DOMAIN_ACK_MIXED_REPLAY_STATE')],
    ['确定性控制错误（EXHAUSTED）', new ExecutionControlError('EXECUTION_BUDGET_EXHAUSTED')],
    ['确定性控制错误（REQUIRED）', new ExecutionControlError('DURABLE_EXECUTION_RECEIPT_FACTS_REQUIRED')],
    ['确定性控制错误（REVOKED）', new ExecutionControlError('EXECUTION_BUDGET_AUTHORITY_REVOKED')],
    // 生产上 Grant 被拒以 ExecutionBudgetGrantError 抛出（platform-grant-admission 自注不可重试）。
    ['Grant 过期', new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_EXPIRED')],
    ['Grant 重复使用', new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_REUSED')],
    ['Grant 作用域不符', new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH')],
  ])('%s → nonRetryable', (_label, error) => {
    const failure = classifyDeterministicLedgerFailure(error);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure?.nonRetryable).toBe(true);
    expect(failure?.type).toBe(error.name === 'Error' ? 'ExecutionControlError' : error.name);
  });

  it.each([
    // live：本次尝试的物理调用已发生、结果未存证。重试会读到已结清行或吸收 remnant
    //（#642 的恢复设计），因此必须保持可重试。
    ['replay（live）', new BudgetOperationReplayError('op-1', 'live')],
    ['预算存储不可用', new BudgetStoreUnavailableError()],
    ['验证服务不可用', new ExecutionControlError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE')],
    ['Grant 验证服务不可用', new ExecutionBudgetGrantError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE')],
    ['平台围栏不可用', new ExecutionControlError('PLATFORM_EGRESS_FENCE_UNAVAILABLE')],
    ['事务上下文不可用', new ExecutionControlError('DOMAIN_ACK_PLATFORM_TRANSACTION_UNAVAILABLE')],
    // `_UNAVAILABLE` 优先排除：即使码形同时命中确定性规则（_MIXED_/后缀），瞬时故障保持可重试。
    ['混合形态但不可用', new ExecutionControlError('DOMAIN_ACK_MIXED_RECEIPT_UNAVAILABLE')],
    ['普通错误', new Error('socket hang up')],
    ['非错误值', 'boom'],
  ])('%s → 保持可重试（不转换）', (_label, error) => {
    expect(classifyDeterministicLedgerFailure(error)).toBeNull();
  });

  it('沿 cause 链识别被包装的确定性错误，并保留外层 type', () => {
    const wrapped = Object.assign(new Error('activity wrapper'), {
      cause: new BudgetOperationReplayError('op-1', 'remnant'),
    });
    const failure = classifyDeterministicLedgerFailure(wrapped);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure?.nonRetryable).toBe(true);
    expect(failure?.type).toBe('Error');
  });

  it('转换保留控制错误语义：isExecutionControlError 判定不因包装而翻转', () => {
    const control = new ExecutionControlError('DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH');
    expect(isExecutionControlError(control)).toBe(true);
    const converted = toNonRetryableFailure(control);
    expect(isExecutionControlError(converted)).toBe(true);
    // 投影拒绝不是控制错误：转换后仍不是（调用方按 definite failure 处理）。
    const projection = new ToolDurableResultProjectionError('op-1');
    expect(isExecutionControlError(projection)).toBe(false);
    expect(isExecutionControlError(toNonRetryableFailure(projection))).toBe(false);
  });
});
