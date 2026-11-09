/**
 * judge-output/v2 判定路径（P3 J03b；设计 §4.3.3.6 W3/W5、§4.3.4.4）。
 *
 * 与 v1（`fit-judge.ts` 的四门 gate 输出直接给 verdict）并存，由 `JUDGE_CONTRACT_MODE` 切换：
 *  - off（默认）：不进入本模块，生产行为与旧路径完全一致；
 *  - shadow：v1 判定照旧产出 Lead 结果；**额外**跑一次 v2 判定并生成 `judgment_record`
 *    草稿（调用方与 Lead 同事务写入），失败只记日志，不影响 Lead；
 *  - enforce：只用 v2 的确定性聚合 verdict 走 Lead 投影（FIT→match / UNKNOWN→weak /
 *    NOT_FIT→mismatch），v1 不再参与。
 *
 * 语义约束（设计 §4.3.3.4/§4.3.4.4）：
 *  - 模型只产出 criterion 级判断（judge-output/v2）；最终 verdict 只由
 *    `aggregateJudgment`（R0–R4）决定，`verdict_proposed` 仅诊断；
 *  - 证据先经 `validateEvidence`：URL 过域门、span 必须逐字来自本次输入快照、
 *    网页证据 30 天新鲜度、页面内嵌指令按注入处理；
 *  - 网络调用在事务外完成；`judgment_record` 与 Lead 投影由调用方在同一个
 *    `prisma.withWorkspace` 事务内写入（recordJudgment + upsertLeadFit）。
 */

import type { Prisma } from '@prisma/client';

import type { ModelGateway } from '../model-gateway/model-gateway';
import { getTask } from '../ai-tasks/task-registry';
import { BudgetExceededError, BudgetOperationReplayError } from '../tools/budget-store';
import type { RuntimeTelemetry } from '../model-runtime/types';
import {
  executeSkillWithRuntime,
  SkillUnavailableError,
  STATIC_SKILL_RESOLVER,
  type SkillResolver,
} from '../skills/skill-runtime';
import type { RuntimeStructuredModelResult } from '../model-runtime/structured-task-runtime-bridge';
import { isExecutionControlError } from '../execution-budget/execution-control-error';
import {
  aggregateJudgment,
  type AggregationResult,
  type JudgmentVerdict,
} from './judgment/aggregate-judgment';
import {
  validateEvidence,
  type EvidenceUrlPolicy,
} from './judgment/evidence-validate';
import { RUBRIC_SAMPLING } from './judgment/fit-rubric';
import {
  JUDGE_OUTPUT_JSON_SCHEMA,
  validateJudgeOutputV2,
  type JudgeCriterionOutput,
  type JudgeOutputV2,
} from './judgment/judge-output-v2';
import { buildJudgePrompt } from './judgment/judge-prompt';
import {
  buildRecordedCriteria,
  judgmentInputDigest,
  judgmentOutputDigest,
  type RecordJudgmentInput,
} from './judgment/judgment-record';
import type { FitJudgeCompany, FitJudgment, IcpBrief } from './fit-judge';

export const JUDGE_CONTRACT_MODES = ['off', 'shadow', 'enforce'] as const;
export type JudgeContractMode = (typeof JUDGE_CONTRACT_MODES)[number];

/**
 * 判定契约开关（设计 §4.3.3.6）。默认 `off`：任何未显式配置的进程都走旧路径。
 * 非法值按 `off` 处理（fail-safe 到既有行为，绝不因拼写错误改变生产判定）。
 *
 * 环境 parity 政策说明：本开关是运行期灰度（off/shadow/enforce），不分支
 * app environment（development/test/pilot/production），因此不产生
 * ENVIRONMENT_BRANCH finding，也不应登记 configuration_allowlist
 * （登记会因无对应 finding 而报 ENVIRONMENT_ALLOWANCE_STALE）。
 */
export function judgeContractMode(
  env: { readonly [key: string]: string | undefined } = process.env,
): JudgeContractMode {
  const raw = (env.JUDGE_CONTRACT_MODE ?? '').trim().toLowerCase();
  return (JUDGE_CONTRACT_MODES as readonly string[]).includes(raw)
    ? (raw as JudgeContractMode)
    : 'off';
}

/** `judgment_record` 草稿：icpId（与真实 run id）由调用方在同一事务里补齐。 */
export type JudgmentRecordDraft = Omit<RecordJudgmentInput, 'icpId'>;

