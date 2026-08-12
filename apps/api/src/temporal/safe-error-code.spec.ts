import { describe, expect, it } from 'vitest';
import { safeTemporalErrorCode } from './safe-error-code';

describe('safe temporal error evidence', () => {
  it('keeps an exact budget marker but never copies arbitrary messages or codes', () => {
    expect(
      safeTemporalErrorCode(
        { name: 'ActivityFailure', cause: { type: 'BudgetExceededError', message: 'buyer@example.com' } },
        'ACQUISITION_ACTIVITY_FAILED',
      ),
    ).toBe('BUDGET_EXCEEDED');
    expect(
      safeTemporalErrorCode(
        { code: 'password=secret', message: 'buyer@example.com' },
        'ACQUISITION_ACTIVITY_FAILED',
      ),
    ).toBe('ACQUISITION_ACTIVITY_FAILED');
  });

  it('bounds hostile getters and cause cycles', () => {
    const error: Record<string, unknown> = { name: 'ActivityFailure' };
    Object.defineProperty(error, 'code', { get: () => { throw new Error('secret'); } });
    error.cause = error;

    expect(() => safeTemporalErrorCode(error, 'ACQUISITION_ACTIVITY_FAILED')).not.toThrow();
    expect(safeTemporalErrorCode(error, 'ACQUISITION_ACTIVITY_FAILED')).toBe('ACQUISITION_ACTIVITY_FAILED');
  });
});
