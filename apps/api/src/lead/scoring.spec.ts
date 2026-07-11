import { describe, expect, it } from 'vitest';
import { CompanyForScoring, IcpForScoring, scoreLead } from './scoring';

const company = (p: Partial<CompanyForScoring>): CompanyForScoring => ({
  name: 'Acme',
  domain: 'acme.com',
  country: 'DE',
  industry: 'manufacturing',
  employeeCount: 500,
  revenueUsd: null,
  attributes: null,
  status: 'NEW',
  contacts: [],
  ...p,
});

const icp: IcpForScoring = {
  rules: [
    { kind: 'MUST_HAVE', field: 'industry', operator: 'eq', value: 'manufacturing' },
    { kind: 'EXCLUSION', field: 'country', operator: 'in', value: ['XX'] },
  ],
  triggerSignals: ['扩产', 'new production line'],
  committeeRoles: [
    { role: 'decision_maker', title: 'CEO' },
    { role: 'procurement', title: 'Head of Procurement' },
  ],
};

describe('scoreLead', () => {
  it('SUPPRESSED 公司 → suppressed 队列', () => {
    expect(scoreLead(company({ status: 'SUPPRESSED' }), icp).queue).toBe('suppressed');
  });

  it('排除命中 → rejected 队列', () => {
    expect(scoreLead(company({ country: 'XX' }), icp).queue).toBe('rejected');
  });

  it('必要条件缺数据 → needs_review', () => {
    const r = scoreLead(company({ industry: null }), icp);
    expect(r.queue).toBe('needs_review');
    expect(r.detail.fitVerdict).toBe('review');
  });

  it('联系人可达 + 委员会覆盖 → 分数上升并可进 recommended', () => {
    const bare = scoreLead(company({}), icp);
    const rich = scoreLead(
      company({
        attributes: { keywords: ['new production line planned'] },
        contacts: [
          { title: 'CEO', seniority: 'c_level', contactPoints: [{ type: 'email', status: 'VALID' }] },
          { title: 'Head of Procurement', seniority: 'director', contactPoints: [{ type: 'email', status: 'VALID' }] },
        ],
      }),
      icp,
    );
    expect(rich.totalScore).toBeGreaterThan(bare.totalScore);
    expect(rich.queue).toBe('recommended');
    expect(bare.queue).toBe('needs_review'); // 无联系人/信号：诚实地不自动推荐
  });

  it('评分明细带逐规则评估（可审计）', () => {
    const r = scoreLead(company({}), icp);
    expect(r.detail.ruleEvaluations).toHaveLength(2);
    expect(r.scores).toHaveProperty('fit');
    expect(r.scores.engagement).toBe(0);
    expect(r.detail.intentSignals).toEqual([]); // 无真实信号
  });
});

