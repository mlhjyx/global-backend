/**
 * 判定记录写入器（P3 J06；设计 §4.3.4.4「写入路径唯一入口」）。
 *
 * 一次 judge 尝试一行，append-only（DB 权限保证 app_user 只能 SELECT/INSERT）。
 * 幂等：replay key = (workspace, company, icp, input_digest, rubric_version,
 * prompt_hash, judge_level, attempt)。活动重试命中已有行时：
 *   - 已存在同 verdict → 视为成功（不翻行、不重复计费）；
 *   - 已存在不同 verdict → `JudgmentRecordReplayConflictError`（同一输入产生两种结论，
 *     必须人工排查，绝不静默覆盖）。
 *
 * 本模块不做模型调用、不做投影：Lead 投影（`upsertLeadFit`）由调用方在同一事务里
 * 另行执行（设计 §4.3.4.4 约束「与 Lead 投影同事务」），避免本模块反向依赖判定链。
 */

import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import {
  failureCodeMeta,
  isFailureCode,
  type FailureCode,
} from './failure-codes';
import {
  CRITERION_IDS,
  CRITERION_LABELS,
  RUBRIC_VERSION,
} from './fit-rubric';
import type { JudgeCriterionOutput, JudgeOutputV2 } from './judge-output-v2';
import { JUDGE_OUTPUT_SCHEMA_VERSION } from './judge-output-v2';
import { JUDGMENT_VERDICTS, type JudgmentVerdict } from './aggregate-judgment';

export class JudgmentRecordValidationError extends Error {
  readonly code = 'JUDGMENT_RECORD_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'JudgmentRecordValidationError';
  }
}

export class JudgmentRecordReplayConflictError extends Error {
  readonly code = 'JUDGMENT_RECORD_REPLAY_CONFLICT';
  constructor(message: string) {
    super(message);
    this.name = 'JudgmentRecordReplayConflictError';
  }
}

const HEX64 = /^[0-9a-f]{64}$/u;

export interface JudgmentModelIdentity {
  reported?: null | string;
  requested: string;
  resolved?: null | string;
}

export interface JudgmentFailure {
  /** failure-codes.ts 闭集里的稳定码；stage/cause/outcome/retryable 由它派生。 */
  code: FailureCode;
}

export interface JudgmentConformal {
  score: number;
  thresholdVersion: string;
}

/**
 * 待写草稿：`icpId`（与真实 run id）由调用方在同一事务里补齐。
 * P3 J12：面板一次判定会产出多条草稿（逐模型 + 汇总），全部经同一唯一写入口落库。
 */
export type JudgmentRecordDraft = Omit<RecordJudgmentInput, 'icpId'>;

export interface RecordJudgmentInput {
  attempt?: number;
  companyId: string;
  conformal?: JudgmentConformal | null;
  costMicros?: bigint | null;
  criteria: readonly JudgeCriterionOutput[];
  durableReceipt?: Prisma.InputJsonValue | null;
  evidenceCompleteness: boolean;
  failure?: JudgmentFailure | null;
  icpId: string;
  inputDigest: string;
  inputTokens?: number | null;
  judgeLevel: 1 | 2 | 3;
  latencyMs?: number | null;
  model: JudgmentModelIdentity;
  outputDigest: string;
  outputTokens?: number | null;
  promptHash: string;
  rubricVersion?: string;
  runId?: null | string;
  sampling?: Prisma.InputJsonValue;
  schemaVersion?: string;
  verdict: JudgmentVerdict;
  verdictProposed?: JudgmentVerdict | null;
  workspaceId: string;
}

/** 输出指纹：criteria 的 canonical JSON sha256（回放/差分用）。 */
export function judgmentOutputDigest(
  criteria: readonly JudgeCriterionOutput[],
): string {
  return createHash('sha256')
    .update(JSON.stringify(criteria), 'utf8')
    .digest('hex');
}

/** 输入指纹：company profile + icp brief + gate facts 的 canonical JSON。 */
export function judgmentInputDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

