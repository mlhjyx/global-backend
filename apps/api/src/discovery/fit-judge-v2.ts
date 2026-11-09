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
 *
 * P3 J12：单模型执行器已抽到 `judgment/judge-run.ts`（面板共用）。本模块在 v2 聚合
 * 结果为 borderline UNKNOWN 时按 `JUDGE_PANEL_MODE` 触发三模型面板：
 *  - shadow：跑面板、附逐模型 + 汇总记录（观察，不改 verdict/Lead）；
 *  - enforce：用面板多数票替代该情形的 verdict；
 *  - off（缺省）：不触发，行为与 J03b 完全一致。面板只在 v2 路径生效
 *    （JUDGE_CONTRACT_MODE=off 时本模块不执行，任何面板取值都不生效）。
 */

import type { ModelGateway } from '../model-gateway/model-gateway';
import { getTask } from '../ai-tasks/task-registry';
import {
  type AggregationResult,
  type JudgmentVerdict,
} from './judgment/aggregate-judgment';
import { RUBRIC_SAMPLING } from './judgment/fit-rubric';
import {
  type JudgeCriterionOutput,
  type JudgeOutputV2,
} from './judgment/judge-output-v2';
import {
  buildJudgeRecordDraft,
  buildCompanySnapshot,
  companyDomainEvidenceUrlPolicy,
  costMicrosOf,
  prepareJudgeCall,
  runJudgeModel,
  type PrepareJudgeCallOptions,
} from './judgment/judge-run';
import {
  isBorderlinePanelTrigger,
  judgeFitPanel,
  judgePanelMode,
  PANEL_VERSION,
  type JudgePanelMode,
  type JudgePanelResult,
} from './judgment/panel';
import {
  buildRecordedCriteria,
  type JudgmentRecordDraft,
} from './judgment/judgment-record';
import type { RuntimeTelemetry } from '../model-runtime/types';
import type { SkillResolver } from '../skills/skill-runtime';
import type { FitJudgeCompany, FitJudgment, IcpBrief } from './fit-judge';
import type { Prisma } from '@prisma/client';
import {
  enforceCorroboration,
  judgeCorroborationMode,
  type JudgeCorroborationMode,
} from './judgment/corroboration';
import { currentEvidenceBundle, type EvidenceBundle } from './evidence-bundle';

export { buildCompanySnapshot, companyDomainEvidenceUrlPolicy };
export type { JudgmentRecordDraft };

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

export interface JudgeFitV2Options extends PrepareJudgeCallOptions {
  runId?: string;
  runtimeTelemetry?: RuntimeTelemetry;
  authorizeExternalAction?: () => Promise<boolean>;
  skills?: SkillResolver;
  /**
   * P3 J12：面板开关覆盖（缺省读 JUDGE_PANEL_MODE；测试显式注入）。
   * 仅在 v2 路径内生效；contract=off 时本模块不执行，面板自然不触发。
   */
  judgePanelMode?: JudgePanelMode;
  /** 跨源佐证门开关覆盖（缺省读 JUDGE_CORROBORATION_MODE，默认 enforce；测试显式注入）。 */
  judgeCorroborationMode?: JudgeCorroborationMode;
}

/** v2 判定结果：FitJudgment 形状 + 待持久化的 judgment_record 草稿 + 判定时证据包。 */
export interface FitJudgmentV2 extends FitJudgment {
  judgmentRecord: JudgmentRecordDraft;
  /** 判定时按当前属性现场装配的跨源证据包（随判定记录同事务写回 canonical attributes）。 */
  evidenceBundle?: EvidenceBundle;
}

const VERDICT_TO_LEAD: Readonly<Record<JudgmentVerdict, FitJudgment['verdict']>> = Object.freeze({
  FIT: 'match',
  UNKNOWN: 'weak',
  NOT_FIT: 'mismatch',
});

