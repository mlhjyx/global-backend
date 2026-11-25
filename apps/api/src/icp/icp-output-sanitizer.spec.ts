import { describe, expect, it } from 'vitest';
import {
  filterUnmatchableIcpRules,
  ICP_GENERATION_QUALITY_RULES,
  normalizeIcpCompanyAttributes,
  sanitizeIcpExclusions,
} from './icp-output-sanitizer';

describe('icp-output-sanitizer', () => {
  it('exposes explicit quality rules against competitor mixing and CJK-only rules', () => {
    expect(ICP_GENERATION_QUALITY_RULES).toContain('严禁把同行业竞争对手');
    expect(ICP_GENERATION_QUALITY_RULES).toContain('NICE_TO_HAVE');
    expect(ICP_GENERATION_QUALITY_RULES).toContain('exclusions');
  });

  it('strips AI meta-notes from exclusions while keeping real business exclusions', () => {
    const out = sanitizeIcpExclusions([
      '上游光伏组件制造同行',
      '执行约定：规则仅评估企业级目标特征',
      '数据约定：country为注册国ISO代码',
      '纯个人消费者与家庭终端用户',
    ]);
    expect(out).toEqual(['上游光伏组件制造同行', '纯个人消费者与家庭终端用户']);
  });

  it('sets process_required=false for downstream distributor/EPC ICPs and normalizes verbose trade_side', () => {
    const attrs = normalizeIcpCompanyAttributes({
      sub_industry: ['光伏组件进口分销', 'EPC工程承包'],
      business_model: '进口分销与电站EPC集成',
      trade_side: '企业级采购方或具备实际采购职责的渠道与项目集成方（分销商）',
    });
    expect(attrs.process_required).toBe(false);
    expect(attrs.trade_side).toBe('distributor');
  });

  it('preserves explicit process_required=true and manufacturing buyer ICPs', () => {
    const attrs = normalizeIcpCompanyAttributes({
      business_model: 'OEM factory with CNC machining',
      process_required: true,
    });
    expect(attrs.process_required).toBe(true);
  });

  it('drops unmatchable Chinese-only MUST_HAVE regexes and hallucinated EXCLUSION sentences for European markets', () => {
    const rules = [
      { kind: 'MUST_HAVE' as const, field: 'country', operator: 'in', value: ['IT', 'DE'] },
      { kind: 'MUST_HAVE' as const, field: 'keywords', operator: 'matches', value: '(光伏组件采购|HJT电池片采购)' },
      { kind: 'MUST_HAVE' as const, field: 'keywords', operator: 'matches', value: '(photovoltaic|fotovoltaico|solar)' },
      { kind: 'EXCLUSION' as const, field: 'keywords', operator: 'contains', value: '已确认无相关外购需求及采购影响力' },
      { kind: 'NICE_TO_HAVE' as const, field: 'keywords', operator: 'contains', value: 'HJT' },
    ];
    const kept = filterUnmatchableIcpRules(rules, ['IT', 'DE']);
    expect(kept.map((r) => r.value)).toEqual([
      ['IT', 'DE'],
      '(photovoltaic|fotovoltaico|solar)',
      'HJT',
    ]);
  });

  it('keeps Chinese MUST_HAVE rules when target markets include CN', () => {
    const rules = [
      { kind: 'MUST_HAVE' as const, field: 'keywords', operator: 'matches', value: '(光伏组件|逆变器)' },
    ];
    expect(filterUnmatchableIcpRules(rules, ['CN'])).toHaveLength(1);
  });
});
