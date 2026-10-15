import { describe, expect, it } from 'vitest';
import {
  evaluateRule,
  isNegativeOperator,
  lintQualificationRules,
  mirrorExclusionRuleIndexes,
  qualify,
  RuleLike,
} from './rule-engine';

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

// ── v3：权威 Fit 存在时，只有 MUST_HAVE 的镜像 EXCLUSION 只记录不排除（W5-f 收窄：不是所有否定型 EXCLUSION）──
describe('qualify — mirrorExclusionsAdvisory（镜像 EXCLUSION 只记录，非镜像否定型照旧排除）', () => {
  const rules: RuleLike[] = [
    { id: 'm1', kind: 'MUST_HAVE', field: 'keywords', operator: 'contains', value: '泵' },
    { id: 'x1', kind: 'EXCLUSION', field: 'keywords', operator: 'not_contains', value: '泵' }, // m1 的镜像
    { id: 'x2', kind: 'EXCLUSION', field: 'business_model', operator: 'not_in', value: ['分销商', '进口商'] }, // 无对应 MUST_HAVE
    { id: 'x3', kind: 'EXCLUSION', field: 'country', operator: 'neq', value: 'DE' }, // 无对应 MUST_HAVE
    { id: 'x4', kind: 'EXCLUSION', field: 'business_model', operator: 'contains', value: '终端工厂' }, // 正向
  ];
  // 公司 keywords 是受控英文词表，永远不含中文：镜像 EXCLUSION「keywords not_contains 泵」对每家公司都 pass。
  const onlyMirrorHits = { keywords: ['industrial pumps'], business_model: '分销商', country: 'DE' };

  it('默认（无权威 Fit）：镜像 EXCLUSION 命中照旧 exclude（行为不变）', () => {
    expect(qualify(rules, onlyMirrorHits).verdict).toBe('exclude');
  });

  it('advisory：只有镜像规则带 advisory=true、命中不产生 exclude；非镜像否定型与正向规则不带 advisory', () => {
    const r = qualify(rules, onlyMirrorHits, { mirrorExclusionsAdvisory: true });
    expect(r.verdict).toBe('no_match'); // MUST_HAVE「keywords contains 泵」对英文词表 fail（权威 Fit 会覆盖 Fit 维）
    expect(r.evaluations.find((e) => e.ruleId === 'x1')).toMatchObject({ outcome: 'pass', advisory: true });
    for (const id of ['x2', 'x3', 'x4', 'm1']) {
      expect(r.evaluations.find((e) => e.ruleId === id), id).not.toHaveProperty('advisory');
    }
  });

  it('advisory：非镜像否定型 EXCLUSION 命中照旧 exclude（如 business_model not_in […] 没有对应的 MUST_HAVE）', () => {
    const r = qualify(rules, { ...onlyMirrorHits, business_model: 'distributor' }, { mirrorExclusionsAdvisory: true });
    expect(r.verdict).toBe('exclude');
    expect(r.evaluations.find((e) => e.ruleId === 'x2')).toMatchObject({ outcome: 'pass' });
    const country = qualify(rules, { ...onlyMirrorHits, country: 'PL' }, { mirrorExclusionsAdvisory: true });
    expect(country.verdict).toBe('exclude');
  });

  it('advisory：同一条 not_in 有对应 MUST_HAVE（同 field 同 value）时才是镜像，才只记录', () => {
    const withMustHave: RuleLike[] = [
      ...rules,
      { id: 'm2', kind: 'MUST_HAVE', field: 'business_model', operator: 'in', value: ['进口商', '分销商'] },
    ];
    const r = qualify(withMustHave, { ...onlyMirrorHits, business_model: 'distributor' }, { mirrorExclusionsAdvisory: true });
    expect(r.verdict).toBe('no_match');
    expect(r.evaluations.find((e) => e.ruleId === 'x2')).toMatchObject({ outcome: 'pass', advisory: true });
  });

  it('advisory：正向 EXCLUSION（contains / in / eq）命中仍 exclude（最高优先）', () => {
    const r = qualify(rules, { ...onlyMirrorHits, business_model: '终端工厂' }, { mirrorExclusionsAdvisory: true });
    expect(r.verdict).toBe('exclude');
    expect(r.evaluations.find((e) => e.ruleId === 'x4')).toMatchObject({ outcome: 'pass' });
  });

  it('advisory 关闭（显式 false）与缺省等价', () => {
    expect(qualify(rules, onlyMirrorHits, { mirrorExclusionsAdvisory: false }).verdict).toBe('exclude');
  });
});

