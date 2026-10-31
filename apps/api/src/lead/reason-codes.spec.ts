import { describe, expect, it } from 'vitest';
import {
  POSITIVE_OUTCOME_CODES,
  REJECT_REASON_CODES,
  deriveFitReasonCodes,
  isOutcomeReasonCode,
  isRejectReasonCode,
} from './reason-codes';

/**
 * BI-20（交付闭环设计 §4）：拒绝原因与客户反馈原因共用一套稳定枚举；Fit 原因码由确定性规则
 * 从分数依据推出——不让模型自由命名，也不把自由文本当枚举。
 */
describe('reason code enums', () => {
  it('stabilises the ten reject reasons and the two positive outcomes of the design', () => {
    expect(REJECT_REASON_CODES).toEqual([
      'NOT_TARGET_ROLE',
      'WRONG_PRODUCT',
      'TOO_SMALL',
      'TOO_LARGE',
      'ALREADY_KNOWN',
      'NO_IMPORT_SIGNAL',
      'WRONG_COUNTRY',
      'BAD_CONTACT_PATH',
      'DUPLICATE',
      'OTHER',
    ]);
    expect(POSITIVE_OUTCOME_CODES).toEqual(['GOOD_FIT', 'WILL_FOLLOW_UP']);
    expect(Object.isFrozen(REJECT_REASON_CODES)).toBe(true);
  });

  it('tells reject codes and outcome codes apart, and refuses anything else', () => {
    expect(isRejectReasonCode('WRONG_PRODUCT')).toBe(true);
    expect(isRejectReasonCode('GOOD_FIT')).toBe(false);
    expect(isRejectReasonCode('wrong_product')).toBe(false);
    expect(isRejectReasonCode(undefined)).toBe(false);
    expect(isOutcomeReasonCode('WILL_FOLLOW_UP')).toBe(true);
    expect(isOutcomeReasonCode('DUPLICATE')).toBe(true);
    expect(isOutcomeReasonCode('NOT_A_CODE')).toBe(false);
    expect(isOutcomeReasonCode('constructor')).toBe(false);
  });
});

describe('deriveFitReasonCodes', () => {
  it('maps the authoritative fit verdict to FIT_* codes', () => {
    expect(deriveFitReasonCodes({ fitVerdict: 'match' })).toEqual(['FIT_MATCH']);
    expect(deriveFitReasonCodes({ fitVerdict: 'weak' })).toEqual(['FIT_WEAK']);
    expect(deriveFitReasonCodes({ fitVerdict: 'mismatch' })).toEqual(['FIT_MISMATCH']);
    expect(deriveFitReasonCodes({ fitVerdict: null })).toEqual([]);
    expect(deriveFitReasonCodes({ fitVerdict: 'exclude' })).toEqual([]);
  });

  it('turns failed rule evaluations into RULE_<kind>_FAIL and ignores advisory mirrors', () => {
    const codes = deriveFitReasonCodes({
      scoreDetail: {
        ruleEvaluations: [
          { kind: 'MUST_HAVE', outcome: 'fail' },
          { kind: 'MUST_HAVE', outcome: 'fail' },
          { kind: 'EXCLUSION', outcome: 'pass' },
          { kind: 'EXCLUSION', outcome: 'fail', advisory: true },
          { kind: 'NICE_TO_HAVE', outcome: 'unknown' },
        ],
      },
    });
    expect(codes).toEqual(['RULE_MUST_HAVE_FAIL']);
  });

  it('marks a zero reachability and keeps the scoring reason code', () => {
    expect(deriveFitReasonCodes({ scores: { reachability: 0 } })).toEqual(['MISSING_CONTACT_POINT']);
    expect(
      deriveFitReasonCodes({ scoreDetail: { reasonCodes: ['MISSING_CONTACT_POINT'] } }),
    ).toEqual(['MISSING_CONTACT_POINT']);
    expect(deriveFitReasonCodes({ scores: { reachability: 0.5 } })).toEqual([]);
  });

  it('turns missing key fields into MISSING_<FIELD> and a sanctions hold into SANCTIONS_HOLD', () => {
    expect(
      deriveFitReasonCodes({
        queue: 'sanctions_hold',
        scoreDetail: { missingFields: ['domain', 'employee_count'] },
      }),
    ).toEqual(['MISSING_DOMAIN', 'MISSING_EMPLOYEE_COUNT', 'SANCTIONS_HOLD']);
  });

  it('deduplicates while keeping first-seen order, and survives malformed JSON', () => {
    expect(
      deriveFitReasonCodes({
        fitVerdict: 'match',
        scores: { reachability: 0 },
        scoreDetail: { reasonCodes: ['MISSING_CONTACT_POINT'] },
      }),
    ).toEqual(['FIT_MATCH', 'MISSING_CONTACT_POINT']);
    expect(deriveFitReasonCodes({})).toEqual([]);
    expect(
      deriveFitReasonCodes({
        scoreDetail: {
          ruleEvaluations: [null, 'x', { kind: 42, outcome: 'fail' }, { kind: 'WEIRD', outcome: 'fail' }],
          missingFields: [null, '', '!!!'],
          reasonCodes: ['MISSING_CONTACT_POINT', 7],
        },
      }),
    ).toEqual(['MISSING_CONTACT_POINT']);
  });
});
