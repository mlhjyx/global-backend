import { describe, expect, it, vi } from 'vitest';
import { ConflictException, HttpException } from '@nestjs/common';
import { EnrichmentSafetyError } from '../enrichment/safety/enrichment-safety.contract';
import { ExecutionBudgetGrantError } from './execution-budget-authority.types';
import { ExecutionControlError } from './execution-control-error';
import { asContactEnrichmentHttpBoundary, asExecutionBudgetHttpBoundary } from './execution-budget-grant.decorator';

describe('asExecutionBudgetHttpBoundary (F7 safety & control error HTTP mapping)', () => {
  it('maps ExecutionBudgetGrantError using its canonical HTTP status', async () => {
    await expect(
      asExecutionBudgetHttpBoundary(async () => {
        throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_REQUIRED');
      }),
    ).rejects.toMatchObject({
      status: 402,
      response: {
        error: {
          code: 'EXECUTION_BUDGET_GRANT_REQUIRED',
          message: 'EXECUTION_BUDGET_GRANT_REQUIRED',
        },
      },
    });
  });

  it.each([
    ['INVALID_PLAN', 400],
    ['BUDGET_CAP_EXCEEDED', 402],
    ['HOLD', 409],
    ['INPUT_CONFLICT', 409],
    ['REDACTED', 409],
    ['CONTROL_MISMATCH', 409],
    ['GOVERNANCE_PENDING', 503],
  ] as const)('maps EnrichmentSafetyError(%s) to HTTP %s', async (code, expectedStatus) => {
    let caught: unknown;
    try {
      await asContactEnrichmentHttpBoundary(async () => {
        throw new EnrichmentSafetyError(code);
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(expectedStatus);
    expect((caught as HttpException).getResponse()).toEqual({
      error: { code: `ENRICHMENT_${code}`, message: `ENRICHMENT_${code}` },
    });
  });

  it('maps ExecutionControlError to bounded HTTP status without leaking internal details', async () => {
    let caught: unknown;
    try {
      await asContactEnrichmentHttpBoundary(async () => {
        throw new ExecutionControlError('BUDGET_OPERATION_REPLAY_UNAVAILABLE');
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(503);
    expect((caught as HttpException).getResponse()).toEqual({
      error: {
        code: 'BUDGET_OPERATION_REPLAY_UNAVAILABLE',
        message: 'BUDGET_OPERATION_REPLAY_UNAVAILABLE',
      },
    });
  });

  it('passes through HttpException and ordinary domain Errors untouched', async () => {
    const conflict = new ConflictException({ error: { code: 'NO_RUNNABLE_QUERIES', message: 'none' } });
    await expect(
      asExecutionBudgetHttpBoundary(async () => {
        throw conflict;
      }),
    ).rejects.toBe(conflict);

    const ordinary = new Error('unexpected_db_timeout');
    await expect(
      asExecutionBudgetHttpBoundary(async () => {
        throw ordinary;
      }),
    ).rejects.toBe(ordinary);
  });

  it('does not evaluate a cause accessor when preserving an unknown original exception', async () => {
    const error = new Error('synthetic failure');
    const inspect = vi.fn(() => { throw new Error('cause accessor must not run'); });
    Object.defineProperty(error, 'cause', { get: inspect });
    await expect(asContactEnrichmentHttpBoundary(async () => { throw error; })).rejects.toBe(error);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('keeps contact error translation out of other budget-authorized endpoints', async () => {
    const contactError = new EnrichmentSafetyError('HOLD');
    await expect(asExecutionBudgetHttpBoundary(async () => { throw contactError; })).rejects.toBe(contactError);
  });

  it.each([
    ['BUDGET_EXCEEDED', 402],
    ['EXECUTION_BUDGET_SCOPE_MISMATCH', 409],
  ] as const)('maps ExecutionControlError(%s) to HTTP %s', async (code, expectedStatus) => {
    await expect(
      asContactEnrichmentHttpBoundary(async () => {
        throw new ExecutionControlError(code);
      }),
    ).rejects.toMatchObject({ status: expectedStatus });
  });
});