// ── Intent 维接入真实网站变更信号 (#4) ─────────────────────────────
const NOW = Date.parse('2026-07-07T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
/** 构造 #4 网站变更引擎投影的 attributes.intent 形态。 */
const withIntent = (events: { type: string; at: string; strength: number }[]): Partial<CompanyForScoring> => ({
  attributes: {
    intent: {
      last_change_at: events[0]?.at,
      intent_score: Math.max(0, ...events.map((e) => e.strength)),
      counts: {},
      events: events.map((e) => ({ ...e, page_kind: 'sourcing', page_url: 'https://acme.com/suppliers' })),
      _ts: daysAgo(0),
    },
  },
});

describe('scoreLead — Intent 维接入真实网站变更信号 (#4)', () => {
  it('近期强信号(SOURCING_OPENED) → Intent 高分 + intentSignals 记录 + 总分高于无信号', () => {
    const base = scoreLead(company({}), icp, { nowMs: NOW });
    const hot = scoreLead(company(withIntent([{ type: 'SOURCING_OPENED', at: daysAgo(6), strength: 1 }])), icp, { nowMs: NOW });
    expect(hot.scores.intent).toBeGreaterThan(0.9); // 1.0 × 半衰期6d衰减 ≈ 0.93
    expect(hot.detail.intentSignals).toContain('SOURCING_OPENED');
    expect(hot.detail.notes.some((n) => n.includes('真实网站变更信号'))).toBe(true);
    expect(hot.totalScore).toBeGreaterThan(base.totalScore);
  });

  it('新近度衰减：同一信号越旧分越低（半衰期 60d）', () => {
    const fresh = scoreLead(company(withIntent([{ type: 'SOURCING_OPENED', at: daysAgo(6), strength: 1 }])), icp, { nowMs: NOW });
    const stale = scoreLead(company(withIntent([{ type: 'SOURCING_OPENED', at: daysAgo(180), strength: 1 }])), icp, { nowMs: NOW });
    expect(stale.scores.intent).toBeLessThan(fresh.scores.intent);
    expect(stale.scores.intent).toBeLessThan(0.2); // 180d ≈ 3 个半衰期 → ~0.125
  });

  it('多事件取最强（衰减后）', () => {
    const r = scoreLead(
      company(withIntent([
        { type: 'NEWS_POSTED', at: daysAgo(3), strength: 0.5 },
        { type: 'HIRING_UP', at: daysAgo(200), strength: 0.9 }, // 强但陈旧 → 衰减后弱
      ])),
      icp,
      { nowMs: NOW },
    );
    // 近期 0.5×~0.966=0.48 vs 陈旧 0.9×0.5^(200/60)=0.9×0.099=0.089 → 取 0.48
    expect(r.scores.intent).toBeCloseTo(0.48, 1);
    expect(r.detail.intentSignals).toEqual(['NEWS_POSTED', 'HIRING_UP']);
  });

  it('真实证据压过关键词代理', () => {
    const kwOnly = scoreLead(company({ attributes: { keywords: ['new production line planned'] } }), icp, { nowMs: NOW });
    const real = scoreLead(company(withIntent([{ type: 'SOURCING_OPENED', at: daysAgo(3), strength: 1 }])), icp, { nowMs: NOW });
    expect(kwOnly.scores.intent).toBeCloseTo(0.5, 1); // 命中 1/2 触发词
    expect(real.scores.intent).toBeGreaterThan(kwOnly.scores.intent);
  });

  it('事件缺失但有 intent_score 概要 → 用概要 + last_change_at 衰减兜底，且明细标注真实信号', () => {
    const c = company({ attributes: { intent: { intent_score: 0.7, last_change_at: daysAgo(6), counts: {}, events: [] } } });
    const r = scoreLead(c, icp, { nowMs: NOW });
    expect(r.scores.intent).toBeGreaterThan(0.6); // 0.7 × ~0.93
    expect(r.scores.intent).toBeLessThanOrEqual(0.7);
    // 概要兜底路径决定了最终分 → note 不能误标成「关键词代理·无真实信号」
    expect(r.detail.notes.some((n) => n.includes('真实网站变更信号'))).toBe(true);
    expect(r.detail.notes.some((n) => n.includes('关键词代理'))).toBe(false);
  });

  it('概要缺 last_change_at → 不可解析时间戳记 0 分（不被半掉/不误得分）', () => {
    const c = company({ attributes: { intent: { intent_score: 1, counts: {}, events: [] } } }); // 无 last_change_at
    expect(scoreLead(c, icp, { nowMs: NOW }).scores.intent).toBe(0);
  });

  it('事件时间戳缺失/畸形 → 该事件不给分（不盖过真实陈旧信号）', () => {
    const undated = scoreLead(company(withIntent([{ type: 'SOURCING_OPENED', at: 'not-a-date', strength: 1 }])), icp, { nowMs: NOW });
    const aged = scoreLead(company(withIntent([{ type: 'SOURCING_OPENED', at: daysAgo(90), strength: 1 }])), icp, { nowMs: NOW });
    expect(undated.scores.intent).toBe(0); // 畸形 at → 0，不是 0.5
    expect(aged.scores.intent).toBeGreaterThan(0); // 真实 90d 信号仍得分（0.5^1.5≈0.354）
    expect(aged.scores.intent).toBeGreaterThan(undated.scores.intent);
  });

  it('无 attributes.intent → 回退关键词代理（行为不变）', () => {
    const r = scoreLead(company({ attributes: { keywords: ['扩产 计划'] } }), icp, { nowMs: NOW });
    expect(r.detail.intentSignals).toEqual([]);
    expect(r.detail.notes.some((n) => n.includes('关键词代理'))).toBe(true);
    expect(r.scores.intent).toBeCloseTo(0.5, 1); // 命中 '扩产'
  });
});

// ── 权威资格门（LLM 四门 fit_verdict）→ 只覆盖 Fit 维 + 队列走阈值/Reachability 硬底 ──
describe('scoreLead — authoritativeFit（资格门覆盖 Fit 维，不再覆盖整个队列）', () => {
  const reachable = {
    contacts: [
      { title: 'CEO', seniority: 'c_level', contactPoints: [{ type: 'email', status: 'VALID' }] },
      { title: 'Head of Procurement', seniority: 'director', contactPoints: [{ type: 'email', status: 'VALID' }] },
    ],
  };

  it('match + 可达联系人 + 数据完整 → recommended', () => {
    const r = scoreLead(company(reachable), icp, { authoritativeFit: 'match' });
    expect(r.scores.fit).toBeCloseTo(0.85, 2);
    expect(r.queue).toBe('recommended');
    expect(r.detail.notes.some((n) => n.includes('资格门'))).toBe(true);
  });

  it('match 但零联系方式 → needs_review（Reachability 硬底：联系不上的不算推荐）', () => {
    const r = scoreLead(company({}), icp, { authoritativeFit: 'match' });
    expect(r.scores.fit).toBeCloseTo(0.85, 2);
    expect(r.queue).toBe('needs_review');
    expect(r.detail.notes.some((n) => n.includes('先联系人发现'))).toBe(true);
  });

  it('match 覆盖规则引擎的词表误判（industry 对不上也不 rejected）', () => {
    // 规则要 manufacturing，公司词表是中文「制造业」→ 规则引擎 no_match，但资格门 match
    const r = scoreLead(company({ industry: '制造业', ...reachable }), icp, { authoritativeFit: 'match' });
    expect(r.queue).not.toBe('rejected');
    expect(r.scores.fit).toBeCloseTo(0.85, 2);
  });

  it('mismatch → rejected；weak → needs_review（即便联系人可达）', () => {
    expect(scoreLead(company(reachable), icp, { authoritativeFit: 'mismatch' }).queue).toBe('rejected');
    expect(scoreLead(company(reachable), icp, { authoritativeFit: 'weak' }).queue).toBe('needs_review');
  });

  it('排除规则永远优先——资格门 match 也挡不住 EXCLUSION', () => {
    const r = scoreLead(company({ country: 'XX', ...reachable }), icp, { authoritativeFit: 'match' });
    expect(r.queue).toBe('rejected');
  });

  it('未判定（authoritativeFit 缺省）→ 走规则引擎老路径（行为不变）', () => {
    const r = scoreLead(company({}), icp);
    expect(r.detail.fitVerdict).toBe('match'); // 规则引擎自己的判定
    expect(r.queue).toBe('needs_review');
  });
});

// ── Reachability 硬底对所有推荐路径统一生效（非权威规则引擎老路径也不例外）──
describe('scoreLead — Reachability 硬底（非权威路径同样生效）', () => {
  const twoValidContacts = [
    { title: 'CEO', seniority: 'c_level', contactPoints: [{ type: 'email', status: 'VALID' }] },
    { title: 'Head of Procurement', seniority: 'director', contactPoints: [{ type: 'email', status: 'VALID' }] },
  ];

  it('非权威 match + 总分≥0.55 但零可达联系方式 → needs_review（绝不进推荐）', () => {
    // fitVerdict=null 存量常态：规则引擎自判 match + 近期真实 intent + 数据完整，但一个联系人都没有。
    // Reachability 硬底此前只在 authoritative 分支生效 → 老路径漏出「联系不上的伪推荐」。
    const r = scoreLead(
      company(withIntent([{ type: 'SOURCING_OPENED', at: daysAgo(6), strength: 1 }])),
      icp,
      { nowMs: NOW },
    );
    expect(r.detail.fitVerdict).toBe('match'); // 规则引擎自身判定（非权威路径）
    expect(r.totalScore).toBeGreaterThanOrEqual(0.55);
    expect(r.scores.reachability).toBe(0);
    expect(r.queue).toBe('needs_review'); // 修复前此处会误判 recommended
    expect(r.detail.notes.some((n) => n.includes('先联系人发现'))).toBe(true);
  });

  it('非权威 match + 总分≥0.55 + 可达联系方式 → recommended', () => {
    const r = scoreLead(
      company({
        ...withIntent([{ type: 'SOURCING_OPENED', at: daysAgo(6), strength: 1 }]),
        contacts: twoValidContacts,
      }),
      icp,
      { nowMs: NOW },
    );
    expect(r.scores.reachability).toBe(1);
    expect(r.queue).toBe('recommended');
  });

  it('authoritativeFit 只覆盖 Fit 维——其余五维与不传时逐维完全相等', () => {
    const c = company({ contacts: twoValidContacts });
    const withAuth = scoreLead(c, icp, { authoritativeFit: 'match', nowMs: NOW });
    const without = scoreLead(c, icp, { nowMs: NOW });
    expect(withAuth.scores.role).toBe(without.scores.role);
    expect(withAuth.scores.intent).toBe(without.scores.intent);
    expect(withAuth.scores.dataQuality).toBe(without.scores.dataQuality);
    expect(withAuth.scores.reachability).toBe(without.scores.reachability);
    expect(withAuth.scores.engagement).toBe(without.scores.engagement);
    expect(withAuth.scores.fit).not.toBe(without.scores.fit); // 仅 Fit 维被覆盖（0.8→0.85）
  });
});

describe('scoreLead — Fit 维值域护栏（J：clamp01 系统边界兜底）', () => {
  it('负权重混入（绕过 DTO 的历史/直写数据）→ 归一化比可超 1，fit 与总分仍被夹回 [0,1]', () => {
    // nice-to-have 权重 [5, -4]：分母 total=1，命中 weight=5 的规则 → got/total=5 → 未夹取时
    // fit = 0.6 + 0.4×5 = 2.6 > 1（旧代码 RED），污染 totalScore 与队列排序。
    const poisonedIcp: IcpForScoring = {
      rules: [
        { kind: 'NICE_TO_HAVE', field: 'industry', operator: 'eq', value: 'manufacturing', weight: 5 },
        { kind: 'NICE_TO_HAVE', field: 'country', operator: 'eq', value: 'XX', weight: -4 },
      ],
      triggerSignals: [],
      committeeRoles: [],
    };
    const r = scoreLead(company({}), poisonedIcp);

    expect(r.scores.fit).toBeLessThanOrEqual(1);
    expect(r.scores.fit).toBeGreaterThanOrEqual(0);
    expect(r.scores.fit).toBe(1); // 2.6 夹到 1
    expect(r.totalScore).toBeLessThanOrEqual(1);
  });
});

describe('scoreLead — DemandProof 观测维（收口⑤：一等 Signal 需求证据，不进总分）', () => {
  const NOW = Date.parse('2026-07-11T00:00:00Z');
  const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
  const withEvents = (events: unknown[]) =>
    company({ attributes: { intent: { last_change_at: daysAgo(1), intent_score: 0.9, counts: {}, events, _ts: 'x' } } });

  it('TENDER_PUBLISHED（招标）/ SOURCING_OPENED（供应商招募）→ demandProof 按衰减取最强', () => {
    const tender = scoreLead(withEvents([{ type: 'TENDER_PUBLISHED', at: daysAgo(3), strength: 0.9, evidence: { notice: 'N-1', source: 'ted' } }]), icp, { nowMs: NOW });
    expect(tender.scores.demandProof).toBeGreaterThan(0.85); // 0.9 × 3d 衰减 ≈ 0.87
    const sourcing = scoreLead(withEvents([{ type: 'SOURCING_OPENED', at: daysAgo(3), strength: 1, evidence: { page: 1 } }]), icp, { nowMs: NOW });
    expect(sourcing.scores.demandProof).toBeGreaterThan(0.95);
  });

  it('FDA_CLEARANCE 属上市时机 → 动 Intent 维但 demandProof=0（维度切分拍板）', () => {
    const r = scoreLead(withEvents([{ type: 'FDA_CLEARANCE', at: daysAgo(3), strength: 0.85 }]), icp, { nowMs: NOW });
    expect(r.scores.intent).toBeGreaterThan(0.8);
    expect(r.scores.demandProof).toBe(0);
  });

  it('关键词代理绝不喂 demandProof（ADR-010：无 evidence 不参与需求证据）', () => {
    const r = scoreLead(company({ attributes: { keywords: ['new production line planned'] } }), icp, { nowMs: NOW });
    expect(r.scores.intent).toBeGreaterThan(0); // 代理兜底只作用于 Intent 维
    expect(r.scores.demandProof).toBe(0);
  });

  it('demandProof 不进 totalScore：总分 = 六维加权和（观测维零权重）', () => {
    const r = scoreLead(withEvents([{ type: 'TENDER_PUBLISHED', at: daysAgo(3), strength: 0.9, evidence: { notice: 'N-1', source: 'ted' } }]), icp, { nowMs: NOW });
    const expected =
      0.35 * r.scores.fit + 0.15 * r.scores.role + 0.15 * r.scores.intent +
      0.15 * r.scores.dataQuality + 0.15 * r.scores.reachability + 0.05 * r.scores.engagement;
    expect(r.totalScore).toBeCloseTo(expected, 4);
  });

  it('陈旧需求信号按 60d 半衰期衰减（demandProof 可过期的评分侧体现）', () => {
    const fresh = scoreLead(withEvents([{ type: 'TENDER_PUBLISHED', at: daysAgo(3), strength: 0.9, evidence: { notice: 'N-1', source: 'ted' } }]), icp, { nowMs: NOW });
    const stale = scoreLead(withEvents([{ type: 'TENDER_PUBLISHED', at: daysAgo(180), strength: 0.9, evidence: { notice: 'N-2', source: 'ted' } }]), icp, { nowMs: NOW });
    expect(stale.scores.demandProof).toBeLessThan(fresh.scores.demandProof);
    expect(stale.scores.demandProof).toBeLessThan(0.15); // 3 个半衰期 ≈ ×0.125
  });
});

describe('scoreLead — DemandProof evidence 判据（ADR-010：无 evidence 不参与评分或导出）', () => {
  it('type 命中但无 evidence 的事件 → 不计入 demandProof（Intent 维不受此判据影响）', () => {
    const NOW2 = Date.parse('2026-07-11T00:00:00Z');
    const at = new Date(NOW2 - 3 * 86_400_000).toISOString();
    const co = company({
      attributes: { intent: { last_change_at: at, intent_score: 0.9, counts: {}, events: [{ type: 'TENDER_PUBLISHED', at, strength: 0.9 }], _ts: 'x' } },
    });
    const r = scoreLead(co, icp, { nowMs: NOW2 });
    expect(r.scores.demandProof).toBe(0); // 无 evidence → 不进需求证据维
    expect(r.scores.intent).toBeGreaterThan(0.8); // Intent 维按既有语义仍计
  });
});
