/**
 * M0③ 快扫（Run 2.0）的纯逻辑：
 *  ① 规则预筛（确定性、零模型）：先把明显不相关的公司挡在模型之前；
 *  ② 批量粗判（8 家/次）：一次请求判一批，解析失败由调用方降级为逐家判定；
 *  ③ 兜底语义：模型整体不可用时按规则结果出名单（Q20），绝不因模型故障吞掉名单。
 *
 * 设计：docs/superpowers/plans/2026-11-04-acquisition-system-complete-design.md §6.2（R3/R4）。
 */
import { qualify, type QualifyResult, type RuleLike } from '../../icp/rule-engine';
import { ambientProcessEnv, discoveryUncappedEnabled } from '../execution-envelope';

/** 一次批量粗判的公司数（设计 R4：8 家/次，失败降级逐家）。 */
export const QUICK_JUDGE_BATCH_SIZE = 8;
/** 产品帽：单个 run 消费公司池的上限（设计 Q8：500 家/run）。 */
export const QUICK_SCAN_POOL_LIMIT_CAPPED = 500;
/** 去帽模式的防爆界默认（env `DISCOVERY_QUICK_SCAN_POOL_LIMIT`，1–1_000_000）。 */
export const UNCAPPED_QUICK_SCAN_POOL_LIMIT = 50_000;
export const QUICK_SCAN_POOL_LIMIT_MAX = 1_000_000;

/**
 * 单个 run 消费公司池的上限。off：产品帽 500（行为与今天一致）；
 * DISCOVERY_UNCAPPED=on：升为防爆安全界（默认 5 万，env 可调），
 * 真正的收紧条件是执行预算账户（余额耗尽即停），不是这里的产品帽。
 */
export function resolveQuickScanPoolLimit(
  env: NodeJS.ProcessEnv = ambientProcessEnv(),
): number {
  if (!discoveryUncappedEnabled(env)) return QUICK_SCAN_POOL_LIMIT_CAPPED;
  const text = (env.DISCOVERY_QUICK_SCAN_POOL_LIMIT ?? '').trim();
  if (!/^\d+$/u.test(text)) return UNCAPPED_QUICK_SCAN_POOL_LIMIT;
  const parsed = Number.parseInt(text, 10);
  return Number.isSafeInteger(parsed) &&
    parsed >= 1 &&
    parsed <= QUICK_SCAN_POOL_LIMIT_MAX
    ? parsed
    : UNCAPPED_QUICK_SCAN_POOL_LIMIT;
}

/** 模块级值：进程启动时的 env 解析结果（off 默认 500）。 */
export const QUICK_SCAN_POOL_LIMIT: number = resolveQuickScanPoolLimit();

export type QuickVerdict = 'match' | 'weak' | 'mismatch';

export interface PrefilterCompany {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  industry: string | null;
  employeeCount?: number | null;
  revenueUsd?: number | null;
  attributes: unknown;
}

/**
 * 规则引擎的输入：canonical 列优先于 attributes 里的同名值（列是归一后的权威副本），
 * 并同时给出 snake/camel 两种拼写，兼容 ICP 规则生成器的两种写法。
 */
export function prefilterAttributes(company: PrefilterCompany): Record<string, unknown> {
  const raw = company.attributes;
  const attributes =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  attributes.name = company.name;
  if (company.domain) attributes.domain = company.domain;
  if (company.country) attributes.country = company.country;
  if (company.industry) attributes.industry = company.industry;
  if (typeof company.employeeCount === 'number') {
    attributes.employee_count = company.employeeCount;
    attributes.employeeCount = company.employeeCount;
  }
  if (typeof company.revenueUsd === 'number') {
    attributes.revenue_usd = company.revenueUsd;
    attributes.revenueUsd = company.revenueUsd;
  }
  return attributes;
}

export interface PrefilterDecision {
  decision: 'candidate' | 'prefiltered_out';
  verdict: QualifyResult['verdict'];
  score: number | null;
}

/**
 * 规则预筛：EXCLUSION 命中或 MUST_HAVE 明确失败 → 直接出局（prefiltered_out）；
 * 数据不足（review）与通过 → 进批量粗判。镜像 EXCLUSION 只记录不排除（避免把分销商误杀，
 * 与评分规则 v3 的同一保护）。
 */
export function prefilterCompany(
  rules: readonly RuleLike[],
  company: PrefilterCompany,
): PrefilterDecision {
  if (rules.length === 0) {
    return { decision: 'candidate', verdict: 'match', score: null };
  }
  const result = qualify([...rules], prefilterAttributes(company), {
    mirrorExclusionsAdvisory: true,
  });
  const decision =
    result.verdict === 'exclude' || result.verdict === 'no_match'
      ? 'prefiltered_out'
      : 'candidate';
  return { decision, verdict: result.verdict, score: result.score };
}

/** 批量粗判的输出 schema（与 parseQuickJudgeBatch 的容错解析配套）。 */
export const QUICK_JUDGE_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['judgments'],
  additionalProperties: false,
  properties: {
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'verdict', 'reason'],
        additionalProperties: false,
        properties: {
          index: { type: 'integer', minimum: 0 },
          verdict: { enum: ['match', 'weak', 'mismatch'] },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

export function buildQuickJudgePrompt(
  icpBrief: unknown,
  companies: readonly PrefilterCompany[],
): string {
  const rows = companies.map((company, index) => ({
    index,
    name: company.name,
    domain: company.domain,
    country: company.country,
    industry: company.industry,
    ...(Array.isArray((company.attributes as { products?: unknown } | null)?.products)
      ? { products: (company.attributes as { products: unknown }).products }
      : {}),
    ...(Array.isArray((company.attributes as { keywords?: unknown } | null)?.keywords)
      ? { keywords: (company.attributes as { keywords: unknown }).keywords }
      : {}),
  }));
  return [
    `卖方 ICP：\n${JSON.stringify(icpBrief, null, 2)}`,
    `候选公司（共 ${rows.length} 家，index 从 0 开始）：\n${JSON.stringify(rows, null, 2)}`,
    '逐家判断是否为该卖方的真实目标客户（四门：材质/角色/工艺子集/商业模式，与单家判定同一口径），' +
      '对每个 index 输出 verdict（match | weak | mismatch）与一句中文理由。',
  ].join('\n\n');
}

/**
 * 容错解析批量输出：非法/越界/重复条目一律丢弃并按「未判定」处理（调用方对该家降级为逐家判定）。
 * 返回与输入顺序一一对应的数组，null = 该家未得到有效判定。
 */
export function parseQuickJudgeBatch(
  raw: unknown,
  count: number,
): Array<QuickVerdict | null> {
  const verdicts: Array<QuickVerdict | null> = Array.from({ length: count }, () => null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return verdicts;
  const list = (raw as { judgments?: unknown }).judgments;
  if (!Array.isArray(list)) return verdicts;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const index = (entry as { index?: unknown }).index;
    const verdict = (entry as { verdict?: unknown }).verdict;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count) {
      continue;
    }
    if (verdict !== 'match' && verdict !== 'weak' && verdict !== 'mismatch') continue;
    if (verdicts[index] === null) verdicts[index] = verdict;
  }
  return verdicts;
}
