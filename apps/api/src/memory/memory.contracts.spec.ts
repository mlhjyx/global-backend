import { describe, expect, it } from 'vitest';
import {
  MemoryPayloadError,
  parseLeadsScoredPayload,
  parseRunCompletedPayload,
  readMemoryConsumerConfig,
  readMemorySemanticConfig,
  wilsonInterval,
} from './memory.contracts';

const PLAN_ID = '11111111-1111-4111-8111-111111111111';

function runPayload(overrides: Record<string, unknown> = {}) {
  return {
    planId: PLAN_ID,
    status: 'DONE',
    cost: 1.23,
    costBasis: 'usage_ledger-runid/v1',
    stats: {
      perSource: { searxng: { records: 3 } },
      contacts: 5,
    },
    ...overrides,
  };
}

describe('parseRunCompletedPayload', () => {
  it('keeps the whitelisted aggregate fields', () => {
    const parsed = parseRunCompletedPayload(runPayload());
    expect(parsed.planId).toBe(PLAN_ID);
    expect(parsed.status).toBe('DONE');
    expect(parsed.cost).toBe(1.23);
    expect(parsed.stats).toEqual({
      perSource: { searxng: { records: 3 } },
      contacts: 5,
    });
  });

  it('rejects unknown top-level keys instead of silently dropping them', () => {
    expect(() =>
      parseRunCompletedPayload(runPayload({ contactEmail: 'a@b.c' })),
    ).toThrow(MemoryPayloadError);
  });

  it('rejects person-level keys inside stats', () => {
    expect(() =>
      parseRunCompletedPayload(
        runPayload({ stats: { perSource: { x: { contactEmail: 'a@b.c' } } } }),
      ),
    ).toThrow(/personal-data key/);
  });

  it('allows contact counters but rejects long free text', () => {
    expect(
      parseRunCompletedPayload(runPayload({ stats: { contacts: 12 } })).stats,
    ).toEqual({ contacts: 12 });
    expect(() =>
      parseRunCompletedPayload(
        runPayload({ stats: { note: 'x'.repeat(201) } }),
      ),
    ).toThrow(/string too long/);
  });

  it('rejects invalid plan ids, statuses and negative costs', () => {
    expect(() =>
      parseRunCompletedPayload(runPayload({ planId: 'not-a-uuid' })),
    ).toThrow(/planId/);
    expect(() =>
      parseRunCompletedPayload(runPayload({ status: 'RUNNING' })),
    ).toThrow(/status/);
    expect(() => parseRunCompletedPayload(runPayload({ cost: -1 }))).toThrow(
      /cost/,
    );
  });

  it('accepts an optional taskRef only when both ids are strings', () => {
    expect(
      parseRunCompletedPayload(
        runPayload({ taskRef: { taskId: 't1', taskRunId: 'r1' } }),
      ).taskRef,
    ).toEqual({ taskId: 't1', taskRunId: 'r1' });
    expect(() =>
      parseRunCompletedPayload(runPayload({ taskRef: { taskId: 1 } })),
    ).toThrow(/taskRef/);
  });
});

describe('parseLeadsScoredPayload', () => {
  it('keeps scored and queue counters', () => {
    expect(
      parseLeadsScoredPayload({ scored: 12, queues: { recommended: 3 } }),
    ).toEqual({ scored: 12, queues: { recommended: 3 } });
  });

  it('rejects extra keys and negative or fractional counters', () => {
    expect(() =>
      parseLeadsScoredPayload({ scored: 1, queues: {}, extra: true }),
    ).toThrow(MemoryPayloadError);
    expect(() => parseLeadsScoredPayload({ scored: -1, queues: {} })).toThrow(
      /scored/,
    );
    expect(() =>
      parseLeadsScoredPayload({ scored: 1, queues: { a: 1.5 } }),
    ).toThrow(/queues/);
  });
});

describe('wilsonInterval', () => {
  it('returns the full interval for an empty sample', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it('narrows as the sample grows', () => {
    const small = wilsonInterval(5, 5);
    const large = wilsonInterval(50, 50);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
    expect(large.low).toBeGreaterThan(small.low);
  });

  it('stays inside [0,1] at the boundaries', () => {
    const allSuccess = wilsonInterval(100, 0);
    expect(allSuccess.low).toBeGreaterThan(0.9);
    expect(allSuccess.high).toBeLessThanOrEqual(1);
    expect(wilsonInterval(0, 100).low).toBe(0);
  });
});

describe('memory config readers', () => {
  it('defaults to disabled and clamps out-of-range values', () => {
    expect(readMemoryConsumerConfig({})).toEqual({
      enabled: false,
      pollMs: 60_000,
      lookbackDays: 14,
      batchSize: 100,
    });
    expect(
      readMemoryConsumerConfig({
        MEMORY_LAYER_V0_ENABLED: 'true',
        MEMORY_CONSUMER_POLL_MS: '1',
        MEMORY_CONSUMER_LOOKBACK_DAYS: '999',
        MEMORY_CONSUMER_BATCH_SIZE: '0',
      }),
    ).toEqual({
      enabled: true,
      pollMs: 5_000,
      lookbackDays: 90,
      batchSize: 1,
    });
  });

  it('keeps the brief under the hard 2000-token cap', () => {
    const semantic = readMemorySemanticConfig({
      MEMORY_SEMANTIC_CONSUMPTION_ENABLED: 'true',
      MEMORY_STRATEGY_MIN_N: '12',
      MEMORY_STRATEGY_MAX_CI_WIDTH: '0.1',
      MEMORY_BRIEF_MAX_TOKENS: '9999',
    });
    expect(semantic).toEqual({
      enabled: true,
      minN: 12,
      maxCiWidth: 0.1,
      briefMaxTokens: 2000,
    });
  });
});
