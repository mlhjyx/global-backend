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
