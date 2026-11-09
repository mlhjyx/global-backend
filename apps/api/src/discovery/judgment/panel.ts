/**
 * borderline 三模型判定面板（P3 J12；设计 §4.3.3.6 L3 与 §4.3.9 J12）。
 *
 * 只在 v2 判定「聚合为 UNKNOWN 且加权分落在 borderline 带（3.5 < score < 7.0，
 * 且不是证据门/注入导致）」时触发：对同一输入依次调用三个不同家族的模型
 * （`JUDGE_PANEL_MODELS`，全部必须在 `JUDGE_MODEL_ALLOWLIST` 内），逐模型复用
 * `judge-run.ts` 的同一 prompt / judge-output/v2 / 证据校验 / 确定性聚合。
 *
 * 多数票：≥2/3 一致 → 该 verdict；无多数（含 1/1/1、UNKNOWN 混杂）→ UNKNOWN。
 * 拒答模型票记 UNKNOWN 且计入；某模型调用失败（非控制面）记 UNKNOWN 票并继续。
 * 预算/控制面错误显性上抛（`judge-run.ts` 的 isFatalJudgeError，与 v1 同语义）。
 *
 * 记录：每模型一行 `judgment_record`（judge_level=3、model_* 三列如实、sampling.k=1、
 * 成本逐模型记账），最后写一行汇总（model_requested='panel'、verdict=多数票）。
 * replay key 不含 model 列（见迁移中的 `judgment_record_replay_key`），因此
 * `attempt` 在这里承担「面板槽位」语义：1..3 = 三个模型槽，4 = 汇总行；
 * 同一输入的面板重放会幂等命中同一槽位（attempt 递增区分同模型多票不需要——
 * 每模型一行、k=1）。
 *
 * 开关 `JUDGE_PANEL_MODE=off|shadow|enforce`（缺省 off，非法值按 off）：
 *  - off：不触发（生产缺省，off/off 与旧路径逐字一致）；
 *  - shadow：触发时跑面板、写记录，不改变判定结果（Lead 不受影响）；
 *  - enforce：用面板多数票替代该情形的 v2 verdict。
 * 面板只在 v2 路径（JUDGE_CONTRACT_MODE=shadow/enforce）内接线，contract=off 永远不触发。
 */

import {
  aggregationRulesSnapshot,
  type AggregationResult,
  type JudgmentVerdict,
} from './aggregate-judgment';
import {
  CRITERION_IDS,
  RUBRIC_SAMPLING,
} from './fit-rubric';
import type { FailureCode } from './failure-codes';
import {
  buildJudgeRecordDraft,
  costMicrosOf,
  runJudgeModel,
  type JudgeModelCallOptions,
  type JudgeModelRun,
  type PreparedJudgeCall,
} from './judge-run';
import type { JudgeCriterionOutput } from './judge-output-v2';
import {
  buildRecordedCriteria,
  type JudgmentRecordDraft,
} from './judgment-record';
import type { ModelGateway } from '../../model-gateway/model-gateway';
import {
  isJudgeModelAllowlisted,
  JUDGE_MODEL_ALLOWLIST,
} from '../../ai-tasks/judge-model-routing';

export const PANEL_VERSION = 'judge-panel/v1' as const;

export const JUDGE_PANEL_MODES = ['off', 'shadow', 'enforce'] as const;
export type JudgePanelMode = (typeof JUDGE_PANEL_MODES)[number];

/**
 * 面板模型清单：三个不同家族，全部来自 JUDGE_MODEL_ALLOWLIST（未过金标校准的
 * 模型不得进入——`assertJudgePanelModels` 运行时 fail-closed，单测同时钉死）。
 * gpt-5.6-sol 的生命科学域拒答风险由「拒答 = UNKNOWN 票」吸收，不改变多数票语义。
 */
export const JUDGE_PANEL_MODELS = Object.freeze([
  'deepseek-v4-pro',
  'gemini-4-argon-high',
  'gpt-5.6-sol',
] as const);

/** 汇总行的 attempt（= 面板槽位之后的固定槽，见文件头注释）。 */
export const PANEL_SUMMARY_ATTEMPT = JUDGE_PANEL_MODELS.length + 1;

/** 汇总行的 model_requested 占位（schema 对 model_requested 无闭集约束）。 */
export const PANEL_MODEL_REQUESTED = 'panel';

/**
 * 面板开关（设计 §4.3.3.6）。默认 `off`；非法值按 `off` 处理
 * （fail-safe 到既有行为，绝不因拼写错误改变生产判定）。
 * 与 JUDGE_CONTRACT_MODE 一样是运行期灰度，不分支 app environment，
 * 不产生 ENVIRONMENT_BRANCH finding，也不登记 configuration_allowlist。
 */
export function judgePanelMode(
  env: { readonly [key: string]: string | undefined } = process.env,
): JudgePanelMode {
  const raw = (env.JUDGE_PANEL_MODE ?? '').trim().toLowerCase();
  return (JUDGE_PANEL_MODES as readonly string[]).includes(raw)
    ? (raw as JudgePanelMode)
    : 'off';
}

