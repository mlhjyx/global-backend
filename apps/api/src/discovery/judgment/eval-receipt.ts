/**
 * 模型层评测回执 eval-receipt/v1（P3 J19 第一批；设计 §4.3.10.2）。
 *
 * 回执回答「这次发布门判定，用的是哪份模型、哪份金标、什么门限、结果如何」：
 *  - subject / dataset / rubric / prompt / model 五个身份字段必须齐全；
 *  - metrics 每个数字都带 n 与 CI（报告纪律 §4.3.6.2）；
 *  - gate 记录门限与是否通过——发布流程只读这一字段即可阻断。
 *
 * 本文件是纯数据 + 结构校验；真实跑批脚本见 `scripts/judgment/run-judgment-model-evals.mts`。
 * 回执落表（eval_receipt.subject_kind='judge'）需 schema 迁移，属本卡后续批次。
 */

export const EVAL_RECEIPT_SCHEMA_VERSION = 'eval-receipt/v1' as const;

export interface EvalMetric {
  /** Wilson 95% CI。 */
  ci: [number, number];
  n: number;
  value: number;
}

export interface EvalReceipt {
  cases: { failed: number; passed: number; total: number };
  datasetSha256: string;
  gate: { passed: boolean; thresholds: Record<string, number> };
  metrics: { kappa: EvalMetric; tpr: EvalMetric; tnr: EvalMetric };
  modelResolved: string;
  promptHash: string;
  rubricVersion: string;
  /** ISO 时间；由调用方注入（脚本用系统时钟，测试传固定值）。 */
  runAt: string;
  schemaVersion: typeof EVAL_RECEIPT_SCHEMA_VERSION;
  subject: 'judge';
}

export class EvalReceiptError extends Error {
  readonly code = 'EVAL_RECEIPT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'EvalReceiptError';
  }
}

const HEX64 = /^[0-9a-f]{64}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

function assertMetric(value: unknown, name: string): asserts value is EvalMetric {
  if (typeof value !== 'object' || value === null) {
    throw new EvalReceiptError(`metrics.${name} must be an object`);
  }
  const metric = value as Record<string, unknown>;
  if (typeof metric.value !== 'number' || !(metric.value >= 0 && metric.value <= 1)) {
    throw new EvalReceiptError(`metrics.${name}.value must be in [0,1]`);
  }
  if (!Number.isInteger(metric.n) || (metric.n as number) < 0) {
    throw new EvalReceiptError(`metrics.${name}.n must be a non-negative integer`);
  }
  const ci = metric.ci as unknown;
  if (
    !Array.isArray(ci) ||
    ci.length !== 2 ||
    typeof ci[0] !== 'number' ||
    typeof ci[1] !== 'number' ||
    ci[0] > ci[1]
  ) {
    throw new EvalReceiptError(`metrics.${name}.ci must be [lo, hi] with lo<=hi`);
  }
}

/** 结构校验（fail-closed）：任何不满足的回执直接抛 EvalReceiptError。 */
export function assertEvalReceipt(value: unknown): asserts value is EvalReceipt {
  if (typeof value !== 'object' || value === null) {
    throw new EvalReceiptError('receipt must be an object');
  }
  const receipt = value as Record<string, unknown>;
  if (receipt.schemaVersion !== EVAL_RECEIPT_SCHEMA_VERSION) {
    throw new EvalReceiptError(`schemaVersion must be ${EVAL_RECEIPT_SCHEMA_VERSION}`);
  }
  if (receipt.subject !== 'judge') {
    throw new EvalReceiptError('subject must be judge');
  }
  for (const field of ['datasetSha256', 'promptHash'] as const) {
    if (typeof receipt[field] !== 'string' || !HEX64.test(receipt[field] as string)) {
      throw new EvalReceiptError(`${field} must be 64 lowercase hex`);
    }
  }
  if (typeof receipt.rubricVersion !== 'string' || !receipt.rubricVersion) {
    throw new EvalReceiptError('rubricVersion is required');
  }
  if (typeof receipt.modelResolved !== 'string' || !receipt.modelResolved) {
    throw new EvalReceiptError('modelResolved is required');
  }
  if (typeof receipt.runAt !== 'string' || !ISO.test(receipt.runAt)) {
    throw new EvalReceiptError('runAt must be an ISO instant');
  }
  const cases = receipt.cases as Record<string, unknown> | undefined;
  if (
    !cases ||
    !Number.isInteger(cases.total) ||
    !Number.isInteger(cases.passed) ||
    !Number.isInteger(cases.failed) ||
    (cases.passed as number) + (cases.failed as number) !== (cases.total as number)
  ) {
    throw new EvalReceiptError('cases.{total,passed,failed} must be consistent integers');
  }
  const metrics = receipt.metrics as Record<string, unknown> | undefined;
  if (!metrics) throw new EvalReceiptError('metrics is required');
  assertMetric(metrics.kappa, 'kappa');
  assertMetric(metrics.tpr, 'tpr');
  assertMetric(metrics.tnr, 'tnr');
  const gate = receipt.gate as Record<string, unknown> | undefined;
  if (typeof gate?.passed !== 'boolean') {
    throw new EvalReceiptError('gate.passed must be boolean');
  }
  if (typeof gate.thresholds !== 'object' || gate.thresholds === null) {
    throw new EvalReceiptError('gate.thresholds must be an object');
  }
}

export interface BuildReceiptInput {
  cases: EvalReceipt['cases'];
  datasetSha256: string;
  metrics: EvalReceipt['metrics'];
  modelResolved: string;
  promptHash: string;
  rubricVersion: string;
  runAt: string;
  thresholds: Record<string, number>;
}

/**
 * 门限判定（与设计 §4.3.10.2 一致的保守默认）：
 *  - kappa ≥ 0.6（低于则 rubric/模型需先修）、tpr/tnr ≥ 0.75；
 *  - 任一指标未达标 → gate.passed=false（发布门据此阻断）。
 * 阈值可被调用方覆盖（例如按 ICP 分层时收紧）。
 */
export function buildEvalReceipt(input: BuildReceiptInput): EvalReceipt {
  const thresholds = {
    kappa: 0.6,
    tpr: 0.75,
    tnr: 0.75,
    ...input.thresholds,
  };
  const passed =
    input.metrics.kappa.value >= thresholds.kappa! &&
    input.metrics.tpr.value >= thresholds.tpr! &&
    input.metrics.tnr.value >= thresholds.tnr! &&
    input.cases.failed === 0;
  const receipt: EvalReceipt = {
    schemaVersion: EVAL_RECEIPT_SCHEMA_VERSION,
    subject: 'judge',
    datasetSha256: input.datasetSha256,
    rubricVersion: input.rubricVersion,
    promptHash: input.promptHash,
    modelResolved: input.modelResolved,
    runAt: input.runAt,
    cases: input.cases,
    metrics: input.metrics,
    gate: { passed, thresholds },
  };
  assertEvalReceipt(receipt);
  return receipt;
}
