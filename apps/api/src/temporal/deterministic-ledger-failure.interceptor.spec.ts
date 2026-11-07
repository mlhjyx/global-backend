import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it, vi } from 'vitest';

import { BudgetOperationReplayError, BudgetStoreUnavailableError } from '../tools/budget-store';
import { DeterministicLedgerFailureInterceptor } from './deterministic-ledger-failure.interceptor';

function run(next: (...args: never[]) => Promise<unknown>) {
  const interceptor = new DeterministicLedgerFailureInterceptor();
  return interceptor.execute({} as never, next as never);
}

/**
 * B2（审计 F5）：replay 类确定性错误在活动边界只尝试 1 次（nonRetryable），
 * 存储不可用等瞬时故障保持可重试（原样抛出）。
 */
describe('DeterministicLedgerFailureInterceptor', () => {
  it('原样返回成功结果', async () => {
    await expect(run(async () => 'ok')).resolves.toBe('ok');
  });

  it('replay 错误 → nonRetryable ApplicationFailure（只尝试 1 次的语义）', async () => {
    const replay = new BudgetOperationReplayError('op-1', 'remnant');
    const failure = await run(async () => {
      throw replay;
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect((failure as ApplicationFailure).nonRetryable).toBe(true);
    expect((failure as ApplicationFailure).type).toBe('BudgetOperationReplayError');
  });

  it('存储不可用错误原样透传（保持可重试）', async () => {
    const unavailable = new BudgetStoreUnavailableError();
    const failure = await run(async () => {
      throw unavailable;
    }).catch((error: unknown) => error);

    expect(failure).toBe(unavailable);
  });

  it('普通错误原样透传', async () => {
    const plain = new Error('socket hang up');
    const failure = await run(async () => {
      throw plain;
    }).catch((error: unknown) => error);

    expect(failure).toBe(plain);
  });

  it('记录到的 cause 链命中同样转换（被包装的 replay 错误）', async () => {
    const wrapped = Object.assign(new Error('activity wrapper'), {
      cause: new BudgetOperationReplayError('op-1', 'live'),
    });
    const failure = await run(async () => {
      throw wrapped;
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect((failure as ApplicationFailure).nonRetryable).toBe(true);
  });

  it('活动正常结束时拦截器不干预返回值', async () => {
    const spy = vi.fn(async () => ({ value: 1 }));
    await expect(run(spy)).resolves.toEqual({ value: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
