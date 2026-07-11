import { isValidLawfulBasis } from '../discovery/compliance/email-verification-gate';
import {
  DataAction,
  DataRightsContext,
  DataRightsDecision,
  JurisdictionRule,
  PolicyEffect,
} from './data-rights.types';

/**
 * 收口⑥ DataRights 判定引擎（**确定性纯函数**，LLM 绝不参与——ADR-010）。
 * 规则来自 jurisdiction_policy 数据行（含 PIPL 法域对）；本文件不触 DB、不读时钟/env。
 *
 * 判定序：禁联 > 证据先行 > green 放行 > 规则匹配（最具体优先，同分取更严）> fail-closed。
 */

const EVIDENCE_REQUIRED_ACTIONS: ReadonlySet<DataAction> = new Set<DataAction>(['DERIVE', 'EXPORT']);
const ARTICLE14_ACTIONS: ReadonlySet<DataAction> = new Set<DataAction>(['STORE', 'AI_PROCESS', 'DERIVE', 'OUTREACH']);

/** effect 严格度（同特异度冲突时取更严=fail-safe 偏置）。 */
const EFFECT_RANK: Record<PolicyEffect, number> = {
  DENY: 3,
  REQUIRE_APPROVAL: 2,
  ALLOW_WITH_BASIS: 1,
  ALLOW: 0,
};

/** 该行是否匹配 ctx；返回特异度分（精确维各 +1，通配 0），不匹配返回 -1。 */
function matchScore(rule: JurisdictionRule, ctx: DataRightsContext): number {
  let score = 0;
  if (rule.subjectJurisdiction !== '*') {
    if (rule.subjectJurisdiction !== ctx.subjectJurisdiction) return -1;
    score += 1;
  }
  if (rule.processorJurisdiction !== '*') {
    if (rule.processorJurisdiction !== ctx.processorJurisdiction) return -1;
    score += 1;
  }
  if (rule.dataClass !== '*') {
    if (rule.dataClass !== ctx.dataClass) return -1;
    score += 1;
  }
  if (rule.action !== '*') {
    if (rule.action !== ctx.action) return -1;
    score += 1;
  }
  return score;
}

/** 选最具体规则；同特异度取更严 effect（确定性，与输入顺序无关）。 */
function pickRule(ctx: DataRightsContext, rules: readonly JurisdictionRule[]): JurisdictionRule | null {
  let best: JurisdictionRule | null = null;
  let bestScore = -1;
  for (const r of rules) {
    const s = matchScore(r, ctx);
    if (s < 0) continue;
    if (s > bestScore || (s === bestScore && best !== null && EFFECT_RANK[r.effect] > EFFECT_RANK[best.effect])) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}

export function evaluateDataRights(ctx: DataRightsContext, rules: readonly JurisdictionRule[]): DataRightsDecision {
  const derivedArticle14 =
    ctx.dataClass === 'red' &&
    ARTICLE14_ACTIONS.has(ctx.action) &&
    (ctx.subjectJurisdiction === 'EU' || ctx.subjectJurisdiction === 'UK');

  const make = (over: Partial<DataRightsDecision> & { effect: PolicyEffect; allowed: boolean; reason: string }): DataRightsDecision => ({
    ruleId: null,
    ruleVersion: '',
    requiresLawfulBasis: false,
    article14NoticeRequired: derivedArticle14,
    ...over,
  });

  // 1. 禁联最先（对外动作第一道检查，先于一切）。
  if (ctx.suppressed) {
    return make({ effect: 'DENY', allowed: false, reason: 'suppressed', requiresLawfulBasis: ctx.dataClass === 'red' });
  }

  // 2. 证据先行红线（覆盖所有分级：无 evidence 不评分/不导出）。
  if (ctx.hasEvidence === false && EVIDENCE_REQUIRED_ACTIONS.has(ctx.action)) {
    return make({ effect: 'DENY', allowed: false, reason: 'no_evidence' });
  }

  // 3. green 公司事实无限制。
  if (ctx.dataClass === 'green') {
    return make({ effect: 'ALLOW', allowed: true, reason: 'green_company_fact' });
  }

  // 4. 规则匹配（amber/red）。
  const rule = pickRule(ctx, rules);
  if (!rule) {
    return make({
      effect: 'DENY',
      allowed: false,
      reason: ctx.dataClass === 'red' ? 'unregistered_red' : 'unregistered',
    });
  }

  const ruleId = rule.id ?? null;
  const ruleVersion = rule.ruleVersion;
  const article14NoticeRequired = derivedArticle14 || rule.article14Required;

  switch (rule.effect) {
    case 'ALLOW':
      return {
        effect: 'ALLOW',
        allowed: true,
        reason: `allow:${ctx.action}`,
        ruleId,
        ruleVersion,
        requiresLawfulBasis: rule.requiresLawfulBasis,
        article14NoticeRequired,
      };
    case 'ALLOW_WITH_BASIS': {
      const ok = isValidLawfulBasis(ctx.lawfulBasis ?? undefined);
      return {
        effect: 'ALLOW_WITH_BASIS',
        allowed: ok,
        reason: ok ? `allow_with_basis:${ctx.lawfulBasis!.basis}` : 'no_lawful_basis',
        ruleId,
        ruleVersion,
        requiresLawfulBasis: true,
        article14NoticeRequired,
      };
    }
    case 'REQUIRE_APPROVAL':
      return {
        effect: 'REQUIRE_APPROVAL',
        allowed: false,
        reason: 'require_approval',
        ruleId,
        ruleVersion,
        requiresLawfulBasis: rule.requiresLawfulBasis,
        article14NoticeRequired,
      };
    case 'DENY':
    default:
      return {
        effect: 'DENY',
        allowed: false,
        reason: 'policy_deny',
        ruleId,
        ruleVersion,
        requiresLawfulBasis: rule.requiresLawfulBasis,
        article14NoticeRequired,
      };
  }
}