export interface JudgeFitV2Options {
  runId?: string;
  runtimeTelemetry?: RuntimeTelemetry;
  authorizeExternalAction?: () => Promise<boolean>;
  skills?: SkillResolver;
  /** 判定时刻（ISO 8601）；测试注入固定时钟，缺省取当前时间。 */
  now?: string;
  /** 快照抓取时间（ISO 8601）；缺省取 website_profile 的抓取时间，再缺省 now。 */
  snapshotFetchedAt?: string;
  /** 证据域门；缺省用「公司自有域」白名单（见 companyDomainEvidenceUrlPolicy）。 */
  urlPolicy?: EvidenceUrlPolicy;
}

/** v2 判定结果：FitJudgment 形状 + 待持久化的 judgment_record 草稿。 */
export interface FitJudgmentV2 extends FitJudgment {
  judgmentRecord: JudgmentRecordDraft;
}

const VERDICT_TO_LEAD: Readonly<Record<JudgmentVerdict, FitJudgment['verdict']>> = Object.freeze({
  FIT: 'match',
  UNKNOWN: 'weak',
  NOT_FIT: 'mismatch',
});

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

function criterionById(
  output: JudgeOutputV2,
  id: JudgeCriterionOutput['id'],
): JudgeCriterionOutput {
  const criterion = output.criteria.find((item) => item.id === id);
  // validateJudgeOutputV2 已保证恰好 5 项且 id 无重复；缺失属编程错误。
  if (!criterion) throw new Error(`judge-v2: output missing criterion ${id}`);
  return criterion;
}

function gateText(criterion: JudgeCriterionOutput): string {
  const score = criterion.score === null ? '—' : String(criterion.score);
  return `${criterion.label}（score ${score}）：${criterion.rationale}`;
}

/** v2 聚合结果 → 既有 FitJudgment 形状（Lead 投影与调用方零改动）。 */
export function toFitJudgment(
  output: JudgeOutputV2,
  aggregation: AggregationResult,
  options: { refusalReason?: string | null } = {},
): FitJudgment {
  const reasons: string[] = [];
  if (options.refusalReason) {
    reasons.push(`模型拒答（fail-safe 转人工复核）：${options.refusalReason}`);
  }
  const score =
    aggregation.scoreWeighted === null
      ? '证据门/硬门先决'
      : aggregation.scoreWeighted.toFixed(2);
  reasons.push(
    `聚合 ${aggregation.version}：verdict=${aggregation.verdict}，加权分=${score}，` +
      `reasonCodes=${aggregation.reasonCodes.join(',')}`,
  );
  for (const criterion of aggregation.criteria) {
    reasons.push(`${criterion.id} ${gateText(criterionById(output, criterion.id))}`);
  }
  return {
    verdict: VERDICT_TO_LEAD[aggregation.verdict],
    fitReasons: {
      material: gateText(criterionById(output, 'C1_MATERIAL')),
      role: gateText(criterionById(output, 'C2_ROLE')),
      process: gateText(criterionById(output, 'C3_PROCESS')),
      business_model: gateText(criterionById(output, 'C4_BUSINESS_MODEL')),
      reasons: reasons.slice(0, 16),
    },
  };
}

/** 控制面/预算错误必须显性上抛（与 v1 语义一致）；其余模型故障返回 null。 */
function isFatalJudgeError(error: unknown): boolean {
  return (
    error instanceof BudgetExceededError ||
    error instanceof BudgetOperationReplayError ||
    error instanceof SkillUnavailableError ||
    isExecutionControlError(error)
  );
}

function failureCodeOf(error: unknown): 'OUTPUT_SCHEMA_INVALID' | 'UNKNOWN_UPSTREAM' {
  const message = error instanceof Error ? error.message : String(error);
  return /output invalid|schema/i.test(message) ? 'OUTPUT_SCHEMA_INVALID' : 'UNKNOWN_UPSTREAM';
}

function costMicrosOf(
  usage: RuntimeStructuredModelResult<JudgeOutputV2>['usage'],
): bigint | null {
  const cost = usage?.costUsd;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return null;
  return BigInt(Math.round(cost * 1_000_000));
}

