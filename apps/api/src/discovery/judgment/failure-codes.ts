/**
 * 判定链失败分类学 v1（P3 J01；设计 §4.3.5.1）。
 *
 * 所有失败必须能填满 `stage × cause × outcome`：cause 是**版本化稳定枚举**，
 * stage/outcome 是闭集；`retryable` 直接决定 Temporal 重试策略与是否降级为
 * UNKNOWN。新增或修改任何码都必须：
 *   1) 升 `FAILURE_CODES_VERSION`；
 *   2) 在同一 PR 更新本表测试（映射 100% 覆盖）；
 *   3) 同步 J02/J22 的 `nonRetryableErrorTypes` 清单与值班 runbook。
 *
 * 本文件是纯数据 + 查表函数，不做 I/O，便于在 workflow/activity/脚本三处复用。
 */

export const FAILURE_CODES_VERSION = 'failure-codes/v2' as const;

export const FAILURE_STAGES = [
  'provider',
  'parser',
  'retriever',
  'guardrail',
  'tool',
  'budget',
  'dispatch',
  'storage',
] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

export const FAILURE_OUTCOMES = [
  'retry',
  'failover',
  'degraded',
  'failed',
  'skipped',
] as const;
export type FailureOutcome = (typeof FAILURE_OUTCOMES)[number];

export interface FailureCodeMeta {
  /** 失败发生在哪一层；用于报表与告警分组。 */
  readonly stage: FailureStage;
  /** 该链路是否值得自动重试（false 时通常 nonRetryable）。 */
  readonly retryable: boolean;
  /** 默认处置：重试 / 换模型换源 / 降级为 UNKNOWN / 本家失败 / 跳过可续。 */
  readonly outcome: FailureOutcome;
}

/**
 * cause 闭集。编码顺序与设计文档表一致，便于人工对照。
 * `UNKNOWN_UPSTREAM` 允许一次重试后仍失败即告警，避免未知错误被静默吞掉。
 */
