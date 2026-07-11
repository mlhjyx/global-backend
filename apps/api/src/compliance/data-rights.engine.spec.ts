import { describe, it, expect } from 'vitest';
import { evaluateDataRights } from './data-rights.engine';
import { JURISDICTION_POLICY_SEED } from './jurisdiction-policy.seed';
import { DataRightsContext, JurisdictionRule } from './data-rights.types';
import type { LawfulBasis } from '../discovery/provider-contract';

// 用真实种子行作规则集（id 由 DB 赋，引擎 id 可选 → ruleId null）。
const RULES = JURISDICTION_POLICY_SEED as readonly JurisdictionRule[];
const LIA: LawfulBasis = { basis: 'legitimate_interest', ref: 'LIA-2026-001' };

function ctx(over: Partial<DataRightsContext>): DataRightsContext {
  return {
    action: 'STORE',
    dataClass: 'red',
    subjectJurisdiction: 'EU',
    processorJurisdiction: 'EU',
    ...over,
  };
}

describe('evaluateDataRights — 分级与放行', () => {
  it('green 公司事实任何动作放行', () => {
    const d = evaluateDataRights(ctx({ dataClass: 'green', action: 'EXPORT', hasEvidence: true }), RULES);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('green_company_fact');
  });

  it('amber 职能邮箱 OUTREACH 放行（ePrivacy）', () => {
    const d = evaluateDataRights(ctx({ dataClass: 'amber', action: 'OUTREACH' }), RULES);
    expect(d.allowed).toBe(true);
    expect(d.article14NoticeRequired).toBe(false);
  });
});

describe('evaluateDataRights — red EU（GDPR）', () => {
  it('STORE 放行且 Art.14 义务', () => {
    const d = evaluateDataRights(ctx({ action: 'STORE' }), RULES);
    expect(d.allowed).toBe(true);
    expect(d.article14NoticeRequired).toBe(true);
  });

  it('AI_PROCESS 无 basis → 拒（no_lawful_basis），仍标 Art.14', () => {
    const d = evaluateDataRights(ctx({ action: 'AI_PROCESS' }), RULES);
    expect(d.effect).toBe('ALLOW_WITH_BASIS');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('no_lawful_basis');
    expect(d.requiresLawfulBasis).toBe(true);
    expect(d.article14NoticeRequired).toBe(true);
  });

  it('AI_PROCESS 有有效 basis → 放行', () => {
    const d = evaluateDataRights(ctx({ action: 'AI_PROCESS', lawfulBasis: LIA }), RULES);
    expect(d.allowed).toBe(true);
    expect(d.reason).toBe('allow_with_basis:legitimate_interest');
  });

  it('无效 basis（未知 kind）不解锁', () => {
    const bad = { basis: 'vibes' } as unknown as LawfulBasis;
    const d = evaluateDataRights(ctx({ action: 'OUTREACH', lawfulBasis: bad }), RULES);
    expect(d.allowed).toBe(false);
  });

  it('VIEW 放行且无 Art.14（VIEW 不在告知触发动作集）', () => {
    const d = evaluateDataRights(ctx({ action: 'VIEW' }), RULES);
    expect(d.allowed).toBe(true);
    expect(d.article14NoticeRequired).toBe(false);
  });
});

describe('evaluateDataRights — red US（较宽）', () => {
  it('AI_PROCESS 无 basis 也放行', () => {
    const d = evaluateDataRights(ctx({ action: 'AI_PROCESS', subjectJurisdiction: 'US', processorJurisdiction: 'US' }), RULES);
    expect(d.allowed).toBe(true);
    expect(d.article14NoticeRequired).toBe(false);
  });

  it('OUTREACH 仍需 basis', () => {
    const d = evaluateDataRights(ctx({ action: 'OUTREACH', subjectJurisdiction: 'US', processorJurisdiction: 'US' }), RULES);
    expect(d.allowed).toBe(false);
    expect(d.effect).toBe('ALLOW_WITH_BASIS');
  });
});

describe('evaluateDataRights — PIPL 跨境（最具体优先）', () => {
  it('EU 主体 → CN 处理地 AI_PROCESS：REQUIRE_APPROVAL（即便有 basis 也人审）', () => {
    const d = evaluateDataRights(ctx({ action: 'AI_PROCESS', processorJurisdiction: 'CN', lawfulBasis: LIA }), RULES);
    expect(d.effect).toBe('REQUIRE_APPROVAL');
    expect(d.allowed).toBe(false);
  });

  it('EU 主体 → EU 处理地 AI_PROCESS：非 PIPL，走 ALLOW_WITH_BASIS', () => {
    const d = evaluateDataRights(ctx({ action: 'AI_PROCESS', processorJurisdiction: 'EU', lawfulBasis: LIA }), RULES);
    expect(d.effect).toBe('ALLOW_WITH_BASIS');
    expect(d.allowed).toBe(true);
  });

  it('CN 主体 OUTREACH：REQUIRE_APPROVAL', () => {
    const d = evaluateDataRights(ctx({ action: 'OUTREACH', subjectJurisdiction: 'CN', processorJurisdiction: 'US' }), RULES);
    expect(d.effect).toBe('REQUIRE_APPROVAL');
  });
});

describe('evaluateDataRights — 红线优先级', () => {
  it('禁联最先（先于分级/规则）', () => {
    const d = evaluateDataRights(ctx({ action: 'STORE', suppressed: true }), RULES);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('suppressed');
  });

  it('证据先行：DERIVE 无 evidence → 拒（连 green 也拦）', () => {
    const d = evaluateDataRights(ctx({ dataClass: 'green', action: 'DERIVE', hasEvidence: false }), RULES);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('no_evidence');
  });

  it('证据先行：EXPORT 无 evidence 先于 basis 判定', () => {
    const d = evaluateDataRights(ctx({ action: 'EXPORT', hasEvidence: false, lawfulBasis: LIA }), RULES);
    expect(d.reason).toBe('no_evidence');
  });

  it('hasEvidence undefined 不拦（调用方未断言）', () => {
    const d = evaluateDataRights(ctx({ action: 'DERIVE', dataClass: 'green' }), RULES);
    expect(d.allowed).toBe(true);
  });
});

describe('evaluateDataRights — fail-closed & 确定性', () => {
  it('空规则集：red → DENY unregistered_red', () => {
    const d = evaluateDataRights(ctx({ action: 'STORE' }), []);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('unregistered_red');
  });

  it('同特异度冲突取更严 effect（与输入顺序无关）', () => {
    const lenient: JurisdictionRule = { subjectJurisdiction: 'EU', processorJurisdiction: '*', dataClass: 'red', action: 'STORE', effect: 'ALLOW', requiresLawfulBasis: false, article14Required: false, ruleVersion: 'v1' };
    const strict: JurisdictionRule = { ...lenient, effect: 'DENY' };
    const forward = evaluateDataRights(ctx({ action: 'STORE' }), [lenient, strict]);
    const reverse = evaluateDataRights(ctx({ action: 'STORE' }), [strict, lenient]);
    expect(forward.effect).toBe('DENY');
    expect(reverse.effect).toBe('DENY');
  });
});
