import { Prisma } from '@prisma/client';
import { ModelGateway } from '../model-gateway/model-gateway';
import { getTask } from '../ai-tasks/task-registry';
import { BudgetExceededError, BudgetOperationReplayError } from '../tools/budget-store';
import type { RuntimeTelemetry } from '../model-runtime/types';
import {
  executeSkillWithRuntime,
  SkillUnavailableError,
  STATIC_SKILL_RESOLVER,
  type SkillResolver,
} from '../skills/skill-runtime';
import { isExecutionControlError } from '../execution-budget/execution-control-error';
import { applyDomainAckConsumerTransaction } from '../durable-results/domain-ack-consumer-bindings';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';
import { icpTradeRole } from './icp-trade-role';
import type { EvidenceUrlPolicy } from './judgment/evidence-validate';
import type { TradeRole } from './search-localization';
import {
  judgeContractMode,
  judgeFitV2,
  type JudgeContractMode,
  type JudgmentRecordDraft,
} from './fit-judge-v2';
import type { JudgePanelMode } from './judgment/panel';
import { recordJudgment } from './judgment/judgment-record';
import { enforceCorroboration, judgeCorroborationMode } from './judgment/corroboration';
import { loadCompanyForSuppressionSafeWrite } from './company-suppression-gate';
import {
  crossSourceEvidenceSummary,
  currentEvidenceBundle,
  type EvidenceBundle,
} from './evidence-bundle';

/**
 * ICP 资格门（四门判别：材质/角色/工艺/商业模式）的共享核心 ——
 * 被两条路径复用：qualifyFitForRun（本 run 增量）与 qualifyFitBacklog（存量对账，
 * 解锁投影进来的、从不属于任何 run 的公司）。判定语义必须一致，故抽出。
 */

export interface IcpBrief {
  seller: string;
  seller_summary: string | null;
  icp_name?: string;
  /** Deterministic ICP trade role (design §4 step 8); the judge's role and business-model gates follow it. */
  icp_trade_role?: TradeRole | null;
  company_attributes?: unknown;
  exclusions?: unknown;
  target_markets?: unknown;
}

export interface FitJudgeCompany {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  industry: string | null;
  attributes: unknown;
}

export interface FitJudgment {
  verdict: 'match' | 'weak' | 'mismatch';
  fitReasons: {
    material: string;
    role: string;
    process: string;
    business_model: string;
    reasons: string[];
  };
  durableReceipt?: DurableExecutionReceipt;
  /**
   * P3 J07：L0 制裁门判定该公司时名单陈旧（yellow/red）。不改变 verdict（stale 是
   * PASS 的降级标记），由 upsertLeadFit 写进 lead.fitReasons JSON；「禁止推荐/导出」
   * 的执行归 J20 面板。G1 命中（FAIL）不会带此标记——命中的公司在门链就拦截了。
   */
  sanctionsStale?: 'yellow' | 'red';
  /**
   * P3 J03b：v2 判定（JUDGE_CONTRACT_MODE=shadow/enforce）产生的 judgment_record 草稿。
   * 调用方必须在写入 Lead 投影的同一个 `prisma.withWorkspace` 事务里先
   * `persistJudgmentRecordInTransaction`（= recordJudgment 唯一写入口）。
   */
  judgmentRecord?: JudgmentRecordDraft;
  /**
   * P3 J12：面板附加记录（judge_level=3 的逐模型槽位 1..3 + 汇总行），顺序固定。
   * 与 judgmentRecord 一起由 `persistJudgmentRecordInTransaction` 顺序写入。
   */
  judgmentRecords?: JudgmentRecordDraft[];
  /**
   * shadow 模式的记录写入是「附加观测」：写入失败不得影响 Lead 投影（enforce 下不设此标记）。
   */
  judgmentRecordTolerant?: boolean;
  /**
   * P3 J12：面板附加记录本身是观察（JUDGE_PANEL_MODE=shadow）时的写入容忍标记；
   * 只作用于 judgmentRecords，不影响判定主记录。
   */
  judgmentRecordsTolerant?: boolean;
  /**
   * 判定时的跨源证据包（2026-11-10 多源证据图）：由判定链现场装配，随判定记录在同一
   * 事务内写回 `canonical_company.attributes.evidence_bundle`（审计/离线复核面）。
   */
  evidenceBundle?: EvidenceBundle;
}

interface FitOutput {
  verdict: string;
  material_gate: string;
  role_gate: string;
  process_gate: string;
  business_model_gate: string;
  reasons: string[];
}