export const FAILURE_CODES = {
  PROVIDER_HTTP_429: { stage: 'provider', retryable: true, outcome: 'retry' },
  PROVIDER_HTTP_5XX: { stage: 'provider', retryable: true, outcome: 'retry' },
  PROVIDER_TIMEOUT: { stage: 'provider', retryable: true, outcome: 'retry' },
  PROVIDER_HTTP_402: { stage: 'provider', retryable: false, outcome: 'failover' },
  PROVIDER_HTTP_401_403: {
    stage: 'provider',
    retryable: false,
    outcome: 'failover',
  },
  /** v2（P3 J02）：响应无法证明来自被请求的确切模型（ProviderIdentityError）。 */
  PROVIDER_IDENTITY_MISMATCH: {
    stage: 'provider',
    retryable: false,
    outcome: 'failover',
  },
  /** v2（P3 J02）：传输在完整答案到达前失败（断流/坏事件/非 JSON body，ProviderTransportError）。 */
  PROVIDER_TRANSPORT_FAILED: {
    stage: 'provider',
    retryable: true,
    outcome: 'retry',
  },
  MODEL_REFUSAL: { stage: 'guardrail', retryable: false, outcome: 'degraded' },
  OUTPUT_NOT_JSON: { stage: 'parser', retryable: true, outcome: 'failed' },
  OUTPUT_SCHEMA_INVALID: {
    stage: 'parser',
    retryable: true,
    outcome: 'failed',
  },
  OUTPUT_TRUNCATED: { stage: 'parser', retryable: false, outcome: 'failed' },
  ENUM_DRIFT: { stage: 'parser', retryable: true, outcome: 'failed' },
  EVIDENCE_MISSING: { stage: 'guardrail', retryable: false, outcome: 'degraded' },
  EVIDENCE_UNVERIFIED: {
    stage: 'guardrail',
    retryable: false,
    outcome: 'degraded',
  },
  EVIDENCE_STALE: { stage: 'guardrail', retryable: false, outcome: 'degraded' },
  PROMPT_INJECTION_DETECTED: {
    stage: 'guardrail',
    retryable: false,
    outcome: 'degraded',
  },
  INPUT_MISSING_COMPANY: {
    stage: 'dispatch',
    retryable: false,
    outcome: 'skipped',
  },
  INPUT_MISSING_DOMAIN: {
    stage: 'dispatch',
    retryable: false,
    outcome: 'skipped',
  },
  INPUT_MISSING_ICP: { stage: 'dispatch', retryable: false, outcome: 'failed' },
  BUDGET_EXCEEDED: { stage: 'budget', retryable: false, outcome: 'failed' },
  BUDGET_AUTHORITY_NOT_READY: {
    stage: 'budget',
    retryable: false,
    outcome: 'failed',
  },
  /**
   * v2（P3 J02）：控制面拒绝（域 ACK/回执/围栏等，非预算类）。
   * 与预算类分开，避免把控制面错误记成 `PROVIDER_*`（设计 §4.3.9 W2）。
   */
  CONTROL_PLANE_REJECTED: {
    stage: 'dispatch',
    retryable: false,
    outcome: 'failed',
  },
  SKILL_UNAVAILABLE: { stage: 'dispatch', retryable: false, outcome: 'failed' },
  LEASE_LOST: { stage: 'dispatch', retryable: true, outcome: 'retry' },
  DB_TX_CONFLICT: { stage: 'storage', retryable: true, outcome: 'retry' },
  RETRIEVER_FETCH_FAILED: {
    stage: 'retriever',
    retryable: true,
    outcome: 'retry',
  },
  RETRIEVER_ROBOTS_DENIED: {
    stage: 'retriever',
    retryable: false,
    outcome: 'degraded',
  },
  RETRIEVER_ANTIBOT: {
    stage: 'retriever',
    retryable: false,
    outcome: 'degraded',
  },
  UNKNOWN_UPSTREAM: { stage: 'provider', retryable: true, outcome: 'failed' },
} as const satisfies Record<string, FailureCodeMeta>;

export type FailureCode = keyof typeof FAILURE_CODES;

/** 硬门拒绝原因（reason_code）闭集；与失败码分开，不参与 retry 策略。 */
export const GATE_REASON_CODES = [
  'GATE_SANCTIONS_HIT',
  'GATE_SANCTIONS_STALE_YELLOW',
  'GATE_SANCTIONS_STALE_RED',
  'GATE_SANCTIONS_NOT_SCREENED',
  'GATE_SUPPRESSION',
  'GATE_ICP_EXCLUSION',
  'GATE_COUNTRY_MISMATCH',
  'GATE_COUNTRY_UNKNOWN',
  'GATE_SIZE_OUT_OF_RANGE',
  'GATE_SIZE_UNKNOWN',
  'GATE_DOMAIN_MISSING',
  'GATE_DOMAIN_DEAD',
  'GATE_SELF',
  'GATE_COMPANY_DISSOLVED',
] as const;
export type GateReasonCode = (typeof GATE_REASON_CODES)[number];

/** 查表；未知码直接抛错（fail-closed，不允许把拼写错误写成字符串字面量）。 */
export function failureCodeMeta(code: string): FailureCodeMeta {
  if (!isFailureCode(code)) {
    throw new Error(`UNKNOWN_FAILURE_CODE:${code}`);
  }
  return FAILURE_CODES[code];
}

export function isFailureCode(value: unknown): value is FailureCode {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(FAILURE_CODES, value)
  );
}

export function isGateReasonCode(value: unknown): value is GateReasonCode {
  return (
    typeof value === 'string' &&
    (GATE_REASON_CODES as readonly string[]).includes(value)
  );
}

/** 未知 cause 不得静默重试：UNKNOWN_UPSTREAM 才是唯一显式兜底。 */
export function normalizeFailureCode(value: unknown): FailureCode {
  return isFailureCode(value) ? value : 'UNKNOWN_UPSTREAM';
}
