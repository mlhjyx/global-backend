import { describe, expect, it } from 'vitest';
import {
  partitionSearchTerms,
  searchableTerms,
  searchCountryName,
  searchLanguageFor,
  searchLanguagesForMarkets,
  targetCountryCodes,
  targetCountryTlds,
  tradeRoleTerms,
} from './search-localization';

describe('searchableTerms', () => {
  it('keeps Latin-script terms and drops any term written partly in Han, kana or Hangul', () => {
    expect(
      searchableTerms([
        '工业泵 分销商 进口商',
        'Pumpen Vertrieb Importeur Deutschland',
        'Pumpen 泵',
        'ポンプ',
        '펌프',
        'Großhandel für Kreiselpumpen',
        'pompes à eau',
      ]),
    ).toEqual(['Pumpen Vertrieb Importeur Deutschland', 'Großhandel für Kreiselpumpen', 'pompes à eau']);
  });

  it('returns an empty list when every term is Chinese', () => {
    expect(searchableTerms(['德国 泵 批发商', '流体技术'])).toEqual([]);
  });

  it('trims terms and drops the empty ones', () => {
    expect(searchableTerms(['', '  ', ' Pumpen '])).toEqual(['Pumpen']);
  });
});

describe('searchCountryName', () => {
  it.each([
    [{ country: '德国' }, 'Deutschland'],
    [{ country: ['奥地利', '德国'] }, 'Österreich'],
    [{ region: 'Bayern' }, 'Deutschland'],
    [{ country: 'France' }, 'France'],
    [{ country: '德国、奥地利' }, 'Deutschland'],
    [{ country: 'Nowhere' }, undefined],
    [{}, undefined],
  ])('names %o as %s', (filters, name) => {
    expect(searchCountryName({ filters })).toBe(name);
  });
});

describe('DACH target countries', () => {
  it.each([
    [{ country: 'DACH' }, ['de', 'at', 'ch']],
    [{ country: ['France', 'D-A-CH'] }, ['fr', 'de', 'at', 'ch']],
    [{ country: 'Österreich, DACH-Region' }, ['at', 'de', 'ch']],
    [{ buyer_country: 'dach' }, ['de', 'at', 'ch']],
    [{ region: 'DACH' }, ['de', 'at', 'ch']],
    [{ country: 'France', region: 'DACH' }, ['fr']],
    [{ region: 'Bayern' }, ['de']],
    [{ country: 'Nowhere' }, []],
    [{ country: 'constructor', region: 'toString' }, []],
  ])('resolves %o to %o', (filters, codes) => {
    expect(targetCountryCodes({ filters })).toEqual(codes);
  });

  it('accepts all three ccTLDs and names Germany first for a DACH query', () => {
    expect([...targetCountryTlds({ filters: { country: 'DACH' } })]).toEqual(['de', 'at', 'ch']);
    expect(searchCountryName({ filters: { country: 'DACH' } })).toBe('Deutschland');
  });
});