export class JudgePanelConfigurationError extends Error {
  readonly code = 'JUDGE_PANEL_CONFIGURATION_INVALID';
  constructor(detail: string) {
    super(`JUDGE_PANEL_CONFIGURATION_INVALID: ${detail}`);
    this.name = 'JudgePanelConfigurationError';
  }
}

/** 面板模型必须全部在白名单内且互不相同（fail-closed，启动/调用时校验）。 */
export function assertJudgePanelModels(
  models: readonly string[] = JUDGE_PANEL_MODELS,
): void {
  const seen = new Set<string>();
  for (const model of models) {
    if (!isJudgeModelAllowlisted(model)) {
      throw new JudgePanelConfigurationError(
        `${model} is not on JUDGE_MODEL_ALLOWLIST (${JUDGE_MODEL_ALLOWLIST.join(', ')})`,
      );
    }
    if (seen.has(model)) {
      throw new JudgePanelConfigurationError(`duplicate panel model ${model}`);
    }
    seen.add(model);
  }
}

/**
 * 面板触发条件（设计 §4.3.3.6 L3「L2 的 borderline 集」）：
 *  - 聚合 verdict 为 UNKNOWN 且拿到加权分；
 *  - 加权分严格落在 (3.5, 7.0)（阈值取聚合器快照，禁止在这里另写数字）；
 *  - 原因码恰为 BORDERLINE_UNKNOWN，且不是证据门/注入/硬失败导致。
 * 模型拒答由调用方先行排除（拒答不是「模型不确定」，不叠面板）。
 */
export function isBorderlinePanelTrigger(aggregation: AggregationResult): boolean {
  if (aggregation.verdict !== 'UNKNOWN') return false;
  if (aggregation.scoreWeighted === null) return false;
  const { fitMinWeighted, notFitMaxWeighted } = aggregationRulesSnapshot();
  if (
    !(
      aggregation.scoreWeighted > notFitMaxWeighted &&
      aggregation.scoreWeighted < fitMinWeighted
    )
  ) {
    return false;
  }
  if (!aggregation.reasonCodes.includes('BORDERLINE_UNKNOWN')) return false;
  if (aggregation.reasonCodes.includes('EVIDENCE_GATE_UNKNOWN')) return false;
  if (aggregation.reasonCodes.includes('PROMPT_INJECTION_DETECTED')) return false;
  if (
    aggregation.gates.hardFail ||
    aggregation.gates.evidenceGate ||
    aggregation.gates.injection.length > 0
  ) {
    return false;
  }
  return true;
}

export interface PanelVote {
  failureCode?: FailureCode;
  model: string;
  /** 模型调用是否成功产出合法 judge-output（false 时为失败票）。 */
  ok: boolean;
  verdict: JudgmentVerdict;
}

export interface JudgePanelResult {
  /**
   * 达到 2/3 的 verdict；无多数为 null。两票以上 UNKNOWN（如双拒答）时
   * majority='UNKNOWN'，最终 verdict 同样是 UNKNOWN——两者语义等价。
   */
  majority: JudgmentVerdict | null;
  /** 逐模型记录（槽位 1..3）+ 汇总行（最后一行），全部待调用方补 icpId 后落库。 */
  records: JudgmentRecordDraft[];
  /** 代表模型（多数派第一个成功模型；UNKNOWN 时为第一个成功模型）用于理由/汇总 criteria。 */
  representative: Extract<JudgeModelRun, { ok: true }> | null;
  verdict: JudgmentVerdict;
  votes: PanelVote[];
}

export interface JudgePanelOptions extends JudgeModelCallOptions {
  companyId: string;
}

/**
 * 进程内单次护栏（与 shadow v2 同款）：同一 run（缺省 workspace）+ 公司只跑一次面板，
 * 活动重试/同 run 重复判定不再重复付费。容量上限防无限增长。
 */
const PANEL_SEEN = new Set<string>();
const PANEL_SEEN_LIMIT = 4096;

function panelAlreadyRan(key: string): boolean {
  if (PANEL_SEEN.has(key)) return true;
  if (PANEL_SEEN.size >= PANEL_SEEN_LIMIT) PANEL_SEEN.clear();
  PANEL_SEEN.add(key);
  return false;
}

/** 失败/拒答模型的占位 criteria（记录 schema 要求恰好 5 项；不伪造分数）。 */
export function panelFailureCriteria(
  code: FailureCode,
): JudgeCriterionOutput[] {
  return CRITERION_IDS.map((id) => ({
    id,
    applicable: true,
    score: null,
    label: 'unclear' as const,
    evidence: [],
    rationale: `panel: model call unavailable (${code})`,
  }));
}

function voteOf(model: string, run: JudgeModelRun): PanelVote {
  if (!run.ok) {
    return { model, ok: false, verdict: 'UNKNOWN', failureCode: run.failureCode };
  }
  // 拒答票记 UNKNOWN 且计入（fail-safe：不把拒答当 NOT_FIT）。
  return { model, ok: true, verdict: run.refusal ? 'UNKNOWN' : run.aggregation.verdict };
}