/**
 * 资格门判定 → **Lead(workspace × icp × company)** 落库（CandidateAssessment）。两条判定路径共享
 * （qualifyFitForRun 增量 + qualifyFitBacklog 存量），语义与写法必须一致，故抽出。
 *  - fit 挂 Lead 而非 canonical：同 workspace 多 ICP 各自独立判、互不覆盖（本次重构的根因修复）。
 *  - 只写 fit 判定；scores/status 由评分阶段负责，此处不覆盖（幂等：重判只刷 verdict + version）。
 *  - 首判即建行：status 用 schema 默认（DISCOVERED），尚无 scores；queue 按 verdict 映射初始值
 *    （mismatch→rejected，其余→needs_review）——否则评分跑完前的窗口里，明确不匹配的公司会挂在
 *    人工待审队列误导使用者。评分阶段会按六维总分重算覆盖 queue。
 */
export async function upsertLeadFit(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  icpId: string,
  canonicalCompanyId: string,
  judgment: FitJudgment,
): Promise<void> {
  // P3 J07：stale 标记随 fitReasons 落库（lead.fitReasons JSON），供 J20 面板禁止推荐/导出。
  const fitReasons = (
    judgment.sanctionsStale
      ? { ...judgment.fitReasons, sanctionsStale: judgment.sanctionsStale }
      : judgment.fitReasons
  ) as unknown as Prisma.InputJsonValue;
  await applyDomainAckConsumerTransaction({
    transaction: tx,
    producerId: 'discovery.qualify_fit',
    receipt: judgment.durableReceipt,
    domainAckKey: `${workspaceId}:${icpId}:${canonicalCompanyId}`,
    domainRevision: judgment.durableReceipt?.resultDigest ?? judgment.verdict,
    apply: (transaction) => transaction.lead.upsert({
    where: { workspaceId_icpId_canonicalCompanyId: { workspaceId, icpId, canonicalCompanyId,
      },
    },
    update: {
      fitVerdict: judgment.verdict,
      fitReasons,
      version: { increment: 1 },
    },
    create: {
      workspaceId,
      icpId,
      canonicalCompanyId,
      fitVerdict: judgment.verdict,
      fitReasons,
      queue: judgment.verdict === 'mismatch' ? 'rejected' : 'needs_review',
    },
  }),
  });
}

/**
 * P3 J03b：把 v2 判定草稿写入 `judgment_record`（recordJudgment 唯一写入口）。
 * 必须与 Lead 投影（`upsertLeadFit`）在同一个 `prisma.withWorkspace` 事务里调用，
 * 顺序为先 record 后 Lead（设计 §4.3.4.4）。off 模式无草稿时是 no-op。
 * shadow 的草稿带 `judgmentRecordTolerant`：写入失败只记日志，不影响 Lead。
 *
 * P3 J12：面板场景一次判定有多条记录（主记录 + 逐模型 + 汇总行），按
 * 主记录 → 面板槽位 1..3 → 汇总行的固定顺序写入。`judgmentRecordsTolerant`
 * 表示面板记录是观察（JUDGE_PANEL_MODE=shadow），其写入失败同样只记日志，
 * 不回滚 Lead；判定主记录的严格性不受影响。
 */