describe('mirrorExclusionRuleIndexes / lintQualificationRules（MUST_HAVE 的镜像 EXCLUSION）', () => {
  it('同 field 同 value 的否定型 EXCLUSION 是镜像；field 与 value 归一化后比较（大小写 / 下划线 / 数组顺序 / 空白）', () => {
    const rules: RuleLike[] = [
      { kind: 'MUST_HAVE', field: 'keywords', operator: 'contains', value: '泵' },
      { kind: 'MUST_HAVE', field: 'business_model', operator: 'in', value: ['分销商', '进口商'] },
      { kind: 'MUST_HAVE', field: 'region', operator: 'contains', value: 'DACH' },
      { kind: 'EXCLUSION', field: 'keywords', operator: 'not_contains', value: ' 泵 ' },
      { kind: 'EXCLUSION', field: 'businessModel', operator: 'not_in', value: ['进口商', '分销商'] },
      { kind: 'EXCLUSION', field: 'region', operator: 'not_contains', value: 'dach' },
      { kind: 'EXCLUSION', field: 'keywords', operator: 'not_contains', value: '阀门' }, // 不同 value → 非镜像
      { kind: 'EXCLUSION', field: 'business_model', operator: 'contains', value: '终端工厂' }, // 正向 → 非镜像
      { kind: 'NICE_TO_HAVE', field: 'keywords', operator: 'contains', value: '泵' }, // 非 EXCLUSION
    ];
    expect(mirrorExclusionRuleIndexes(rules)).toEqual([3, 4, 5]);
    const lint = lintQualificationRules(rules);
    // 3 条镜像提示 + 1 条非镜像否定型排除提示（keywords not_contains 阀门）
    expect(lint).toHaveLength(4);
    expect(lint[0]).toContain('keywords');
    expect(lint[0]).toContain('not_contains');
    expect(lint[0]).toContain('镜像');
    expect(lint[1]).toContain('businessModel');
    expect(lint[3]).toContain('阀门');
    expect(lint[3]).not.toContain('镜像');
  });

  it('非镜像的否定型 EXCLUSION → 一条提示：资格门已判 Fit 时它仍然排除（如手加的 country not_in [DE, AT, CH]）', () => {
    const lint = lintQualificationRules([
      { id: 'r-country', kind: 'EXCLUSION', field: 'country', operator: 'not_in', value: ['DE', 'AT', 'CH'] },
    ]);
    expect(lint).toHaveLength(1);
    expect(lint[0]).toContain('r-country');
    expect(lint[0]).toContain('country');
    expect(lint[0]).toContain('not_in');
    expect(lint[0]).toContain('仍然排除');
  });

  it('无否定型 EXCLUSION → 无镜像、无提示；只有否定型 EXCLUSION 而无 MUST_HAVE → 无镜像', () => {
    expect(
      mirrorExclusionRuleIndexes([{ kind: 'EXCLUSION', field: 'keywords', operator: 'not_contains', value: '泵' }]),
    ).toEqual([]);
    expect(
      lintQualificationRules([
        { kind: 'MUST_HAVE', field: 'keywords', operator: 'contains', value: '泵' },
        { kind: 'EXCLUSION', field: 'country', operator: 'in', value: ['RU'] },
      ]),
    ).toEqual([]);
  });

  it('isNegativeOperator：neq / not_in / not_contains 为否定型，其余为正向', () => {
    for (const op of ['neq', 'not_in', 'not_contains']) expect(isNegativeOperator(op)).toBe(true);
    for (const op of ['eq', 'in', 'contains', 'gte', 'lte', 'matches', 'bogus']) expect(isNegativeOperator(op)).toBe(false);
  });
});