function criterionById(
  output: JudgeOutputV2,
  id: JudgeCriterionOutput['id'],
): JudgeCriterionOutput {
  const criterion = output.criteria.find((item) => item.id === id);
  // validateJudgeOutputV2 已保证恰好 5 项且 id 无重复；缺失属编程错误。
  // 静态消息：execution-control-error.static.spec 禁止共享边界构造动态 Error。
  if (!criterion) {
    throw new Error('judge-v2: judge output is missing a criterion (validation bypassed)', {
      cause: id,
    });
  }
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

function votesLine(
  votes: ReadonlyArray<{ failureCode?: string; model: string; verdict: JudgmentVerdict }>,
): string {
  const parts = votes.map(
    (vote) =>
      `${vote.model}=${vote.verdict}${vote.failureCode ? `(${vote.failureCode})` : ''}`,
  );
  return `面板 ${PANEL_VERSION} 多数票：${parts.join('，')}`;
}

/** enforce 面板：用多数票替代 borderline UNKNOWN 的 verdict 与理由（记录不变）。 */
function applyPanelVerdict(target: FitJudgment, panel: JudgePanelResult): void {
  const line = votesLine(panel.votes);
  if (panel.verdict !== 'UNKNOWN' && panel.representative) {
    const rep = panel.representative;
    const repJudgment = toFitJudgment(rep.output, rep.aggregation);
    target.verdict = repJudgment.verdict;
    target.fitReasons = {
      ...repJudgment.fitReasons,
      reasons: [...repJudgment.fitReasons.reasons, line].slice(0, 16),
    };
    return;
  }
  // 无多数（含 1/1/1、UNKNOWN 混杂）：保持 UNKNOWN→weak，只补充面板票型说明。
  target.verdict = VERDICT_TO_LEAD[panel.verdict];
  target.fitReasons = {
    ...target.fitReasons,
    reasons: [...target.fitReasons.reasons, line].slice(0, 16),
  };
}

/**
 * 跨源佐证门（enforce 默认）：对结论类判定（match/mismatch）按证据包分层评估；不足则原地
 * 降级 judgment.verdict=weak、record.verdict=UNKNOWN（verdictProposed 保留原判定），并把
 * 评估/降级记录并入 record.sampling.corroboration。返回判定时装配的证据包（off 时为 undefined）。
 */
function applyCrossSourceGate(args: {
  judgment: FitJudgment;
  record: JudgmentRecordDraft;
  company: FitJudgeCompany;
  mode?: JudgeCorroborationMode;
}): { evidenceBundle?: EvidenceBundle } {
  const mode = args.mode ?? judgeCorroborationMode();
  if (mode === 'off') return {};
  // 判定时现场装配（零出网）：本 run 已写回的 website_profile / 富集命名空间都在属性里。
  const bundle = currentEvidenceBundle({
    name: args.company.name,
    domain: args.company.domain,
    country: args.company.country,
    attributes: args.company.attributes,
  });
  const enforcement = enforceCorroboration({ verdict: args.judgment.verdict, bundle, mode });
  if (!enforcement.record.requires_corroboration) return { evidenceBundle: bundle };
  const baseSampling =
    args.record.sampling !== null && typeof args.record.sampling === 'object' && !Array.isArray(args.record.sampling)
      ? (args.record.sampling as Record<string, unknown>)
      : {};
  args.record.sampling = {
    ...baseSampling,
    corroboration: enforcement.record,
  } as unknown as Prisma.InputJsonValue;
  if (enforcement.downgraded) {
    args.judgment.verdict = 'weak';
    args.record.verdict = 'UNKNOWN';
    args.record.verdictProposed =
      (args.record.verdictProposed ??
        (enforcement.record.downgraded_from as JudgmentRecordDraft['verdictProposed'])) ?? null;
    if (enforcement.reasonLine) {
      args.judgment.fitReasons = {
        ...args.judgment.fitReasons,
        reasons: [enforcement.reasonLine, ...args.judgment.fitReasons.reasons].slice(0, 16),
      };
    }
  }
  return { evidenceBundle: bundle };
}

/**
 * 跑一次 v2 判定（网络调用，事务外执行）。
 *
 * 返回 `null` 表示本次判定不可用（模型/输出失败），与 v1 的 null 语义一致：
 * 调用方把公司计为未判定，绝不静默产出 verdict。控制面/预算错误照旧上抛。
 * 模型拒答按 fail-safe 归一为 UNKNOWN（Lead 投影 weak），并记录 MODEL_REFUSAL。
 *
 * P3 J12：borderline UNKNOWN（且非拒答/证据门/注入）时按 `judgePanelMode` 跑面板；
 * 面板记录附在 `judgmentRecords`（逐模型槽位 1..3 + 汇总行），enforce 下替代 verdict。
 */
export async function judgeFitV2(
  gateway: ModelGateway,
  workspaceId: string,
  icpBrief: IcpBrief | Record<string, never>,
  company: FitJudgeCompany,
  opts: JudgeFitV2Options = {},
): Promise<FitJudgmentV2 | null> {
  const contract = getTask('discovery.qualify_fit')!;
  const prepared = prepareJudgeCall(icpBrief, company, opts);
  const run = await runJudgeModel(gateway, workspaceId, contract.model, prepared, opts);
  if (!run.ok) return null;
  const { output, aggregation, refusal, raw } = run;

  const judgment = toFitJudgment(output, aggregation, {
    refusalReason: refusal ? output.refusal.reason ?? '未给出原因' : null,
  });
  // 拒答不是证据不足，也不能被当成 NOT_FIT 自动拒绝（v1 同款 fail-safe）：一律 weak。
  if (refusal) judgment.verdict = 'weak';

  const micros = costMicrosOf(raw.usage);
  const record: JudgmentRecordDraft = buildJudgeRecordDraft({
    workspaceId,
    companyId: company.id,
    judgeLevel: 2,
    verdict: refusal ? 'UNKNOWN' : aggregation.verdict,
    verdictProposed: output.verdict_proposed,
    criteria: buildRecordedCriteria(output),
    evidenceCompleteness: output.evidence_completeness,
    prompt: prepared.prompt,
    inputDigest: prepared.inputDigest,
    model: {
      requested: contract.model,
      resolved: raw.runtimeExecution?.gatewayResolvedModel ?? raw.model ?? null,
      reported: raw.reportedModel ?? null,
    },
    // 本次实际执行是单次采样；面板多票属于 L3（judge_level=3 的独立记录），k 按事实记 1。
    sampling: {
      temperature: RUBRIC_SAMPLING.temperature,
      k: 1,
    },
    ...(refusal ? { failure: { code: 'MODEL_REFUSAL' as const } } : {}),
    ...(raw.usage?.inputTokens !== undefined
      ? { inputTokens: raw.usage.inputTokens }
      : {}),
    ...(raw.usage?.outputTokens !== undefined
      ? { outputTokens: raw.usage.outputTokens }
      : {}),
    ...(micros !== null ? { costMicros: micros } : {}),
  });

  // P3 J12：borderline 面板（仅 v2 路径；拒答不叠面板——拒答不是「模型不确定」）。
  const panelMode = opts.judgePanelMode ?? judgePanelMode();
  let panelRecords: JudgmentRecordDraft[] | undefined;
  let panelTolerant: boolean | undefined;
  if (panelMode !== 'off' && !refusal && isBorderlinePanelTrigger(aggregation)) {
    const panel = await judgeFitPanel(gateway, workspaceId, prepared, {
      companyId: company.id,
      runId: opts.runId,
      runtimeTelemetry: opts.runtimeTelemetry,
      authorizeExternalAction: opts.authorizeExternalAction,
      skills: opts.skills,
    });
    if (panel) {
      panelRecords = panel.records;
      // shadow 面板是观察：记录写入失败不得回滚 Lead（enforce 面板记录为判定依据，严格落库）。
      panelTolerant = panelMode === 'shadow';
      if (panelMode === 'enforce') applyPanelVerdict(judgment, panel);
    }
  }

  // 跨源佐证门（2026-11-10，默认 enforce）：结论类判定须 ≥2 个独立来源分层支撑；
  // 不足则 fail-closed 降级 UNKNOWN（Lead 投影 weak/待复核）。
  // 回滚：JUDGE_CORROBORATION_MODE=shadow（只记录）或 off（完全关闭）。
  const gateFields = applyCrossSourceGate({
    judgment,
    record,
    company,
    mode: opts.judgeCorroborationMode,
  });

  return {
    ...judgment,
    judgmentRecord: record,
    ...gateFields,
    ...(panelRecords ? { judgmentRecords: panelRecords } : {}),
    ...(panelTolerant ? { judgmentRecordsTolerant: true } : {}),
  };
}