function tally(votes: readonly PanelVote[]): {
  majority: JudgmentVerdict | null;
  verdict: JudgmentVerdict;
} {
  const counts = new Map<JudgmentVerdict, number>();
  for (const vote of votes) {
    counts.set(vote.verdict, (counts.get(vote.verdict) ?? 0) + 1);
  }
  let majority: JudgmentVerdict | null = null;
  for (const [verdict, count] of counts) {
    if (count >= 2) majority = verdict;
  }
  return { majority, verdict: majority ?? 'UNKNOWN' };
}

/**
 * 跑一次 borderline 面板（网络调用，事务外执行）。已在本进程跑过（run+company）时
 * 返回 null（调用方不附加任何记录）。控制面/预算错误照旧上抛。
 */
export async function judgeFitPanel(
  gateway: ModelGateway,
  workspaceId: string,
  prepared: PreparedJudgeCall,
  opts: JudgePanelOptions,
): Promise<JudgePanelResult | null> {
  assertJudgePanelModels();
  const key = `${opts.runId ?? workspaceId}:${prepared.companyId}`;
  if (panelAlreadyRan(key)) return null;

  // 逐模型依次调用（非并行）：预算错误可在第一个模型处停止，记账确定性更好。
  const runs: JudgeModelRun[] = [];
  const votes: PanelVote[] = [];
  for (const model of JUDGE_PANEL_MODELS) {
    const run = await runJudgeModel(gateway, workspaceId, model, prepared, opts);
    runs.push(run);
    votes.push(voteOf(model, run));
  }

  const { majority, verdict } = tally(votes);

  const records: JudgmentRecordDraft[] = JUDGE_PANEL_MODELS.map((model, index) => {
    const run = runs[index]!;
    const usage = run.raw?.usage;
    const micros = costMicrosOf(usage);
    const failure = run.ok
      ? (run.refusal ? { code: 'MODEL_REFUSAL' as const } : null)
      : { code: run.failureCode };
    return buildJudgeRecordDraft({
      workspaceId,
      companyId: prepared.companyId,
      judgeLevel: 3,
      // replay key 不含 model 列：attempt 即面板槽位（1..3），重放幂等命中同一槽位。
      attempt: index + 1,
      verdict: votes[index]!.verdict,
      verdictProposed: run.ok ? run.output.verdict_proposed : null,
      criteria: run.ok
        ? buildRecordedCriteria(run.output)
        : panelFailureCriteria(run.failureCode),
      evidenceCompleteness: run.ok ? run.output.evidence_completeness : false,
      prompt: prepared.prompt,
      inputDigest: prepared.inputDigest,
      model: {
        requested: model,
        resolved: run.raw?.runtimeExecution?.gatewayResolvedModel ?? run.raw?.model ?? null,
        reported: run.raw?.reportedModel ?? null,
      },
      // 单模型单次采样（k=1）；面板的多票由多条记录承担，不在这里写 k=3。
      sampling: {
        temperature: RUBRIC_SAMPLING.temperature,
        k: 1,
      },
      ...(failure ? { failure } : {}),
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(micros !== null ? { costMicros: micros } : {}),
    });
  });

  const successfulRuns = runs
    .map((run, index) => ({ run, index }))
    .filter(
      (entry): entry is { run: Extract<JudgeModelRun, { ok: true }>; index: number } =>
        entry.run.ok,
    );
  const representative =
    verdict === 'UNKNOWN'
      ? (successfulRuns[0]?.run ?? null)
      : (successfulRuns.find((entry) => votes[entry.index]!.verdict === verdict)?.run ??
        successfulRuns[0]?.run ??
        null);

  const fallbackCode =
    votes.find((vote) => vote.failureCode !== undefined)?.failureCode ??
    'UNKNOWN_UPSTREAM';
  const summaryCriteria = representative
    ? buildRecordedCriteria(representative.output)
    : panelFailureCriteria(fallbackCode);

  // 汇总行：model_requested='panel'；成本不重复记账（逐模型行已各记各的）。
  records.push(
    buildJudgeRecordDraft({
      workspaceId,
      companyId: prepared.companyId,
      judgeLevel: 3,
      attempt: PANEL_SUMMARY_ATTEMPT,
      verdict,
      verdictProposed: null,
      criteria: summaryCriteria,
      evidenceCompleteness: representative
        ? representative.output.evidence_completeness
        : false,
      prompt: prepared.prompt,
      inputDigest: prepared.inputDigest,
      model: { requested: PANEL_MODEL_REQUESTED, resolved: null, reported: null },
      sampling: {
        temperature: RUBRIC_SAMPLING.temperature,
        k: 1,
        panelVersion: PANEL_VERSION,
        votes: votes.map((vote) => ({
          model: vote.model,
          verdict: vote.verdict,
          ...(vote.failureCode ? { failureCode: vote.failureCode } : {}),
        })),
      },
    }),
  );

  return { votes, majority, verdict, representative, records };
}