describe('searchLanguagesForMarkets', () => {
  it('maps ICP target markets, including qualified Chinese names, to their search languages once each', () => {
    expect(searchLanguagesForMarkets(['德国', '奥地利', '瑞士（德语区优先）'])).toEqual(['de']);
    expect(searchLanguagesForMarkets(['France', 'Germany (Bavaria)', 'Polska'])).toEqual(['fr', 'de', 'pl']);
  });

  it('splits markets joined with Chinese punctuation', () => {
    expect(searchLanguagesForMarkets(['德国、奥地利'])).toEqual(['de']);
    expect(searchLanguagesForMarkets(['德国，法国；波兰'])).toEqual(['de', 'fr', 'pl']);
  });

  it('returns no language for unknown or malformed markets', () => {
    expect(searchLanguagesForMarkets(['火星'])).toEqual([]);
    expect(searchLanguagesForMarkets(undefined)).toEqual([]);
    expect(searchLanguagesForMarkets([42, null])).toEqual([]);
  });

  it('expands a DACH market to Germany, Austria and Switzerland', () => {
    expect(searchLanguagesForMarkets(['DACH区域'])).toEqual(['de']);
    expect(searchLanguagesForMarkets(['DACH（德语区）', 'France'])).toEqual(['de', 'fr']);
  });

  it('strips qualifiers in linear time on adversarial input', () => {
    const started = performance.now();
    expect(searchLanguagesForMarkets(['('.repeat(100_000), `${' '.repeat(100_000)}x`])).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('中文（zh）检索本地化', () => {
  it.each([
    [{ country: '中国' }],
    [{ country: 'China' }],
    [{ country: 'CN' }],
    [{ country: 'chn' }],
    [{ country: ['中国', '德国'] }],
    [{ region: '珠三角' }],
    [{ region: '长三角' }],
    [{ region: '粤港澳大湾区' }],
  ])('resolves %o to the zh search language', (filters) => {
    expect(searchLanguageFor({ filters })).toBe('zh');
  });

  it('maps China to its ISO code and local name', () => {
    expect(targetCountryCodes({ filters: { country: '中国' } })).toEqual(['cn']);
    expect(searchCountryName({ filters: { country: '珠三角' } })).toBe('中国');
    expect(searchLanguagesForMarkets(['中国', '珠三角'])).toEqual(['zh']);
  });

  it('provides Chinese role terms', () => {
    expect(tradeRoleTerms('distributor', 'zh')).toEqual(['经销商', '分销商', '批发商', '进口商']);
    expect(tradeRoleTerms('manufacturer', 'zh')).toEqual(['制造商', '厂家', '工厂']);
  });

  it('keeps Han terms for zh searches (dropping Latin-only ones) and still strips CJK for other languages', () => {
    expect(searchableTerms(['工业泵 分销商', 'Pumpen'], 'zh')).toEqual(['工业泵 分销商']);
    expect(searchableTerms(['工业泵 分销商', 'Pumpen'], 'de')).toEqual(['Pumpen']);
    expect(searchableTerms(['工业泵 分销商'])).toEqual([]);
  });
});

describe('P2 八语言扩展（ms/id/vi/th/ja/ko/pt/tr）', () => {
  it.each([
    [{ country: '马来西亚' }, 'ms'],
    [{ country: 'Malaysia' }, 'ms'],
    [{ country: 'MY' }, 'ms'],
    [{ country: '印度尼西亚' }, 'id'],
    [{ country: '越南' }, 'vi'],
    [{ country: '泰国' }, 'th'],
    [{ country: '日本' }, 'ja'],
    [{ country: '韩国' }, 'ko'],
    [{ country: '葡萄牙' }, 'pt'],
    [{ country: '土耳其' }, 'tr'],
  ])('resolves %o to %s', (filters, language) => {
    expect(searchLanguageFor({ filters })).toBe(language);
  });

  it('maps ICP markets to the new languages', () => {
    expect(searchLanguagesForMarkets(['马来西亚'])).toEqual(['ms']);
    expect(searchLanguagesForMarkets(['Vietnam', 'Thailand'])).toEqual(['vi', 'th']);
    expect(searchLanguagesForMarkets(['日本、韩国'])).toEqual(['ja', 'ko']);
  });

  it('provides localized role terms', () => {
    expect(tradeRoleTerms('distributor', 'ms')).toEqual(['pemborong', 'peniaga', 'pengedar']);
    expect(tradeRoleTerms('manufacturer', 'ms')).toEqual(['pengeluar', 'pembuat']);
    expect(tradeRoleTerms('distributor', 'ja')).toEqual(['販売代理店', '卸売業者', 'ディーラー']);
    expect(tradeRoleTerms('distributor', 'tr')).toEqual(['distribütör', 'toptancı', 'bayi']);
    expect(tradeRoleTerms('manufacturer', 'th')).toEqual(['ผู้ผลิต']);
  });

  it('keeps script-appropriate terms and reports the stripped ones', () => {
    expect(partitionSearchTerms(['pemborong pam', '工业泵'], 'ms')).toEqual({
      usable: ['pemborong pam'],
      stripped: ['工业泵'],
    });
    expect(partitionSearchTerms(['工業用ポンプ 卸売業者', 'Pumpen'], 'ja').usable).toEqual(['工業用ポンプ 卸売業者']);
    expect(partitionSearchTerms(['산업용 펌프 도매'], 'ko').usable).toEqual(['산업용 펌프 도매']);
    expect(partitionSearchTerms(['工业泵 分销商', 'Pumpen'], 'zh')).toEqual({
      usable: ['工业泵 分销商'],
      stripped: ['Pumpen'],
    });
    expect(partitionSearchTerms(['Pumpen', '工业泵'])).toEqual({ usable: ['Pumpen'], stripped: ['工业泵'] });
  });
});
