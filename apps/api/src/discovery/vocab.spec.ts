import { describe, expect, it } from 'vitest';
import {
  mapIndustryToQids,
  mapCountryToQid,
  lookupCountryIso,
  lookupMarketRegion,
  expandMarketRegions,
  COUNTRY_ISO,
  INDUSTRY_OSM_TAGS,
  REGION_OSM_AREA,
} from './vocab';

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

describe('国家归一：奥地利、瑞士、荷兰、波兰、西班牙与「DACH」', () => {
  it.each([
    ['奥地利', 'AT', 'Q40'], ['Austria', 'AT', 'Q40'], ['Österreich', 'AT', 'Q40'],
    ['瑞士', 'CH', 'Q39'], ['Switzerland', 'CH', 'Q39'], ['Schweiz', 'CH', 'Q39'],
    ['荷兰', 'NL', 'Q55'], ['Netherlands', 'NL', 'Q55'], ['Nederland', 'NL', 'Q55'],
    ['波兰', 'PL', 'Q36'], ['Poland', 'PL', 'Q36'], ['Polska', 'PL', 'Q36'],
    ['西班牙', 'ES', 'Q29'], ['Spain', 'ES', 'Q29'], ['España', 'ES', 'Q29'],
  ])('%s → %s / %s（中文名、英文名、本国语名，与已有国家同样的写法）', (term, iso, qid) => {
    expect(lookupCountryIso(term)).toBe(iso);
    expect(mapCountryToQid(term)).toBe(qid);
  });

  it('变音符经 NFD 进来也能归一', () => {
    expect(lookupCountryIso('Österreich'.normalize('NFD'))).toBe('AT');
    expect(lookupCountryIso(' ESPAÑA '.normalize('NFD'))).toBe('ES');
  });

  it('已有国家的映射逐条不变，国家码只新增 AT/CH/NL/PL/ES', () => {
    const before: Record<string, string> = {
      德国: 'DE', germany: 'DE', deutschland: 'DE',
      美国: 'US', usa: 'US', 'united states': 'US',
      中国: 'CN', china: 'CN', 日本: 'JP', japan: 'JP', 意大利: 'IT', italy: 'IT',
      法国: 'FR', france: 'FR', 英国: 'GB', uk: 'GB', 印度: 'IN', india: 'IN',
    };
    for (const [term, iso] of Object.entries(before)) expect(lookupCountryIso(term)).toBe(iso);
    expect(lookupCountryIso('us')).toBeUndefined();
    expect([...new Set(Object.values(COUNTRY_ISO))].sort()).toEqual(
      ['AT', 'CH', 'CN', 'DE', 'ES', 'FR', 'GB', 'IN', 'IT', 'JP', 'NL', 'PL', 'US'],
    );
    expect(mapCountryToQid('韩国')).toBe('Q884');
    expect(mapCountryToQid('us')).toBe('Q30');
  });

  it.each(['DACH', 'dach', 'D-A-CH', 'DACH区域', 'DACH地区', 'DACH市场', 'DACH region', 'DACH-Region', 'DACH-Raum'])(
    '目标市场「%s」展开为 DE、AT、CH',
    (term) => {
      expect(lookupMarketRegion(term)).toEqual(['DE', 'AT', 'CH']);
    },
  );

  it('地区不是单个国家：「DACH」不归一成某一个国家码', () => {
    expect(lookupCountryIso('DACH')).toBeUndefined();
    expect(mapCountryToQid('DACH')).toBeUndefined();
    expect(lookupMarketRegion('Germany')).toBeUndefined();
    expect(lookupMarketRegion('德国（DACH）')).toBeUndefined();
  });

  it('市场列表里的地区词就地展开为成员国码，其余词原样保留', () => {
    expect(expandMarketRegions(['德国', 'DACH区域', 'France'])).toEqual(['德国', 'DE', 'AT', 'CH', 'France']);
    expect(expandMarketRegions(['德国', '法国'])).toEqual(['德国', '法国']);
    expect(expandMarketRegions([])).toEqual([]);
  });
});