/**
 * 跑一次 v2 判定（网络调用，事务外执行）。
 *
 * 返回 `null` 表示本次判定不可用（模型/输出失败），与 v1 的 null 语义一致：
 * 调用方把公司计为未判定，绝不静默产出 verdict。控制面/预算错误照旧上抛。
 * 模型拒答按 fail-safe 归一为 UNKNOWN（Lead 投影 weak），并记录 MODEL_REFUSAL。
 */
export async function judgeFitV2(
  gateway: ModelGateway,
  workspaceId: string,
  icpBrief: IcpBrief | Record<string, never>,
  company: FitJudgeCompany,
  opts: JudgeFitV2Options = {},
): Promise<FitJudgmentV2 | null> {
  const contract = getTask('discovery.qualify_fit')!;
  const now = opts.now ?? new Date().toISOString();
  const { facts, snapshotText } = buildCompanySnapshot(company);
  const prompt = buildJudgePrompt({
    icpBrief: JSON.stringify(icpBrief, null, 2),
    companySnapshot: snapshotText,
  });
  const inputDigest = judgmentInputDigest({ icpBrief, companySnapshot: facts });

  let rawResult: RuntimeStructuredModelResult<JudgeOutputV2>;
  try {
    rawResult = await executeSkillWithRuntime<JudgeOutputV2>(
      opts.skills ?? STATIC_SKILL_RESOLVER,
      gateway,
      'discovery.qualify_fit',
      {
        task: contract.id,
        prompt: prompt.user,
        system: prompt.system,
        model: contract.model,
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
      `[judge-v2] model call failed for ${company.id}: ${failureCodeOf(error)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }

  const validation = validateJudgeOutputV2(rawResult.data);
  if (!validation.ok) {
    // schema 校验失败按失败码 OUTPUT_SCHEMA_INVALID 处理（retryable，交由上游重试）。
    console.warn(
      `[judge-v2] OUTPUT_SCHEMA_INVALID for ${company.id}: ${validation.errors.slice(0, 5).join('; ')}`,
    );
    return null;
  }
  const output = validation.value;

  const evidence = validateEvidence(output.criteria, {
    now,
    snapshotFetchedAt: opts.snapshotFetchedAt ?? snapshotFetchedAtFromCompany(company, now),
    snapshotText,
    urlPolicy: opts.urlPolicy ?? companyDomainEvidenceUrlPolicy(company.domain),
  });
  const aggregation = aggregateJudgment({ output, evidence });

  const refusal = output.refusal.is_refusal;
  const judgment = toFitJudgment(output, aggregation, {
    refusalReason: refusal ? output.refusal.reason ?? '未给出原因' : null,
  });
  // 拒答不是证据不足，也不能被当成 NOT_FIT 自动拒绝（v1 同款 fail-safe）：一律 weak。
  if (refusal) judgment.verdict = 'weak';

  const micros = costMicrosOf(rawResult.usage);
  const record: JudgmentRecordDraft = {
    workspaceId,
    companyId: company.id,
    judgeLevel: 2,
    verdict: refusal ? 'UNKNOWN' : aggregation.verdict,
    verdictProposed: output.verdict_proposed,
    criteria: buildRecordedCriteria(output),
    evidenceCompleteness: output.evidence_completeness,
    rubricVersion: prompt.rubricVersion,
    promptHash: prompt.promptHash,
    schemaVersion: prompt.schemaVersion,
    inputDigest,
    outputDigest: judgmentOutputDigest(output.criteria),
    model: {
      requested: contract.model,
      resolved: rawResult.runtimeExecution?.gatewayResolvedModel ?? rawResult.model ?? null,
      reported: rawResult.reportedModel ?? null,
    },
    // 本次实际执行是单次采样；k=3 面板属于 L3（未接线），k 必须按事实记 1。
    sampling: {
      temperature: RUBRIC_SAMPLING.temperature,
      k: 1,
    } as Prisma.InputJsonValue,
    ...(refusal ? { failure: { code: 'MODEL_REFUSAL' as const } } : {}),
    ...(rawResult.usage?.inputTokens !== undefined
      ? { inputTokens: rawResult.usage.inputTokens }
      : {}),
    ...(rawResult.usage?.outputTokens !== undefined
      ? { outputTokens: rawResult.usage.outputTokens }
      : {}),
    ...(micros !== null ? { costMicros: micros } : {}),
  };

  return { ...judgment, judgmentRecord: record };
}
