import { describe, expect, it } from 'vitest';
import { selectFairs, TRADE_FAIRS } from './trade-fairs';

describe('展会模板选择（按 ICP 行业词匹配）', () => {
  it('钣金/激光行业命中 EuroBLECH', () => {
    const fairs = selectFairs({ industryTerms: ['sheet metal working'], keywords: ['laser cutting'] });
    expect(fairs.map((f) => f.slug)).toContain('euroblech-2026');
  });

  it('中文行业词也能命中（主题词含中文）', () => {
    const fairs = selectFairs({ industryTerms: ['钣金'], keywords: [] });
    expect(fairs.some((f) => f.slug === 'euroblech-2026')).toBe(true);
  });

  it('无关行业不命中（不乱拉参展商）', () => {
    expect(selectFairs({ industryTerms: ['pharmaceutical packaging'], keywords: ['vaccine'] })).toEqual([]);
  });

  it('空输入返回空', () => {
    expect(selectFairs({})).toEqual([]);
  });

  it('每个模板配置完整（Algolia 四要素齐备）', () => {
    for (const f of TRADE_FAIRS) {
      expect(f.algolia.appId).toBeTruthy();
      expect(f.algolia.apiKey).toBeTruthy();
      expect(f.algolia.indexName).toMatch(/index/);
      expect(f.algolia.eventEditionId).toMatch(/^eve-/);
      expect(f.topics.length).toBeGreaterThan(3);
    }
  });
});
