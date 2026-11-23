import { describe, expect, it } from 'vitest';
import {
  applyBroadIndustryGate,
  BROAD_FALLBACK_INDUSTRY_QIDS,
  BROAD_WIKIDATA_INDUSTRY_QIDS,
  isSpecificIndustryNode,
  wikidataBroadIndustryMode,
} from './wikidata-industry-scope';

describe('Wikidata 行业枢轴闸门', () => {
  it('制造业根编号被拒绝，窄编号放行', () => {
    expect(applyBroadIndustryGate(['Q187939'], 'enforce')).toEqual({
      accepted: [],
      rejected: ['Q187939'],
    });
    expect(applyBroadIndustryGate(['Q192127'], 'enforce')).toEqual({
      accepted: ['Q192127'],
      rejected: [],
    });
  });

  it('混合列表只保留窄编号，顺序稳定且去重', () => {
    expect(applyBroadIndustryGate(['Q187939', 'Q192127', 'Q187939', 'Q220695'], 'enforce')).toEqual({
      accepted: ['Q192127', 'Q220695'],
      rejected: ['Q187939'],
    });
  });

  it('off 模式不改动输入', () => {
    expect(applyBroadIndustryGate(['Q187939', 'Q192127'], 'off')).toEqual({
      accepted: ['Q187939', 'Q192127'],
      rejected: [],
    });
  });

  it('回退集合拒绝已核验的机械大类，注入集合只按宽度拒绝制造业根', () => {
    expect(BROAD_WIKIDATA_INDUSTRY_QIDS.has('Q1957908')).toBe(false);
    expect(BROAD_FALLBACK_INDUSTRY_QIDS.has('Q1957908')).toBe(true);
    expect(applyBroadIndustryGate(['Q1957908', 'Q192127'], 'enforce', BROAD_FALLBACK_INDUSTRY_QIDS)).toEqual({
      accepted: ['Q192127'],
      rejected: ['Q1957908'],
    });
    expect(applyBroadIndustryGate(['Q1957908'], 'enforce')).toEqual({
      accepted: ['Q1957908'],
      rejected: [],
    });
  });

  it('env 只认 off；缺省与未知值 fail-safe 到 enforce', () => {
    expect(wikidataBroadIndustryMode('off')).toBe('off');
    expect(wikidataBroadIndustryMode(' OFF ')).toBe('off');
    expect(wikidataBroadIndustryMode(undefined)).toBe('enforce');
    expect(wikidataBroadIndustryMode('')).toBe('enforce');
    expect(wikidataBroadIndustryMode('shadow')).toBe('enforce');
  });

  it('节点级判断：字母 section 与两位 division 视为过宽，三位以上数字码视为具体', () => {
    expect(isSpecificIndustryNode({ code: 'C', wikidataQid: 'Q187939' })).toBe(false);
    expect(isSpecificIndustryNode({ code: '28', wikidataQid: 'Q1957908' })).toBe(false);
    expect(isSpecificIndustryNode({ code: '279', wikidataQid: 'Q192127' })).toBe(true);
    expect(isSpecificIndustryNode({ code: '2610', wikidataQid: 'Q2986369' })).toBe(true);
    expect(isSpecificIndustryNode({ code: '4659', wikidataQid: 'Q220695' })).toBe(true);
    expect(isSpecificIndustryNode({ code: '279', wikidataQid: null })).toBe(false);
  });
});


describe('known unrelated legacy entities never become industry pivots', () => {
  it.each(['Q1857831', 'Q11661', 'Q206894'])(
    'rejects the unrelated entity %s even if the broad-industry switch is off', (qid) => {
      for (const mode of ['enforce', 'off'] as const) {
        expect(applyBroadIndustryGate([qid, 'Q192127'], mode)).toEqual({
          accepted: ['Q192127'], rejected: [qid],
        });
      }
    },
  );
});
