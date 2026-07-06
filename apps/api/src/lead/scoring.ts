import { qualify, QualifyResult, RuleLike } from '../icp/rule-engine';

/**
 * 六维评分（LED-006, PRD 5.6/7.5）—— 全部确定性计算，AI 不参与打分：
 * Fit          规则引擎判定 + nice-to-have 加权分
 * Role         已发现联系人对买家委员会角色的覆盖
 * Intent       触发信号命中（当前无真实信号源 → 关键词代理，来源标注在 detail）
 * DataQuality  关键字段完整度
 * Reachability 联系方式可达性（VALID > UNVERIFIED > 无）
 * Engagement   互动历史（触达能力未上线 → 恒 0，权重最低）
 * 排除规则永远优先（EXCLUSION 命中 → rejected 队列，不进推荐）。
 */

export interface CompanyForScoring {
  name: string;
  domain: string | null;
  country: string | null;
  industry: string | null;
  employeeCount: number | null;
  revenueUsd: number | null;
  attributes: Record<string, unknown> | null;
  status: string; // NEW | ENRICHED | SUPPRESSED
  contacts: {
    title: string | null;
    seniority: string | null;
    contactPoints: { type: string; status: string }[];
  }[];
}

export interface IcpForScoring {
  rules: RuleLike[];
  triggerSignals: string[];
  committeeRoles: { role: string; title: string | null }[];
}

export interface LeadScoreResult {
  queue: 'recommended' | 'needs_review' | 'rejected' | 'suppressed';
  totalScore: number;
  scores: {
    fit: number;
    role: number;
    intent: number;
    dataQuality: number;
    reachability: number;
    engagement: number;
  };
  detail: {
    fitVerdict: QualifyResult['verdict'];
    ruleEvaluations: QualifyResult['evaluations'];
    matchedSignals: string[];
    missingFields: string[];
    notes: string[];
  };
}

const WEIGHTS = { fit: 0.35, role: 0.15, intent: 0.15, dataQuality: 0.15, reachability: 0.15, engagement: 0.05 };
const RECOMMEND_THRESHOLD = 0.55;

function companyAttributes(c: CompanyForScoring): Record<string, unknown> {
  return {
    name: c.name,
    domain: c.domain,
    country: c.country,
    industry: c.industry,
    employee_count: c.employeeCount,
    revenue_usd: c.revenueUsd,
    ...(c.attributes ?? {}),
  };
}

export function scoreLead(company: CompanyForScoring, icp: IcpForScoring): LeadScoreResult {
  const notes: string[] = [];
  const attrs = companyAttributes(company);
  const fitResult = qualify(icp.rules, attrs);

  // Fit
  const fit =
    fitResult.verdict === 'match'
      ? 0.6 + 0.4 * (fitResult.score ?? 0.5)
      : fitResult.verdict === 'review'
        ? 0.3 + 0.3 * (fitResult.score ?? 0)
        : 0;

  // Role coverage：委员会角色被联系人 title 覆盖的比例
  const titles = company.contacts.map((c) => `${c.title ?? ''} ${c.seniority ?? ''}`.toLowerCase());
  const covered = icp.committeeRoles.filter((r) => {
    const probe = `${r.title ?? ''} ${r.role}`.toLowerCase();
    const words = probe.split(/[\s/|]+/).filter((w) => w.length > 2);
    return titles.some((t) => words.some((w) => t.includes(w)));
  });
  const role = icp.committeeRoles.length
    ? covered.length / icp.committeeRoles.length
    : company.contacts.length
      ? 0.5
      : 0;
  if (!company.contacts.length) notes.push('无联系人 —— Role/Reachability 低分，先做联系人发现');

  // Intent：触发信号 ↔ 公司关键词/属性 文本命中（无真实信号源前的代理指标）
  const attrText = JSON.stringify(attrs).toLowerCase();
  const matchedSignals = icp.triggerSignals.filter((s) => {
    const words = s.toLowerCase().split(/[\s，,、]+/).filter((w) => w.length > 1);
    return words.some((w) => attrText.includes(w));
  });
  const intent = icp.triggerSignals.length ? Math.min(1, matchedSignals.length / Math.min(icp.triggerSignals.length, 3)) : 0;
  notes.push('Intent 基于关键词代理（真实意向信号源未接入）');

  // DataQuality：关键字段完整度
  const keyFields: [string, unknown][] = [
    ['domain', company.domain],
    ['country', company.country],
    ['industry', company.industry],
    ['employee_count', company.employeeCount],
  ];
  const missingFields = keyFields.filter(([, v]) => v == null).map(([k]) => k);
  const dataQuality = (keyFields.length - missingFields.length) / keyFields.length;

  // Reachability：最优联系方式状态
  const points = company.contacts.flatMap((c) => c.contactPoints);
  const reachability = points.some((p) => p.status === 'VALID')
    ? 1
    : points.some((p) => p.status === 'UNVERIFIED' || p.status === 'RISKY')
      ? 0.5
      : 0;

  const engagement = 0; // 触达/互动未上线

  const scores = {
    fit: r4(fit),
    role: r4(role),
    intent: r4(intent),
    dataQuality: r4(dataQuality),
    reachability: r4(reachability),
    engagement,
  };
  const totalScore = r4(
    Object.entries(WEIGHTS).reduce((s, [k, w]) => s + w * scores[k as keyof typeof scores], 0),
  );

  // 队列（LED-008）：硬排除 > 数据不足 > 阈值
  let queue: LeadScoreResult['queue'];
  if (company.status === 'SUPPRESSED') queue = 'suppressed';
  else if (fitResult.verdict === 'exclude' || fitResult.verdict === 'no_match') queue = 'rejected';
  else if (fitResult.verdict === 'review') queue = 'needs_review';
  else queue = totalScore >= RECOMMEND_THRESHOLD ? 'recommended' : 'needs_review';

  return {
    queue,
    totalScore,
    scores,
    detail: { fitVerdict: fitResult.verdict, ruleEvaluations: fitResult.evaluations, matchedSignals, missingFields, notes },
  };
}

const r4 = (n: number): number => Number(n.toFixed(4));