export async function persistJudgmentRecordInTransaction(
  tx: Prisma.TransactionClient,
  icpId: string,
  judgment: FitJudgment,
): Promise<void> {
  const records: JudgmentRecordDraft[] = [
    ...(judgment.judgmentRecord ? [judgment.judgmentRecord] : []),
    ...(judgment.judgmentRecords ?? []),
  ];
  // 证据包随判定同事务写回（enforce 门的审计面）。失败照常上抛：同事务里语句级错误会
  // 中止整个事务（catch 也无法恢复），与其半吞不如让判定失败并可重试——fail-closed。
  if (judgment.evidenceBundle && judgment.judgmentRecord) {
    await persistEvidenceBundle(
      tx,
      judgment.judgmentRecord.workspaceId,
      judgment.judgmentRecord.companyId,
      judgment.evidenceBundle,
    );
  }
  if (records.length === 0) return;
  for (const [index, record] of records.entries()) {
    const tolerant =
      judgment.judgmentRecordTolerant === true ||
      (index > 0 && judgment.judgmentRecordsTolerant === true);
    try {
      await recordJudgment(tx, { ...record, icpId });
    } catch (error) {
      if (!tolerant) throw error;
      console.warn(
        `[judge-v2] shadow record write skipped for ${record.companyId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * 读-改-写当前 attributes，合入 evidence_bundle（其余键原样保留）。
 * 与其它 attributes 写者同一纪律（company-enrichment-commit 先例）：先拿工作区抑制策略锁、
 * 读到的既有属性经过 sanitizer、SUPPRESSED/被抑制的公司绝不写；updateMany 带 status 守卫 +
 * version CAS 并 increment——和 owner 侧回填（backfill-company-normalization 的 version 乐观锁）
 * 互相可见，不会互相覆盖。
 */
async function persistEvidenceBundle(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  companyId: string,
  bundle: EvidenceBundle,
): Promise<void> {
  const current = await loadCompanyForSuppressionSafeWrite(tx, workspaceId, companyId);
  if (!current) return;
  const versionRow = await tx.canonicalCompany.findUnique({
    where: { id: companyId },
    select: { version: true, status: true },
  });
  if (!versionRow || versionRow.status === 'SUPPRESSED') return;
  await tx.canonicalCompany.updateMany({
    where: {
      id: companyId,
      workspaceId,
      status: { not: 'SUPPRESSED' },
      version: versionRow.version,
    },
    data: {
      attributes: { ...current.attributes, evidence_bundle: bundle } as unknown as Prisma.InputJsonValue,
      version: { increment: 1 },
    },
  });
}

/**
 * v1 判定路径的跨源佐证门（JUDGE_CONTRACT_MODE=off 时生效；enforce 下 v2 路径自带门）。
 * 返回降级后的 verdict 与要追加的理由行；shadow 只评估不降级（v1 无判定记录可附）。
 */
function applyCorroborationToV1(
  verdict: FitJudgment['verdict'],
  company: FitJudgeCompany,
): { verdict: FitJudgment['verdict']; reasonLine: string | null } {
  const mode = judgeCorroborationMode();
  if (mode === 'off' || verdict === 'weak') return { verdict, reasonLine: null };
  const enforcement = enforceCorroboration({
    verdict,
    bundle: currentEvidenceBundle(company),
    mode,
  });
  return enforcement.downgraded
    ? { verdict: 'weak', reasonLine: enforcement.reasonLine }
    : { verdict, reasonLine: null };
}

/** 事务内加载 ICP 摘要（供判定 prompt）。ICP 不存在时返回空对象（与既有行为一致）。 */
export async function loadIcpBrief(tx: Prisma.TransactionClient, icpId: string,
): Promise<IcpBrief | Record<string, never>> {
  const icp = await tx.icpDefinition.findUnique({ where: { id: icpId }, include: { company: true },
  });
  if (!icp) return {};
  return {
    seller: icp.company?.name ?? 'unknown',
    seller_summary: icp.company?.summary ?? null,
    icp_name: icp.name,
    icp_trade_role: icpTradeRole(icp.companyAttributes),
    company_attributes: icp.companyAttributes,
    exclusions: icp.exclusions,
    target_markets: icp.targetMarkets,
  };
}

/**
 * 上游模型拒答时（HTTP 200，各门填“本服务不支持……”类拒绝文案，verdict 仍是合法枚举），
 * schema 校验看不出问题。拒答不是证据不足，更不能被当成 mismatch 自动拒绝——2026-11-02 实测：
 * gpt-5.6-sol 对生命科学域 ICP 的 4 次调用拒答 3 次，3 家候选因此被误导为 mismatch 进 rejected。
 * 命中拒答签名 → 按 fail-safe 归一为 weak（needs_review 人工复核），绝不 mismatch。
 * 不在此处自动重试：同一请求材料的 durable 预算操作键相同，重放只会拿回同一份拒答（或撞
 * BudgetOperationReplayError）；真正的解法是换不拒答的模型路由。
 */
const REFUSAL_MARKERS = [
  '本服务不支持',
  '本服务不能',
  '不能协助',
  '无法协助',
  '不支持以中文',
  '不支持主要使用',
  '不构成对',
  '抱歉，本服务',
  '抱歉，我无法',
] as const;

function refusalExcerpt(out: FitOutput): string | null {
  const texts = [
    out.material_gate,
    out.role_gate,
    out.process_gate,
    out.business_model_gate,
    ...(Array.isArray(out.reasons) ? out.reasons : []),
  ].filter((value): value is string => typeof value === 'string');
  for (const text of texts) {
    if (REFUSAL_MARKERS.some((marker) => text.includes(marker))) {
      return text.length > 160 ? `${text.slice(0, 160)}…` : text;
    }
  }
  return null;
}

export function looksLikeModelRefusal(out: FitOutput): boolean {
  return refusalExcerpt(out) !== null;
}

export interface JudgeFitCompanyOptions {
  runId?: string;
  runtimeTelemetry?: RuntimeTelemetry;
  authorizeExternalAction?: () => Promise<boolean>;
  /** S0 技能运行时：生产由 worker 注入 DB resolver；缺省为内置目录直通。 */
  skills?: SkillResolver;
  /** P3 J03b：契约开关覆盖（缺省读 JUDGE_CONTRACT_MODE；测试显式注入）。 */
  judgeContractMode?: JudgeContractMode;
  /** P3 J12：面板开关覆盖（缺省读 JUDGE_PANEL_MODE；测试显式注入）。 */
  judgePanelMode?: JudgePanelMode;
  /** v2 判定时钟与证据域门（测试注入）；见 fit-judge-v2.ts。 */
  now?: string;
  snapshotFetchedAt?: string;
  urlPolicy?: EvidenceUrlPolicy;
}

/**
 * shadow 模式的成本护栏（P3 J03b）：同一 run 内每家最多跑一次 v2。
 * 活动重试/同 run 重复判定不再重复付费；失败也不回退重试。
 * 进程内 Set（worker 单进程执行本 run 的判定）；容量上限防无限增长。
 */
const SHADOW_V2_SEEN = new Set<string>();
const SHADOW_V2_SEEN_LIMIT = 4096;

function shadowV2AlreadyRan(key: string): boolean {
  if (SHADOW_V2_SEEN.has(key)) return true;
  if (SHADOW_V2_SEEN.size >= SHADOW_V2_SEEN_LIMIT) SHADOW_V2_SEEN.clear();
  SHADOW_V2_SEEN.add(key);
  return false;
}

/**
 * 对一家公司跑资格判定（网络调用，事务外执行）。失败返回 null（单家失败不影响其余，§5 fail-safe）。
 * 非法 verdict 归一为 weak（与既有行为一致——宁进人工复核，不误杀/误放）。
 *
 * P3 J03b：按 `JUDGE_CONTRACT_MODE` 分派——
 *  - off（默认）：v1 四门判定，行为与旧路径完全一致；
 *  - shadow：v1 产 Lead，额外跑一次 v2 并附 `judgmentRecord` 草稿（失败只记日志）；
 *  - enforce：只用 v2 的聚合 verdict（FIT→match / UNKNOWN→weak / NOT_FIT→mismatch）。
 */
export async function judgeFitCompany(
  gateway: ModelGateway,
  workspaceId: string,
  icpBrief: IcpBrief | Record<string, never>,
  company: FitJudgeCompany,
  opts?: JudgeFitCompanyOptions,
): Promise<FitJudgment | null> {
  const mode = opts?.judgeContractMode ?? judgeContractMode();
  if (mode === 'enforce') {
    return judgeFitV2(gateway, workspaceId, icpBrief, company, opts);
  }
  const judgment = await judgeFitCompanyV1(gateway, workspaceId, icpBrief, company, opts);
  if (judgment && mode === 'shadow') {
    const key = `${opts?.runId ?? workspaceId}:${company.id}`;
    if (!shadowV2AlreadyRan(key)) {
      try {
        const v2 = await judgeFitV2(gateway, workspaceId, icpBrief, company, opts);
        if (v2) {
          judgment.judgmentRecord = v2.judgmentRecord;
          judgment.judgmentRecords = v2.judgmentRecords;
          judgment.judgmentRecordsTolerant = v2.judgmentRecordsTolerant;
          judgment.judgmentRecordTolerant = true;
          // 采样里的 corroboration 记录声称 enforced 时，证据包也要落库（否则审计面缺一半）。
          if (v2.evidenceBundle) judgment.evidenceBundle = v2.evidenceBundle;
        }
      } catch (error) {
        // shadow 的失败不影响 Lead（含预算/控制面错误）：只记日志。
        console.warn(
          `[judge-v2] shadow failed for ${company.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  return judgment;
}

async function judgeFitCompanyV1(
  gateway: ModelGateway,
  workspaceId: string,
  icpBrief: IcpBrief | Record<string, never>,
  company: FitJudgeCompany,
  opts?: JudgeFitCompanyOptions,
): Promise<FitJudgment | null> {
  const contract = getTask('discovery.qualify_fit')!;
  const attributes = company.attributes as {
    products?: string[];
    keywords?: string[];
    website_profile?: Record<string, unknown>;
  } | null;
  const products = attributes?.products ?? [];
  // Capability keywords carry the reseller evidence a distributor ICP is judged on (Großhandel, Vertrieb …).
  const keywords = attributes?.keywords ?? [];
  // G3 5.4b: the company's own homepage/Impressum profile is direct trade-role evidence.
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
  // A namespace with bookkeeping only (W5-f: a contact-path attempt on a company never profiled) is no evidence.
  const websiteProfile =
    profileFacts && Object.values(profileFacts).some((value) => value !== undefined) ? profileFacts : undefined;
  const crossSourceEvidence = crossSourceEvidenceSummary(company.attributes);
  let out: FitOutput;
  let durableReceipt: DurableExecutionReceipt | undefined;
  try {
    const result = await executeSkillWithRuntime<FitOutput>(
      opts?.skills ?? STATIC_SKILL_RESOLVER,
      gateway,
      'discovery.qualify_fit',
      {
        task: contract.id,
        prompt: `卖方 ICP：\n${JSON.stringify(icpBrief, null, 2)}\n\n候选公司：\n${JSON.stringify(
          { name: company.name, domain: company.domain, country: company.country, industry: company.industry, products,
            keywords,
            ...(websiteProfile ? { website_profile: websiteProfile } : {}),
            ...(crossSourceEvidence ? { cross_source_evidence: crossSourceEvidence } : {}),
          },
          null,
          2,
        )}\n\n判断该候选是否为卖方的真实目标客户，输出中文理由。`,
        system: contract.description,
        model: contract.model,
        schema: contract.outputSchema,
      },
      // runId=预算归账键（run 内 fit 判定消耗计入该 run 的账；sweep 无 runId 则按 workspace 归账）
      {
        workspaceId,
        runId: opts?.runId,
        authorizeExternalAction: opts?.authorizeExternalAction,
        durableResultSchema: 'fit-judgment/v1',
      },
      { telemetry: opts?.runtimeTelemetry },
    );
    out = result.data;
    durableReceipt = result.durableReceipt;
  } catch (err) {
    // 预算截断必须显性上抛（复审 HIGH）：与单家模型故障不同，预算耗尽意味着**本批余下全部**
    // 都会失败——吞掉会造成「静默漏判 + run 假 DONE」。调用方捕获后中断循环并计入 stats。
    // 技能不可用（ops 停用/未登记/契约漂移）同理：整轮显性失败，绝不静默返回 null 判。
    if (
      err instanceof BudgetExceededError ||
      err instanceof BudgetOperationReplayError ||
      err instanceof SkillUnavailableError ||
      isExecutionControlError(err)
    ) throw err;
    return null;
  }
  const refusal = refusalExcerpt(out);
  if (refusal !== null) {
    return {
      verdict: 'weak',
      fitReasons: {
        material: 'unclear：模型拒答，未提供实质判定',
        role: 'unclear：模型拒答，未提供实质判定',
        process: 'unclear：模型拒答，未提供实质判定',
        business_model: 'unclear：模型拒答，未提供实质判定',
        reasons: [
          'qualify_fit 模型返回拒绝文案，未对该候选做实质判定（疑似上游内容策略拒答）；按 fail-safe 转人工复核，不自动拒绝。',
          `原文摘录：${refusal}`,
        ],
      },
      ...(durableReceipt ? { durableReceipt } : {}),
    };
  }
  const rawVerdict = (
    ['match', 'weak', 'mismatch'].includes(out.verdict) ? out.verdict : 'weak'
  ) as FitJudgment['verdict'];
  // 跨源佐证门（2026-11-10，默认 enforce）：v1 路径的结论类判定同样需 ≥2 个来源分层，
  // 不足则 fail-closed 降级 weak（可回滚：JUDGE_CORROBORATION_MODE=shadow/off）。
  const gated = applyCorroborationToV1(rawVerdict, company);
  return {
    verdict: gated.verdict,
    fitReasons: {
      material: out.material_gate,
      role: out.role_gate,
      process: out.process_gate,
      business_model: out.business_model_gate,
      reasons: gated.reasonLine ? [gated.reasonLine, ...out.reasons].slice(0, 16) : out.reasons,
    },
    ...(durableReceipt ? { durableReceipt } : {}),
  };
}