/** 汇总去重证据引用（URL+span 去重，保留首次出现顺序）。 */
export function collectEvidenceRefs(
  criteria: readonly JudgeCriterionOutput[],
):
  | Array<{ kind: string; span: string; url: string }> {
  const seen = new Set<string>();
  const refs: Array<{ kind: string; span: string; url: string }> = [];
  for (const criterion of criteria) {
    for (const evidence of criterion.evidence) {
      const key = `${evidence.kind}\u0000${evidence.url}\u0000${evidence.span}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({
        kind: evidence.kind,
        url: evidence.url,
        span: evidence.span,
      });
    }
  }
  return refs;
}

function assertDigest(value: string, field: string): void {
  if (!HEX64.test(value)) {
    throw new JudgmentRecordValidationError(
      `${field} must be 64 lowercase hex characters`,
    );
  }
}

function assertCriteria(criteria: readonly JudgeCriterionOutput[]): void {
  if (criteria.length !== CRITERION_IDS.length) {
    throw new JudgmentRecordValidationError(
      `criteria must contain ${CRITERION_IDS.length} entries`,
    );
  }
  const seen = new Set<string>();
  for (const criterion of criteria) {
    if (!(CRITERION_IDS as readonly string[]).includes(criterion.id)) {
      throw new JudgmentRecordValidationError(
        `unknown criterion ${String(criterion.id)}`,
      );
    }
    if (seen.has(criterion.id)) {
      throw new JudgmentRecordValidationError(
        `duplicate criterion ${criterion.id}`,
      );
    }
    seen.add(criterion.id);
    if (!(CRITERION_LABELS as readonly string[]).includes(criterion.label)) {
      throw new JudgmentRecordValidationError(
        `criterion ${criterion.id} has unknown label`,
      );
    }
    if (
      criterion.score !== null &&
      (!Number.isInteger(criterion.score) ||
        criterion.score < 0 ||
        criterion.score > 10)
    ) {
      throw new JudgmentRecordValidationError(
        `criterion ${criterion.id} score must be 0..10 or null`,
      );
    }
  }
}

/**
 * 写入一条判定记录（须在 withWorkspace 事务内由调用方保证 workspace 一致性）。
 * 返回 `{ recordId, replayed }`：replayed=true 表示命中 replay key 的既有行。
 */
export async function recordJudgment(
  tx: Prisma.TransactionClient,
  input: RecordJudgmentInput,
): Promise<{ recordId: string; replayed: boolean }> {
  if (!(JUDGMENT_VERDICTS as readonly string[]).includes(input.verdict)) {
    throw new JudgmentRecordValidationError(
      `unknown verdict ${String(input.verdict)}`,
    );
  }
  if (
    input.verdictProposed !== undefined &&
    input.verdictProposed !== null &&
    !(JUDGMENT_VERDICTS as readonly string[]).includes(input.verdictProposed)
  ) {
    throw new JudgmentRecordValidationError(
      `unknown verdictProposed ${String(input.verdictProposed)}`,
    );
  }
  if (![1, 2, 3].includes(input.judgeLevel)) {
    throw new JudgmentRecordValidationError('judgeLevel must be 1, 2 or 3');
  }
  assertDigest(input.inputDigest, 'inputDigest');
  assertDigest(input.outputDigest, 'outputDigest');
  assertDigest(input.promptHash, 'promptHash');
  assertCriteria(input.criteria);
  if (input.failure && !isFailureCode(input.failure.code)) {
    throw new JudgmentRecordValidationError(
      `unknown failure code ${String(input.failure.code)}`,
    );
  }

  const failureMeta = input.failure ? failureCodeMeta(input.failure.code) : null;
  const attempt = input.attempt ?? 1;
  const rubricVersion = input.rubricVersion ?? RUBRIC_VERSION;
  const schemaVersion = input.schemaVersion ?? JUDGE_OUTPUT_SCHEMA_VERSION;
  const replayKey = {
    workspaceId: input.workspaceId,
    canonicalCompanyId: input.companyId,
    icpId: input.icpId,
    inputDigest: input.inputDigest,
    rubricVersion,
    promptHash: input.promptHash,
    judgeLevel: input.judgeLevel,
    attempt,
  };

  const inserted = await tx.judgmentRecord.createMany({
    data: [
      {
        ...replayKey,
        runId: input.runId ?? null,
        verdict: input.verdict,
        verdictProposed: input.verdictProposed ?? null,
        criteria: input.criteria as unknown as Prisma.InputJsonValue,
        evidenceRefs: collectEvidenceRefs(input.criteria) as unknown as Prisma.InputJsonValue,
        evidenceCompleteness: input.evidenceCompleteness,
        schemaVersion,
        outputDigest: input.outputDigest,
        modelRequested: input.model.requested,
        modelResolved: input.model.resolved ?? null,
        modelReported: input.model.reported ?? null,
        sampling: (input.sampling ?? {}) as Prisma.InputJsonValue,
        stage: failureMeta?.stage ?? null,
        cause: input.failure?.code ?? null,
        outcome: failureMeta?.outcome ?? null,
        retryable: failureMeta?.retryable ?? null,
        failureCode: input.failure?.code ?? null,
        latencyMs: input.latencyMs ?? null,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        costMicros: input.costMicros ?? null,
        durableReceipt: input.durableReceipt ?? undefined,
        conformalScore: input.conformal?.score ?? null,
        conformalThresholdVersion: input.conformal?.thresholdVersion ?? null,
      },
    ],
    skipDuplicates: true,
  });

  const row = await tx.judgmentRecord.findUnique({
    where: {
      workspaceId_canonicalCompanyId_icpId_inputDigest_rubricVersion_promptHash_judgeLevel_attempt:
        replayKey,
    },
    select: { id: true, verdict: true },
  });
  if (!row) {
    throw new JudgmentRecordValidationError(
      'judgment record write did not persist (unexpected)',
    );
  }
  if (row.verdict !== input.verdict) {
    throw new JudgmentRecordReplayConflictError(
      `replay of ${input.inputDigest.slice(0, 12)}… recorded ${row.verdict}, now ${input.verdict}`,
    );
  }
  return { recordId: row.id, replayed: inserted.count === 0 };
}

/**
 * 把聚合器输出 + judge 输出打包成写入输入（调用方补 ids/模型/成本）。
 * 纯映射，便于 shadow 接线时两处调用共享同一构建逻辑。
 */
export function buildRecordedCriteria(
  output: JudgeOutputV2,
): JudgeCriterionOutput[] {
  return output.criteria.map((criterion) => ({
    id: criterion.id,
    applicable: criterion.applicable,
    score: criterion.score,
    label: criterion.label,
    evidence: criterion.evidence,
    rationale: criterion.rationale,
  }));
}
