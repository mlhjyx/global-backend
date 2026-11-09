/**
 * v2 单模型判定执行器（P3 J12；从 `fit-judge-v2.ts` 抽出，供单模型判定与
 * borderline 面板共用，避免复制 prompt/证据/聚合/记账逻辑）。
 *
 * 每次调用 = 一次模型尝试：构造同一 prompt（`judge-prompt.ts`）、执行
 * `discovery.qualify_fit` 契约（judge-output/v2 schema）、结构校验、证据校验、
 * 确定性聚合。预算 reserve/settle 由网关按「模型 + prompt + schema」操作键逐次
 * 完成——面板逐模型调用因此天然分账，本模块不自建账户。
 *
 * 失败语义（与 v1/v2 一致）：
 *  - 预算/控制面错误（`isFatalJudgeError`）显性上抛，绝不降级成 UNKNOWN 票；
 *  - 其余模型故障/输出非法返回 `{ ok: false, failureCode }`，由调用方决定
 *    「单模型判 null」还是「面板记 UNKNOWN 票并继续」。
 */

import type { Prisma } from '@prisma/client';

import type { ModelGateway } from '../../model-gateway/model-gateway';
import { getTask } from '../../ai-tasks/task-registry';
import { BudgetExceededError, BudgetOperationReplayError } from '../../tools/budget-store';
import type { RuntimeTelemetry } from '../../model-runtime/types';
import {
  executeSkillWithRuntime,
  SkillUnavailableError,
  STATIC_SKILL_RESOLVER,
  type SkillResolver,
} from '../../skills/skill-runtime';
import type { RuntimeStructuredModelResult } from '../../model-runtime/structured-task-runtime-bridge';
import { isExecutionControlError } from '../../execution-budget/execution-control-error';
import {
  aggregateJudgment,
  type AggregationResult,
  type JudgmentVerdict,
} from './aggregate-judgment';
import {
  validateEvidence,
  type EvidenceUrlPolicy,
} from './evidence-validate';
import { RUBRIC_SAMPLING } from './fit-rubric';
import type { FailureCode } from './failure-codes';
import {
  JUDGE_OUTPUT_JSON_SCHEMA,
  validateJudgeOutputV2,
  type JudgeCriterionOutput,
  type JudgeOutputV2,
} from './judge-output-v2';
import { buildJudgePrompt, type JudgePromptBundle } from './judge-prompt';
import {
  judgmentInputDigest,
  judgmentOutputDigest,
  type JudgmentModelIdentity,
  type JudgmentRecordDraft,
} from './judgment-record';
import type { FitJudgeCompany, IcpBrief } from '../fit-judge';

/** 判定任务契约 id：面板复用同一契约身份（qualify_fit / judge-output/v2）。 */
const JUDGE_TASK_ID = 'discovery.qualify_fit';
const JUDGE_SKILL_KEY = 'discovery.qualify_fit';

export interface CompanySnapshotFacts {
  country: string | null;
  domain: string | null;
  industry: string | null;
  keywords?: string[];
  name: string;
  products?: string[];
  website_profile?: Record<string, unknown>;
}

/** 与 v1 判定同一口径的公司快照（其 JSON 文本即 validateEvidence 的 snapshotText）。 */
export function buildCompanySnapshot(company: FitJudgeCompany): {
  facts: CompanySnapshotFacts;
  snapshotText: string;
} {
  const attributes = company.attributes as {
    products?: string[];
    keywords?: string[];
    website_profile?: Record<string, unknown>;
  } | null;
  const products = attributes?.products ?? [];
  const keywords = attributes?.keywords ?? [];
  const profile = attributes?.website_profile;
  const profileFacts = profile
    ? {
        trade_role: profile.trade_role,
        own_manufacturing: profile.own_manufacturing,
        carried_brands: profile.carried_brands,
        carries_chinese_brand: profile.carries_chinese_brand,
        carries_foreign_brand: profile.carries_foreign_brand,
        evidence: profile.evidence,
      }
    : undefined;
  const websiteProfile =
    profileFacts && Object.values(profileFacts).some((value) => value !== undefined)
      ? profileFacts
      : undefined;
  const facts: CompanySnapshotFacts = {
    name: company.name,
    domain: company.domain,
    country: company.country,
    industry: company.industry,
    products,
    keywords,
    ...(websiteProfile ? { website_profile: websiteProfile } : {}),
  };
  return { facts, snapshotText: JSON.stringify(facts, null, 2) };
}

/**
 * 证据域门（当前实现选择，见 PR 说明）：只放行公司自有域（含子域）的 URL。
 * 判定快照只有该公司官网/Impressum 的内容，其他域的 URL 一律视为不可验证证据
 * （fail-closed；不把异步 source_policy reader 塞进纯校验器）。
 */
