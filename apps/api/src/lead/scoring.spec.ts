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
  companyContactPoints: [],
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

  it('🔴 制裁命中 sanctionsHold → sanctions_hold 队列，压过一切（含 SUPPRESSED/排除/权威 match）', () => {
    expect(scoreLead(company({}), icp, { sanctionsHold: true }).queue).toBe('sanctions_hold');
    // 压过 SUPPRESSED
    expect(scoreLead(company({ status: 'SUPPRESSED' }), icp, { sanctionsHold: true }).queue).toBe('sanctions_hold');
    // 压过硬排除
    expect(scoreLead(company({ country: 'XX' }), icp, { sanctionsHold: true }).queue).toBe('sanctions_hold');
    // 压过权威 match（否则本会进 recommended/needs_review）
    expect(scoreLead(company({}), icp, { sanctionsHold: true, authoritativeFit: 'match' }).queue).toBe('sanctions_hold');
  });

  it('sanctionsHold=false/缺省 → 不影响队列（fail-open）', () => {
    expect(scoreLead(company({ status: 'SUPPRESSED' }), icp, { sanctionsHold: false }).queue).toBe('suppressed');
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
    expect(r.detail.notes.some((n) => n.includes('先补公司级联系路径'))).toBe(true);
  });

  it('🔴 P1（#58）：董事仅有 external_id 点（无 email/phone）→ 零可达 → needs_review（external_id 不给 Reachability 信用）', () => {
    const r = scoreLead(
      company({ contacts: [{ title: 'Director', seniority: 'director', contactPoints: [{ type: 'external_id', status: 'UNVERIFIED' }] }] }),
      icp,
      { authoritativeFit: 'match' },
    );
    expect(r.scores.reachability).toBe(0); // external_id 被排除 → 零可达
    expect(r.queue).toBe('needs_review'); // 联系不上 → 绝不进 recommended
  });

  it('🔴 P2（#62 复审）：仅 linkedin 联系点 → 仍算可达（黑名单只排 external_id，保留真实渠道）', () => {
    const r = scoreLead(
      company({ contacts: [{ title: 'Director', seniority: 'director', contactPoints: [{ type: 'linkedin', status: 'UNVERIFIED' }] }] }),
      icp,
      { authoritativeFit: 'match' },
    );
    expect(r.scores.reachability).toBeGreaterThan(0); // linkedin 不被误排
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
    expect(r.detail.notes.some((n) => n.includes('先补公司级联系路径'))).toBe(true);
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

  it('US_FED_SOURCES_SOUGHT（SAM 招标前市场调研）→ demandProof>0（买方侧需求，同 TED 招标类，P4）', () => {
    const sam = scoreLead(withEvents([{ type: 'US_FED_SOURCES_SOUGHT', at: daysAgo(3), strength: 0.7, evidence: { naics: ['333914'], notice: 'SS-1', source: 'samgov' } }]), icp, { nowMs: NOW });
    expect(sam.scores.demandProof).toBeGreaterThan(0.6); // 0.7 × 3d 衰减 ≈ 0.68
    expect(sam.scores.intent).toBeGreaterThan(0); // 同时驱动 Intent 维（通用 events 遍历）
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

  it('demandProof 不进 totalScore：总分 = 六维加权和（观测维零权重；v3 权重 fit .45 / role 0 / reach .20）', () => {
    const r = scoreLead(withEvents([{ type: 'TENDER_PUBLISHED', at: daysAgo(3), strength: 0.9, evidence: { notice: 'N-1', source: 'ted' } }]), icp, { nowMs: NOW });
    const expected =
      0.45 * r.scores.fit + 0 * r.scores.role + 0.15 * r.scores.intent +
      0.15 * r.scores.dataQuality + 0.2 * r.scores.reachability + 0.05 * r.scores.engagement;
    expect(r.totalScore).toBeCloseTo(expected, 4);
  });

  it('陈旧需求信号按 60d 半衰期衰减（demandProof 可过期的评分侧体现）', () => {
    const fresh = scoreLead(withEvents([{ type: 'TENDER_PUBLISHED', at: daysAgo(3), strength: 0.9, evidence: { notice: 'N-1', source: 'ted' } }]), icp, { nowMs: NOW });
    const stale = scoreLead(withEvents([{ type: 'TENDER_PUBLISHED', at: daysAgo(180), strength: 0.9, evidence: { notice: 'N-2', source: 'ted' } }]), icp, { nowMs: NOW });
    expect(stale.scores.demandProof).toBeLessThan(fresh.scores.demandProof);
    expect(stale.scores.demandProof).toBeLessThan(0.15); // 3 个半衰期 ≈ ×0.125
  });
});

// ── 评分规则 v3（additive-6dim-v3）：公司级可达性（BI-14 D-028）──────────────────────
describe('scoreLead — v3 公司级可达性（company_contact_point 与个人旧口径取大）', () => {
  /** xin 的 ce100faa 形态：public_web 原始记录从不带行业/员工数 → DataQuality 0.5；无具名联系人。 */
  const xinLike = (points: CompanyForScoring['companyContactPoints']): CompanyForScoring =>
    company({ industry: null, employeeCount: null, attributes: { keywords: ['industrial pumps'] }, companyContactPoints: points });
  const page = (kind: string, status = 'UNVERIFIED') => ({ kind, status });

  it('资格门 match + 联系页（UNVERIFIED）→ reachability 1 → 总分 0.6575 → recommended（v2 口径只有 0.5225 进不了）', () => {
    const r = scoreLead(xinLike([page('contact_page')]), icp, { authoritativeFit: 'match' });
    expect(r.scores.reachability).toBe(1);
    expect(r.scores.dataQuality).toBe(0.5);
    expect(r.totalScore).toBeCloseTo(0.6575, 4); // 0.85×.45 + .20 + .15×.5
    expect(r.queue).toBe('recommended');
    expect(r.detail.reasonCodes).toEqual([]);
  });

  it.each(['contact_page', 'impressum_page', 'contact_form', 'supplier_page'])('联系路径 kind=%s 计 1.0', (kind) => {
    expect(scoreLead(xinLike([page(kind)]), icp, { authoritativeFit: 'match' }).scores.reachability).toBe(1);
  });

  it('社交页（linkedin_company_page / x_company_account）不是联系路径 → 0', () => {
    const r = scoreLead(xinLike([page('linkedin_company_page'), page('x_company_account')]), icp, { authoritativeFit: 'match' });
    expect(r.scores.reachability).toBe(0);
    expect(r.queue).toBe('needs_review');
  });

  it('INVALID 的点被忽略；VALID 与 UNVERIFIED 同计 1.0（自动链路只写 UNVERIFIED，VALID 只能由人给出）', () => {
    expect(scoreLead(xinLike([page('contact_page', 'INVALID')]), icp, { authoritativeFit: 'match' }).scores.reachability).toBe(0);
    expect(scoreLead(xinLike([page('contact_page', 'VALID')]), icp, { authoritativeFit: 'match' }).scores.reachability).toBe(1);
  });

  it('与个人旧口径取大：个人 UNVERIFIED 0.5 / 公司联系页 1.0 / 两者并存 1.0；external_id 仍不计', () => {
    const personal = [{ title: 'Einkauf', seniority: null, contactPoints: [{ type: 'email', status: 'UNVERIFIED' }] }];
    expect(scoreLead(company({ contacts: personal }), icp).scores.reachability).toBe(0.5);
    expect(scoreLead(company({ contacts: personal, companyContactPoints: [page('contact_page')] }), icp).scores.reachability).toBe(1);
    const officer = [{ title: 'Director', seniority: null, contactPoints: [{ type: 'external_id', status: 'UNVERIFIED' }] }];
    expect(scoreLead(company({ contacts: officer }), icp).scores.reachability).toBe(0);
  });

  it('零可达且进 needs_review → reasonCodes 带 MISSING_CONTACT_POINT；注释改为「先补公司级联系路径」', () => {
    const r = scoreLead(xinLike([]), icp, { authoritativeFit: 'match' });
    expect(r.queue).toBe('needs_review');
    expect(r.detail.reasonCodes).toContain('MISSING_CONTACT_POINT');
    expect(r.detail.notes.some((n) => n.includes('先补公司级联系路径'))).toBe(true);
    expect(r.detail.notes.some((n) => n.includes('联系人发现'))).toBe(false);
  });

  it('rejected / 可达的线索不带 MISSING_CONTACT_POINT', () => {
    expect(scoreLead(xinLike([]), icp, { authoritativeFit: 'mismatch' }).detail.reasonCodes).toEqual([]);
    expect(scoreLead(xinLike([page('contact_page')]), icp, { authoritativeFit: 'match' }).detail.reasonCodes).toEqual([]);
  });
});

describe('scoreLead — v3 权重（RL1 无具名联系人：Role 15% 并入 Fit .45 / Reachability .20，门槛 0.55 不变）', () => {
  it('总分 = .45 fit + 0 role + .15 intent + .15 dataQuality + .20 reachability + .05 engagement；Role 仍上报', () => {
    const r = scoreLead(
      company({
        contacts: [{ title: 'CEO', seniority: 'c_level', contactPoints: [{ type: 'email', status: 'VALID' }] }],
        companyContactPoints: [{ kind: 'contact_page', status: 'UNVERIFIED' }],
      }),
      icp,
      { nowMs: NOW },
    );
    expect(r.scores.role).toBe(0.5); // 1/2 委员会角色被覆盖：仍计算、仍上报，只是零权重
    const expected = 0.45 * r.scores.fit + 0.15 * r.scores.intent + 0.15 * r.scores.dataQuality + 0.2 * r.scores.reachability + 0.05 * r.scores.engagement;
    expect(r.totalScore).toBeCloseTo(expected, 4);
  });

  it('Role 覆盖率的变化不再改变总分', () => {
    const base = { companyContactPoints: [{ kind: 'contact_page', status: 'UNVERIFIED' }] };
    const noRole = scoreLead(company(base), icp, { nowMs: NOW });
    const fullRole = scoreLead(
      company({
        ...base,
        contacts: [
          { title: 'CEO', seniority: 'c_level', contactPoints: [] },
          { title: 'Head of Procurement', seniority: 'director', contactPoints: [] },
        ],
      }),
      icp,
      { nowMs: NOW },
    );
    expect(fullRole.scores.role).toBe(1);
    expect(noRole.scores.role).toBe(0);
    expect(fullRole.totalScore).toBe(noRole.totalScore);
  });
});

describe('scoreLead — v3 关键词代理（只扫属性值；Latin token ≥3；排除 extraction_* 与 website_profile.evidence）', () => {
  const triggers = (...triggerSignals: string[]): IcpForScoring => ({ ...icp, triggerSignals });

  it('2 字母 token「CE」不再误命中 JSON 键名 certifications', () => {
    const r = scoreLead(company({ attributes: { certifications: ['ISO 9001'] } }), triggers('CE 认证'), { nowMs: NOW });
    expect(r.detail.matchedSignals).toEqual([]);
    expect(r.scores.intent).toBe(0);
  });

  it('只扫属性值不扫键名：触发词等于键名 keywords 不算命中', () => {
    const r = scoreLead(company({ attributes: { keywords: ['industrial pumps'] } }), triggers('keywords'), { nowMs: NOW });
    expect(r.detail.matchedSignals).toEqual([]);
  });

  it('extraction_* 与 website_profile.evidence 不参与；website_profile 其余字段值参与', () => {
    const attrs = {
      extraction_evidence_digest: 'sourcing-digest',
      extraction_confidence: 0.9,
      website_profile: { evidence: ['Großhandel für Pumpen mit Lagerhaltung'], trade_role: 'distributor', _ts: daysAgo(1) },
    };
    expect(scoreLead(company({ attributes: attrs }), triggers('sourcing'), { nowMs: NOW }).detail.matchedSignals).toEqual([]);
    expect(scoreLead(company({ attributes: attrs }), triggers('Lagerhaltung'), { nowMs: NOW }).detail.matchedSignals).toEqual([]);
    expect(scoreLead(company({ attributes: attrs }), triggers('distributor'), { nowMs: NOW }).detail.matchedSignals).toEqual(['distributor']);
  });

  it('中文 2 字 token 仍有效（CJK 信息密度高）；Latin 2 字母 token 丢弃', () => {
    expect(scoreLead(company({ attributes: { keywords: ['扩产 计划'] } }), triggers('扩产'), { nowMs: NOW }).detail.matchedSignals).toEqual(['扩产']);
    expect(scoreLead(company({ attributes: { keywords: ['ce marked'] } }), triggers('ce'), { nowMs: NOW }).detail.matchedSignals).toEqual([]);
  });

  it('intent 命名空间照旧排除（不双重计数）', () => {
    const r = scoreLead(company(withIntent([{ type: 'SOURCING_OPENED', at: daysAgo(400), strength: 1 }])), triggers('sourcing'), { nowMs: NOW });
    expect(r.detail.matchedSignals).toEqual([]);
  });

  // ── W5-f：记账键与子串误命中 ──
  it('`_` 前缀的记账键（任意层级：_ts / _contact_parser / _contact_attempt_at …）不参与', () => {
    const attrs = {
      _source_note: 'expansion',
      website_profile: {
        trade_role: 'distributor',
        _ts: daysAgo(1),
        _contact_parser: 'company_contact/v1',
        _contact_attempt_at: daysAgo(1),
      },
    };
    expect(scoreLead(company({ attributes: attrs }), triggers('contact'), { nowMs: NOW }).detail.matchedSignals).toEqual([]);
    expect(scoreLead(company({ attributes: attrs }), triggers('expansion'), { nowMs: NOW }).detail.matchedSignals).toEqual([]);
    expect(scoreLead(company({ attributes: attrs }), triggers('distributor'), { nowMs: NOW }).detail.matchedSignals).toEqual([
      'distributor',
    ]);
  });

  it('Latin token 按词边界匹配：「new」不命中「news」、「DACH」不命中「Bedachung」', () => {
    const news = company({ attributes: { keywords: ['industry news'] } });
    expect(scoreLead(news, triggers('new plant'), { nowMs: NOW }).detail.matchedSignals).toEqual([]);
    const roofer = company({ attributes: { keywords: ['Bedachung und Spenglerei'] } });
    expect(scoreLead(roofer, triggers('DACH'), { nowMs: NOW }).detail.matchedSignals).toEqual([]);
  });

  it('整词仍命中：大小写不敏感，连字符 / 标点 / 行首行尾都算词边界，含变音符的词按整词', () => {
    const attrs = { keywords: ['DACH-Region distributor', 'Großhandel'], region: 'Expansion (DACH)' };
    expect(scoreLead(company({ attributes: attrs }), triggers('dach'), { nowMs: NOW }).detail.matchedSignals).toEqual(['dach']);
    expect(scoreLead(company({ attributes: attrs }), triggers('großhandel'), { nowMs: NOW }).detail.matchedSignals).toEqual([
      'großhandel',
    ]);
    expect(scoreLead(company({ attributes: { keywords: ['Pumpengroßhandel'] } }), triggers('großhandel'), { nowMs: NOW }).detail.matchedSignals).toEqual([]);
  });

  it('CJK token 仍按子串匹配（中文不按空格分词）', () => {
    expect(scoreLead(company({ attributes: { keywords: ['计划扩产中'] } }), triggers('扩产'), { nowMs: NOW }).detail.matchedSignals).toEqual([
      '扩产',
    ]);
  });
});

describe('scoreLead — v3 镜像 EXCLUSION 在权威 Fit 下只记录（ICP 22202d3c 形态）', () => {
  const mirroredIcp: IcpForScoring = {
    rules: [
      { id: 'm1', kind: 'MUST_HAVE', field: 'keywords', operator: 'contains', value: '泵' },
      { id: 'm2', kind: 'MUST_HAVE', field: 'business_model', operator: 'in', value: ['分销商', '进口商'] },
      { id: 'x1', kind: 'EXCLUSION', field: 'keywords', operator: 'not_contains', value: '泵' },
      { id: 'x2', kind: 'EXCLUSION', field: 'business_model', operator: 'not_in', value: ['分销商', '进口商'] },
      { id: 'x3', kind: 'EXCLUSION', field: 'business_model', operator: 'contains', value: '终端工厂' },
    ],
    triggerSignals: [],
    committeeRoles: [],
  };
  const reachable = company({
    industry: null,
    employeeCount: null,
    attributes: { keywords: ['industrial pumps'], business_model: 'distributor' },
    companyContactPoints: [{ kind: 'contact_page', status: 'UNVERIFIED' }],
  });

  it('权威 match：镜像 EXCLUSION 命中只进 ruleEvaluations（advisory），队列按总分 → recommended', () => {
    const r = scoreLead(reachable, mirroredIcp, { authoritativeFit: 'match' });
    expect(r.queue).toBe('recommended');
    expect(r.detail.ruleEvaluations.find((e) => e.ruleId === 'x1')).toMatchObject({ outcome: 'pass', advisory: true });
    expect(r.detail.ruleEvaluations.find((e) => e.ruleId === 'x2')).toMatchObject({ outcome: 'pass', advisory: true });
    expect(r.detail.notes.some((n) => n.includes('镜像'))).toBe(true);
  });

  it('权威 match：不是镜像的否定型 EXCLUSION（用户手加的 country not_in [DE, AT, CH]）照旧排除 → rejected', () => {
    const withHandAdded: IcpForScoring = {
      ...mirroredIcp,
      rules: [
        ...mirroredIcp.rules,
        { id: 'x4', kind: 'EXCLUSION', field: 'country', operator: 'not_in', value: ['DE', 'AT', 'CH'] },
      ],
    };
    const r = scoreLead(company({ ...reachable, country: 'PL' }), withHandAdded, { authoritativeFit: 'match' });
    expect(r.queue).toBe('rejected');
    expect(r.detail.ruleEvaluations.find((e) => e.ruleId === 'x4')).toMatchObject({ outcome: 'pass' });
    expect(r.detail.ruleEvaluations.find((e) => e.ruleId === 'x4')).not.toHaveProperty('advisory');
    // 范围内的国家不触发它，镜像规则仍只记录 → recommended
    expect(scoreLead(company({ ...reachable, country: 'AT' }), withHandAdded, { authoritativeFit: 'match' }).queue).toBe(
      'recommended',
    );
  });

  it('权威 match：正向 EXCLUSION 命中仍 rejected（最高优先）', () => {
    const r = scoreLead(
      company({ ...reachable, attributes: { keywords: ['industrial pumps'], business_model: '终端工厂' } }),
      mirroredIcp,
      { authoritativeFit: 'match' },
    );
    expect(r.queue).toBe('rejected');
  });

  it('无权威 Fit：镜像 EXCLUSION 照旧 rejected（规则引擎老路径行为不变）', () => {
    expect(scoreLead(reachable, mirroredIcp).queue).toBe('rejected');
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
