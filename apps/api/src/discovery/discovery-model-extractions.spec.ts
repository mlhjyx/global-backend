import { describe, expect, it } from 'vitest';
import {
  EMPTY_RUN_MODEL_EXTRACTIONS,
  MODEL_CALL_FAILED,
  addQueryModelExtractions,
  sumModelExtractions,
  tallyModelExtractions,
} from './discovery-model-extractions';

describe('model extractions a discovery query made and dropped', () => {
  it('tallies one provider: every call once, every dropped call by its reason', () => {
    expect(tallyModelExtractions([
      {},
      { failureReason: 'STRUCTURED_OUTPUT_EMPTY_TRUNCATED' },
      {},
      { failureReason: 'STRUCTURED_OUTPUT_EMPTY_TRUNCATED' },
      { failureReason: MODEL_CALL_FAILED },
    ])).toEqual({
      invoked: 5,
      failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 2, MODEL_CALL_FAILED: 1 },
    });
    expect(tallyModelExtractions([])).toEqual({ invoked: 0, failedByReason: {} });
  });

  it.each(['__proto__', 'constructor', 'free text from a model', 'lower_case', 'X', ''])(
    'files a reason that is not a gateway reason code (%j) under MODEL_CALL_FAILED',
    (failureReason) => {
      const tally = tallyModelExtractions([{ failureReason }]);
      expect(tally).toEqual({ invoked: 1, failedByReason: { MODEL_CALL_FAILED: 1 } });
      expect(Object.getPrototypeOf(tally.failedByReason)).toBe(Object.prototype);
    },
  );

  it('sums the providers of one query and stays absent when none made a model call', () => {
    expect(sumModelExtractions([
      { invoked: 3, failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 1 } },
      undefined,
      { invoked: 2, failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 1, MODEL_CALL_FAILED: 1 } },
    ])).toEqual({
      invoked: 5,
      failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 2, MODEL_CALL_FAILED: 1 },
    });
    expect(sumModelExtractions([undefined, { invoked: 0, failedByReason: {} }])).toBeUndefined();
    expect(sumModelExtractions([])).toBeUndefined();
  });

  it('adds each query to the run total without changing the previous total', () => {
    const first = addQueryModelExtractions(EMPTY_RUN_MODEL_EXTRACTIONS, {
      invoked: 10,
      failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 1 },
    });
    const second = addQueryModelExtractions(first, {
      invoked: 2,
      failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 1, MODEL_CALL_FAILED: 1 },
    });

    expect(first).toEqual({
      invoked: 10,
      failed: 1,
      failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 1 },
      queriesAllFailed: 0,
    });
    // The second query lost every call it made: the strongest sign of a model outage.
    expect(second).toEqual({
      invoked: 12,
      failed: 3,
      failedByReason: { STRUCTURED_OUTPUT_EMPTY_TRUNCATED: 2, MODEL_CALL_FAILED: 1 },
      queriesAllFailed: 1,
    });
    expect(EMPTY_RUN_MODEL_EXTRACTIONS).toEqual({
      invoked: 0,
      failed: 0,
      failedByReason: {},
      queriesAllFailed: 0,
    });
  });

  it.each([
    ['an activity result recorded before the counter existed', undefined],
    ['a query without a model call', { invoked: 0, failedByReason: {} }],
    ['a negative count', { invoked: -1, failedByReason: {} }],
    ['a fractional count', { invoked: 1.5, failedByReason: {} }],
    ['more failures than calls', { invoked: 1, failedByReason: { MODEL_CALL_FAILED: 2 } }],
    ['a reason that is not a gateway reason code', { invoked: 1, failedByReason: { 'free text': 1 } }],
    ['a non-integer failure count', { invoked: 2, failedByReason: { MODEL_CALL_FAILED: 0.5 } }],
    ['an array', [1, 2]],
    ['a string', 'many'],
  ])('leaves the run total unchanged for %s', (_case, query) => {
    expect(addQueryModelExtractions(EMPTY_RUN_MODEL_EXTRACTIONS, query)).toBe(
      EMPTY_RUN_MODEL_EXTRACTIONS,
    );
  });
});
