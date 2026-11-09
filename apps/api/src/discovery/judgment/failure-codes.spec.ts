import { describe, expect, it } from 'vitest';

import {
  FAILURE_CODES,
  FAILURE_CODES_VERSION,
  FAILURE_OUTCOMES,
  FAILURE_STAGES,
  GATE_REASON_CODES,
  failureCodeMeta,
  isFailureCode,
  isGateReasonCode,
  normalizeFailureCode,
} from './failure-codes';

describe('failure-codes（P3 J01 失败分类学 v1）', () => {
  it('版本常量固定；改表必须升版本', () => {
    // v2（P3 J02）：新增 PROVIDER_IDENTITY_MISMATCH / PROVIDER_TRANSPORT_FAILED /
    // CONTROL_PLANE_REJECTED 三个码，分类器映射真实错误类需要。
    expect(FAILURE_CODES_VERSION).toBe('failure-codes/v2');
  });

  it('映射表 100% 合法：stage/outcome 在闭集内、retryable 为布尔', () => {
    for (const [code, meta] of Object.entries(FAILURE_CODES)) {
      expect(FAILURE_STAGES, code).toContain(meta.stage);
      expect(FAILURE_OUTCOMES, code).toContain(meta.outcome);
      expect(typeof meta.retryable, code).toBe('boolean');
    }
  });

  it('码集合与设计表一致（增删要显式改这里）', () => {
    expect(Object.keys(FAILURE_CODES).sort()).toEqual(
      [
        'BUDGET_AUTHORITY_NOT_READY',
        'BUDGET_EXCEEDED',
        'CONTROL_PLANE_REJECTED',
        'DB_TX_CONFLICT',
        'ENUM_DRIFT',
        'EVIDENCE_MISSING',
        'EVIDENCE_STALE',
        'EVIDENCE_UNVERIFIED',
        'INPUT_MISSING_COMPANY',
        'INPUT_MISSING_DOMAIN',
        'INPUT_MISSING_ICP',
        'LEASE_LOST',
        'MODEL_REFUSAL',
        'OUTPUT_NOT_JSON',
        'OUTPUT_SCHEMA_INVALID',
        'OUTPUT_TRUNCATED',
        'PROMPT_INJECTION_DETECTED',
        'PROVIDER_HTTP_401_403',
        'PROVIDER_HTTP_402',
        'PROVIDER_HTTP_429',
        'PROVIDER_HTTP_5XX',
        'PROVIDER_IDENTITY_MISMATCH',
        'PROVIDER_TIMEOUT',
        'PROVIDER_TRANSPORT_FAILED',
        'RETRIEVER_ANTIBOT',
        'RETRIEVER_FETCH_FAILED',
        'RETRIEVER_ROBOTS_DENIED',
        'SKILL_UNAVAILABLE',
        'UNKNOWN_UPSTREAM',
      ].sort(),
    );
  });

  it('重试语义符合设计：429/5xx/超时/租约/事务可重试，预算与鉴权不可重试', () => {
    for (const code of [
      'PROVIDER_HTTP_429',
      'PROVIDER_HTTP_5XX',
      'PROVIDER_TIMEOUT',
      'PROVIDER_TRANSPORT_FAILED',
      'LEASE_LOST',
      'DB_TX_CONFLICT',
      'RETRIEVER_FETCH_FAILED',
    ]) {
      expect(failureCodeMeta(code).retryable, code).toBe(true);
    }
    for (const code of [
      'BUDGET_EXCEEDED',
      'BUDGET_AUTHORITY_NOT_READY',
      'CONTROL_PLANE_REJECTED',
      'PROVIDER_HTTP_401_403',
      'PROVIDER_HTTP_402',
      'PROVIDER_IDENTITY_MISMATCH',
      'EVIDENCE_MISSING',
      'MODEL_REFUSAL',
    ]) {
      expect(failureCodeMeta(code).retryable, code).toBe(false);
    }
  });

  it('未知码 fail-closed：查表抛错，只有显式归一才落到 UNKNOWN_UPSTREAM', () => {
    expect(() => failureCodeMeta('NOT_A_CODE')).toThrow(
      'UNKNOWN_FAILURE_CODE:NOT_A_CODE',
    );
    expect(normalizeFailureCode('NOT_A_CODE')).toBe('UNKNOWN_UPSTREAM');
    expect(normalizeFailureCode(null)).toBe('UNKNOWN_UPSTREAM');
    expect(normalizeFailureCode('PROVIDER_TIMEOUT')).toBe('PROVIDER_TIMEOUT');
  });

  it('gate reason 闭集：14 个码、唯一、与失败码互不重叠', () => {
    expect(new Set(GATE_REASON_CODES).size).toBe(GATE_REASON_CODES.length);
    expect(GATE_REASON_CODES).toHaveLength(14);
    for (const code of GATE_REASON_CODES) {
      expect(isFailureCode(code), code).toBe(false);
      expect(isGateReasonCode(code), code).toBe(true);
    }
    expect(isGateReasonCode('PROVIDER_TIMEOUT')).toBe(false);
  });
});