export function companyDomainEvidenceUrlPolicy(
  domain: string | null | undefined,
): EvidenceUrlPolicy {
  const normalized = (domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/^www\./u, '')
    .replace(/\.$/u, '');
  if (!normalized) {
    return () => ({ allowed: false, reason: 'company has no domain' });
  }
  return (url: string) => {
    let host: string;
    try {
      host = new URL(url).hostname.trim().toLowerCase().replace(/\.$/u, '');
    } catch {
      return { allowed: false, reason: 'invalid evidence url' };
    }
    if (host === normalized || host.endsWith(`.${normalized}`)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `outside company domain ${normalized}` };
  };
}

function snapshotFetchedAtFromCompany(
  company: FitJudgeCompany,
  fallback: string,
): string {
  const attributes = company.attributes as
    | { website_profile?: Record<string, unknown> }
    | null
    | undefined;
  const profile = attributes?.website_profile;
  const candidate = profile?.fetched_at ?? profile?.fetchedAt;
  if (typeof candidate === 'string') {
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return fallback;
}

/** 一次判定调用共享的不可变输入：prompt 身份、快照与证据校验上下文。 */
export interface PreparedJudgeCall {
  companyId: string;
  facts: CompanySnapshotFacts;
  inputDigest: string;
  now: string;
  prompt: JudgePromptBundle;
  snapshotFetchedAt: string;
  snapshotText: string;
  urlPolicy: EvidenceUrlPolicy;
}

export interface PrepareJudgeCallOptions {
  /** 判定时刻（ISO 8601）；测试注入固定时钟，缺省取当前时间。 */
  now?: string;
  /** 快照抓取时间（ISO 8601）；缺省取 website_profile 的抓取时间，再缺省 now。 */
  snapshotFetchedAt?: string;
  /** 证据域门；缺省用「公司自有域」白名单（见 companyDomainEvidenceUrlPolicy）。 */
  urlPolicy?: EvidenceUrlPolicy;
}

export function prepareJudgeCall(
  icpBrief: IcpBrief | Record<string, never>,
  company: FitJudgeCompany,
  opts: PrepareJudgeCallOptions = {},
): PreparedJudgeCall {
  const now = opts.now ?? new Date().toISOString();
  const { facts, snapshotText } = buildCompanySnapshot(company);
  const prompt = buildJudgePrompt({
    icpBrief: JSON.stringify(icpBrief, null, 2),
    companySnapshot: snapshotText,
  });
  return {
    companyId: company.id,
    facts,
    inputDigest: judgmentInputDigest({ icpBrief, companySnapshot: facts }),
    now,
    prompt,
    snapshotFetchedAt:
      opts.snapshotFetchedAt ?? snapshotFetchedAtFromCompany(company, now),
    snapshotText,
    urlPolicy: opts.urlPolicy ?? companyDomainEvidenceUrlPolicy(company.domain),
  };
}

export interface JudgeModelCallOptions {
  runId?: string;
  runtimeTelemetry?: RuntimeTelemetry;
  authorizeExternalAction?: () => Promise<boolean>;
  skills?: SkillResolver;
}

/** 单模型判定结果：成功携带 output/聚合，失败携带稳定失败码（控制面错误仍上抛）。 */
export type JudgeModelRun =
  | {
      aggregation: AggregationResult;
      ok: true;
      output: JudgeOutputV2;
      raw: RuntimeStructuredModelResult<JudgeOutputV2>;
      refusal: boolean;
    }
  | {
      failureCode: FailureCode;
      ok: false;
      /** 输出非法时模型调用已完成——保留 raw 以便成本/延迟如实记账。 */
      raw?: RuntimeStructuredModelResult<JudgeOutputV2>;
    };

/** 控制面/预算错误必须显性上抛（与 v1 语义一致）；其余模型故障返回失败码。 */
export function isFatalJudgeError(error: unknown): boolean {
  return (
    error instanceof BudgetExceededError ||
    error instanceof BudgetOperationReplayError ||
    error instanceof SkillUnavailableError ||
    isExecutionControlError(error)
  );
}

function failureCodeOf(error: unknown): FailureCode {
  const message = error instanceof Error ? error.message : String(error);
  return /output invalid|schema/i.test(message) ? 'OUTPUT_SCHEMA_INVALID' : 'UNKNOWN_UPSTREAM';
}

export function costMicrosOf(
  usage: RuntimeStructuredModelResult<JudgeOutputV2>['usage'] | undefined,
): bigint | null {
  const cost = usage?.costUsd;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return null;
  return BigInt(Math.round(cost * 1_000_000));
}

/**
 * 用指定模型跑一次 v2 判定（网络调用，事务外执行）。
 * 预算归账键沿用网关既有机制：不同 `model` 产生不同的 budget operation key，
 * 每次调用独立 reserve/settle——面板逐模型分账因此无需额外记账代码。
 */
export async function runJudgeModel(
  gateway: ModelGateway,
  workspaceId: string,
  model: string,
  prepared: PreparedJudgeCall,
  opts: JudgeModelCallOptions = {},
): Promise<JudgeModelRun> {
  const contract = getTask(JUDGE_TASK_ID)!;

  let raw: RuntimeStructuredModelResult<JudgeOutputV2>;
  try {
    raw = await executeSkillWithRuntime<JudgeOutputV2>(
      opts.skills ?? STATIC_SKILL_RESOLVER,
      gateway,
      JUDGE_SKILL_KEY,
      {
        task: contract.id,
        prompt: prepared.prompt.user,
        system: prepared.prompt.system,
        model,
        schema: JUDGE_OUTPUT_JSON_SCHEMA as unknown as Record<string, unknown>,
      },
      // 非 durable：judge-output/v2 尚无注册的 durable 投影（fit-judgment/v1 只覆盖
      // v1 四门输出）。v2 的可审计载体是 judgment_record 本身（设计 §4.3.4）。
      {
        workspaceId,
        runId: opts.runId,
        authorizeExternalAction: opts.authorizeExternalAction,
      },
      { telemetry: opts.runtimeTelemetry },
    );
  } catch (error) {
    if (isFatalJudgeError(error)) throw error;
    console.warn(
      `[judge-v2] model call failed for ${prepared.companyId}: ${failureCodeOf(error)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { ok: false, failureCode: failureCodeOf(error) };
  }

  const validation = validateJudgeOutputV2(raw.data);
  if (!validation.ok) {
    // schema 校验失败按失败码 OUTPUT_SCHEMA_INVALID 处理（retryable，交由上游重试）。
    console.warn(
      `[judge-v2] OUTPUT_SCHEMA_INVALID for ${prepared.companyId}: ${validation.errors.slice(0, 5).join('; ')}`,
    );
    return { ok: false, failureCode: 'OUTPUT_SCHEMA_INVALID', raw };
  }
  const output = validation.value;
  const evidence = validateEvidence(output.criteria, {
    now: prepared.now,
    snapshotFetchedAt: prepared.snapshotFetchedAt,
    snapshotText: prepared.snapshotText,
    urlPolicy: prepared.urlPolicy,
  });
  const aggregation = aggregateJudgment({ output, evidence });
  return {
    ok: true,
    output,
    aggregation,
    refusal: output.refusal.is_refusal,
    raw,
  };
}

export interface JudgeRecordDraftInput {
  attempt?: number;
  companyId: string;
  costMicros?: bigint | null;
  criteria: readonly JudgeCriterionOutput[];
  evidenceCompleteness: boolean;
  failure?: { code: FailureCode } | null;
  inputDigest: string;
  inputTokens?: number | null;
  judgeLevel: 1 | 2 | 3;
  latencyMs?: number | null;
  model: JudgmentModelIdentity;
  outputTokens?: number | null;
  prompt: JudgePromptBundle;
  sampling?: Prisma.InputJsonValue;
  verdict: JudgmentVerdict;
  verdictProposed?: JudgmentVerdict | null;
  workspaceId: string;
}

/**
 * 把一次尝试打包成 `judgment_record` 草稿（纯映射，`icpId` 由调用方补齐）。
 * 单模型 L2 与面板 L3 共用，保证两处字段口径一致。
 * `criteria` 必须是已归一化的记录形态（真实输出用 `buildRecordedCriteria`，
 * 调用失败用占位 unclear 五项）。
 */
export function buildJudgeRecordDraft(
  input: JudgeRecordDraftInput,
): JudgmentRecordDraft {
  const micros = input.costMicros ?? null;
  return {
    workspaceId: input.workspaceId,
    companyId: input.companyId,
    judgeLevel: input.judgeLevel,
    verdict: input.verdict,
    verdictProposed: input.verdictProposed ?? null,
    criteria: input.criteria,
    evidenceCompleteness: input.evidenceCompleteness,
    rubricVersion: input.prompt.rubricVersion,
    promptHash: input.prompt.promptHash,
    schemaVersion: input.prompt.schemaVersion,
    inputDigest: input.inputDigest,
    outputDigest: judgmentOutputDigest(input.criteria),
    model: input.model,
    sampling: (input.sampling ?? {
      temperature: RUBRIC_SAMPLING.temperature,
      k: 1,
    }) as Prisma.InputJsonValue,
    ...(input.failure ? { failure: { code: input.failure.code } } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.latencyMs !== undefined && input.latencyMs !== null
      ? { latencyMs: input.latencyMs }
      : {}),
    ...(input.inputTokens !== undefined && input.inputTokens !== null
      ? { inputTokens: input.inputTokens }
      : {}),
    ...(input.outputTokens !== undefined && input.outputTokens !== null
      ? { outputTokens: input.outputTokens }
      : {}),
    ...(micros !== null ? { costMicros: micros } : {}),
  };
}
