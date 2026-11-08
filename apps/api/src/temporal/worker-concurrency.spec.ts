import { describe, expect, it } from 'vitest';
import {
  WORKER_CONCURRENCY_DEFAULTS,
  workerConcurrencyOptions,
  workerConcurrencyValue,
} from './worker-concurrency';

/**
 * ch08 §3.1.6：worker 并发必须显式（默认 100 会在 2 vCPU 主机上打满连接池）。
 * 值来自 env，非法值启动即失败，缺省用保守默认。
 */

describe('workerConcurrencyOptions', () => {
  it('defaults to 12/8/4 when env is unset', () => {
    expect(workerConcurrencyOptions({})).toEqual({
      maxConcurrentActivityTaskExecutions: WORKER_CONCURRENCY_DEFAULTS.activity,
      maxConcurrentWorkflowTaskExecutions: WORKER_CONCURRENCY_DEFAULTS.workflow,
      maxConcurrentLocalActivityExecutions: WORKER_CONCURRENCY_DEFAULTS.local,
    });
    expect(WORKER_CONCURRENCY_DEFAULTS.activity).toBe(12);
  });

  it('reads values from env', () => {
    expect(
      workerConcurrencyOptions({
        WORKER_MAX_CONCURRENT_ACTIVITY: '6',
        WORKER_MAX_CONCURRENT_WORKFLOW: '4',
        WORKER_MAX_CONCURRENT_LOCAL: '2',
      }),
    ).toEqual({
      maxConcurrentActivityTaskExecutions: 6,
      maxConcurrentWorkflowTaskExecutions: 4,
      maxConcurrentLocalActivityExecutions: 2,
    });
  });

  it('treats blank values as unset', () => {
    expect(workerConcurrencyValue({ X: '  ' }, 'X', 12)).toBe(12);
    expect(workerConcurrencyValue({}, 'X', 12)).toBe(12);
  });

  it('fails fast on non-integer, zero, negative or oversized values', () => {
    for (const bad of ['abc', '0', '-3', '1.5', '101']) {
      expect(() => workerConcurrencyValue({ X: bad }, 'X', 12)).toThrowError(
        'WORKER_CONCURRENCY_INVALID:X',
      );
    }
  });
});
