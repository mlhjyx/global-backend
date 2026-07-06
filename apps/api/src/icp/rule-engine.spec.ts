import { describe, expect, it } from 'vitest';
import { evaluateRule, qualify, RuleLike } from './rule-engine';

const rule = (partial: Partial<RuleLike>): RuleLike => ({
  kind: 'MUST_HAVE',
  field: 'industry',
  operator: 'eq',
  value: 'manufacturing',
  ...partial,
});

describe('evaluateRule', () => {
  it('eq 大小写不敏感', () => {
    expect(evaluateRule(rule({}), { industry: 'Manufacturing' })).toBe('pass');
    expect(evaluateRule(rule({}), { industry: 'software' })).toBe('fail');
  });

  it('缺失属性 → unknown（不硬判）', () => {
    expect(evaluateRule(rule({}), {})).toBe('unknown');
    expect(evaluateRule(rule({}), { industry: '' })).toBe('unknown');
  });

  it('属性名变体匹配（employee_count vs employeeCount）', () => {
    expect(evaluateRule(rule({ field: 'employee_count', operator: 'gte', value: 100 }), { employeeCount: 200 })).toBe(
      'pass',
    );
  });

  it('in / not_in 数组重叠', () => {
    expect(evaluateRule(rule({ operator: 'in', value: ['a', 'b'] }), { industry: ['B', 'c'] })).toBe('pass');
    expect(evaluateRule(rule({ operator: 'not_in', value: ['a'] }), { industry: 'a' })).toBe('fail');
  });

  it('contains 子串', () => {
    expect(evaluateRule(rule({ operator: 'contains', value: '激光' }), { industry: '激光切割设备' })).toBe('pass');
  });

  it('gte 支持区间字符串 "51-200" 与 "200+"', () => {
    expect(evaluateRule(rule({ field: 'employee_count', operator: 'gte', value: 100 }), { employee_count: '51-200' })).toBe('pass');
    expect(evaluateRule(rule({ field: 'employee_count', operator: 'gte', value: 500 }), { employee_count: '200+' })).toBe('pass');
    expect(evaluateRule(rule({ field: 'employee_count', operator: 'gte', value: 300 }), { employee_count: '51-200' })).toBe('fail');
  });

  it('matches 非法正则 → unknown 而非崩溃', () => {
    expect(evaluateRule(rule({ operator: 'matches', value: '([' }), { industry: 'x' })).toBe('unknown');
  });
});

describe('qualify（优先级：EXCLUSION > MUST_HAVE fail > unknown > match）', () => {
  const rules: RuleLike[] = [
    { kind: 'EXCLUSION', field: 'country', operator: 'in', value: ['RU'] },
    { kind: 'MUST_HAVE', field: 'employee_count', operator: 'gte', value: 100 },
    { kind: 'NICE_TO_HAVE', field: 'certifications', operator: 'contains', value: 'ISO 9001', weight: 2 },
    { kind: 'NICE_TO_HAVE', field: 'keywords', operator: 'contains', value: 'laser', weight: 1 },
  ];

  it('排除命中 → exclude，无视其他', () => {
    expect(qualify(rules, { country: 'RU', employee_count: 5000 }).verdict).toBe('exclude');
  });

  it('必要条件 fail → no_match', () => {
    expect(qualify(rules, { country: 'DE', employee_count: 50 }).verdict).toBe('no_match');
  });

  it('必要条件缺数据 → review', () => {
    expect(qualify(rules, { country: 'DE' }).verdict).toBe('review');
  });

  it('全过 → match，加权分正确（2/3 权重命中）', () => {
    const r = qualify(rules, { country: 'DE', employee_count: 300, certifications: ['ISO 9001:2015'] });
    expect(r.verdict).toBe('match');
    expect(r.score).toBeCloseTo(2 / 3, 3);
  });
});
