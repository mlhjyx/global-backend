import { describe, expect, it } from 'vitest';
import { mapIndustryToQids, mapCountryToQid, INDUSTRY_OSM_TAGS, REGION_OSM_AREA } from './vocab';

describe('规范词表归一（中/英 → 结构化标识）', () => {
  it('中文与英文行业词映射到同一 Wikidata QID', () => {
    expect(mapIndustryToQids(['金属加工'])).toEqual(mapIndustryToQids(['metal fabrication']));
    expect(mapIndustryToQids(['汽车'])).toEqual(['Q190117']);
    expect(mapIndustryToQids(['automotive'])).toEqual(['Q190117']);
  });

  it('多个行业词去重合并', () => {
    const qids = mapIndustryToQids(['金属加工', 'metalworking', '钣金']);
    expect(qids).toContain('Q19541171'); // 金属加工/metalworking 同 QID
    expect(new Set(qids).size).toBe(qids.length); // 无重复
  });

  it('国家词中英一致映射', () => {
    expect(mapCountryToQid('德国')).toBe('Q183');
    expect(mapCountryToQid('Germany')).toBe('Q183');
    expect(mapCountryToQid('deutschland')).toBe('Q183');
  });

  it('未知词返回空/undefined（不猜）', () => {
    expect(mapIndustryToQids(['不存在的行业'])).toEqual([]);
    expect(mapCountryToQid('Atlantis')).toBeUndefined();
  });

  it('行业 → OSM 标签映射（金属加工 → craft/industrial 标签）', () => {
    const tags = INDUSTRY_OSM_TAGS['金属加工'];
    expect(tags).toBeDefined();
    expect(tags.some((t) => t.k === 'craft' && t.v === 'metal_construction')).toBe(true);
  });

  it('地区 → OSM area 名', () => {
    expect(REGION_OSM_AREA['德国']).toBe('Deutschland');
    expect(REGION_OSM_AREA['baden-württemberg']).toBe('Baden-Württemberg');
  });
});
