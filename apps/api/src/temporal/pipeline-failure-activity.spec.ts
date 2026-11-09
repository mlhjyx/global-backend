import { describe, expect, it } from 'vitest';
import {
  ApplicationFailure,
  CancelledFailure,
  TimeoutFailure,
} from '@temporalio/common';

import { ProviderHttpError } from '../model-gateway/providers/provider-output-error';
import { BudgetStoreUnavailableError } from '../tools/budget-store';
import { toClassifiedActivityFailure, withClassifiedFailure } from './pipeline-failure-activity';

function applicationType(error: unknown): string | undefined {
  return error instanceof ApplicationFailure ? error.type : undefined;
}

describe('toClassifiedActivityFailure（P3 J02 W2：活动边界打类型化失败码）', () => {
  it('可分类异常 → ApplicationFailure(type=<failure code>)，穿过 DiagnosticFailureConverter 的只有 type', () => {
    const wrapped = toClassifiedActivityFailure(
      new ProviderHttpError({ status: 429, provider: 'p', model: 'm' }),
    );
    expect(wrapped).toBeInstanceOf(ApplicationFailure);
    expect(applicationType(wrapped)).toBe('PROVIDER_HTTP_429');

    const budget = toClassifiedActivityFailure(new BudgetStoreUnavailableError());
    expect(applicationType(budget)).toBe('BUDGET_AUTHORITY_NOT_READY');
  });

  it('未知异常也打 UNKNOWN_UPSTREAM，不静默吞掉', () => {
    expect(applicationType(toClassifiedActivityFailure(new Error('adapter exploded')))).toBe(
      'UNKNOWN_UPSTREAM',
    );
  });

  it('取消原样抛出（保持 Temporal 取消语义）', () => {
    const cancelled = new CancelledFailure('cancelled');
    expect(toClassifiedActivityFailure(cancelled)).toBe(cancelled);
  });

  it('已是 ApplicationFailure 的失败保留原 type 与 nonRetryable（如预算历史 parked）', () => {
    const parked = ApplicationFailure.nonRetryable(
      'EXECUTION_BUDGET_LEGACY_HISTORY_PARKED',
      'EXECUTION_BUDGET_LEGACY_HISTORY_PARKED',
    );
    expect(toClassifiedActivityFailure(parked)).toBe(parked);
  });

  it('包装器只在失败时改写错误，成功结果原样返回', async () => {
    const ok = withClassifiedFailure(async (value: number) => value * 2);
    await expect(ok(21)).resolves.toBe(42);

    const failing = withClassifiedFailure(async () => {
      throw new TimeoutFailure('activity timed out', undefined, 'START_TO_CLOSE');
    });
    await expect(failing()).rejects.toMatchObject({ type: 'PROVIDER_TIMEOUT' });
  });
});
