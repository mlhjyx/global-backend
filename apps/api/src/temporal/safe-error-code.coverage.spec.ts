import { describe, expect, it } from 'vitest';
import {
  appendSafeErrorCode,
  sanitizeTemporalResultReason,
  safeErrorCodeList,
  safeErrorCodeSequence,
  safeTemporalErrorCode,
} from './safe-error-code';

const SENSITIVE_ERROR =
  'Fiona Buyer <fiona@example.com> https://private.example/error password=secret';

describe('safe temporal error evidence', () => {
  it('只读取 allowlisted marker，忽略 message/stack/任意 code', () => {
    const error = {
      name: 'Error',
      code: 'FIONA_SECRET_TOKEN',
      message: SENSITIVE_ERROR,
      stack: SENSITIVE_ERROR,
    };

    const code = safeTemporalErrorCode(error, 'DISCOVERY_QUERY_FAILED');

    expect(code).toBe('DISCOVERY_QUERY_FAILED');
    expect(code).not.toContain('FIONA');
  });

  it('有界读取嵌套 Temporal cause 并保留 BudgetExceeded 语义', () => {
    const error = {
      name: 'ActivityFailure',
      message: SENSITIVE_ERROR,
      cause: {
        name: 'ApplicationFailure',
        type: 'BudgetExceededError',
        message: SENSITIVE_ERROR,
      },
    };

    expect(safeTemporalErrorCode(error, 'EXTERNAL_SIGNAL_INGEST_FAILED')).toBe(
      'BUDGET_EXCEEDED',
    );
  });

  it('未知 sequence token 以 fallback 替代，safe token 去重且不复制原文', () => {
    const sequence = safeErrorCodeSequence(
      `CPV_RESOLUTION_FAILED;${SENSITIVE_ERROR};CPV_RESOLUTION_FAILED`,
      'EXTERNAL_TARGET_RESOLUTION_FAILED',
    );
    const list = safeErrorCodeList(
      [sequence, 'budget_exceeded', SENSITIVE_ERROR],
      'EXTERNAL_SIGNAL_INGEST_FAILED',
    );

    expect(sequence).toBe(
      'CPV_RESOLUTION_FAILED;EXTERNAL_TARGET_RESOLUTION_FAILED',
    );
    expect(list).toEqual([
      'CPV_RESOLUTION_FAILED',
      'EXTERNAL_TARGET_RESOLUTION_FAILED',
      'BUDGET_EXCEEDED',
      'EXTERNAL_SIGNAL_INGEST_FAILED',
    ]);
    expect(JSON.stringify({ sequence, list })).not.toContain(SENSITIVE_ERROR);
  });

  it('恶意 getter 或 cause cycle 不能使 sanitizer 抛错或读取 message', () => {
    const error: Record<string, unknown> = { name: 'ActivityFailure' };
    Object.defineProperty(error, 'code', {
      get: () => {
        throw new Error(SENSITIVE_ERROR);
      },
    });
    error.cause = error;

    expect(() =>
      safeTemporalErrorCode(error, 'ACQUISITION_SOURCE_FAILED'),
    ).not.toThrow();
    expect(safeTemporalErrorCode(error, 'ACQUISITION_SOURCE_FAILED')).toBe(
      'ACQUISITION_SOURCE_FAILED',
    );
    expect(appendSafeErrorCode(SENSITIVE_ERROR, 'TED_PROJECTION_FAILED')).toBe(
      'TED_PROJECTION_FAILED',
    );
  });

  it('handles primitive errors, direct safe markers and a bounded over-deep cause chain', () => {
    expect(safeTemporalErrorCode('BUDGET_EXCEEDED', 'DISCOVERY_QUERY_FAILED')).toBe(
      'DISCOVERY_QUERY_FAILED',
    );
    expect(safeTemporalErrorCode({ code: 'BUDGET_EXCEEDED' }, 'DISCOVERY_QUERY_FAILED')).toBe(
      'BUDGET_EXCEEDED',
    );
    expect(safeTemporalErrorCode({ type: 'TED_PROJECTION_FAILED' }, 'DISCOVERY_QUERY_FAILED')).toBe(
      'TED_PROJECTION_FAILED',
    );
    const deep = { cause: { cause: { cause: { cause: { cause: { code: 'BUDGET_EXCEEDED' } } } } } };
    expect(safeTemporalErrorCode(deep, 'DISCOVERY_QUERY_FAILED')).toBe('DISCOVERY_QUERY_FAILED');
  });

  it('normalizes empty sequences, append dedupe and closed result reasons', () => {
    expect(safeErrorCodeSequence(undefined, 'DISCOVERY_QUERY_FAILED')).toBe('DISCOVERY_QUERY_FAILED');
    expect(safeErrorCodeSequence('', 'DISCOVERY_QUERY_FAILED')).toBe('DISCOVERY_QUERY_FAILED');
    expect(appendSafeErrorCode(undefined, 'TED_PROJECTION_FAILED')).toBe('TED_PROJECTION_FAILED');
    expect(appendSafeErrorCode('TED_PROJECTION_FAILED', 'TED_PROJECTION_FAILED')).toBe('TED_PROJECTION_FAILED');
    expect(safeErrorCodeList([], 'DISCOVERY_QUERY_FAILED')).toEqual([]);

    const done = { status: 'DONE' as const, reason: SENSITIVE_ERROR, count: 1 };
    const skipped = { status: 'SKIPPED' as const, reason: SENSITIVE_ERROR };
    const failed = { status: 'FAILED' as const, reason: SENSITIVE_ERROR };
    const noReason = { status: 'DONE' as const, count: 2 };
    const codes = { failed: 'ACQUISITION_ACTIVITY_FAILED' as const, skipped: 'ACQUISITION_SOURCE_SKIPPED' as const };
    expect(sanitizeTemporalResultReason(done, codes)).toEqual({ status: 'DONE', count: 1 });
    expect(sanitizeTemporalResultReason(skipped, codes)).toEqual({
      status: 'SKIPPED',
      reason: 'ACQUISITION_SOURCE_SKIPPED',
    });
    expect(sanitizeTemporalResultReason(failed, codes)).toEqual({
      status: 'FAILED',
      reason: 'ACQUISITION_ACTIVITY_FAILED',
    });
    expect(sanitizeTemporalResultReason(noReason, codes)).toBe(noReason);
  });
});
