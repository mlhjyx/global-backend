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
  });
});
