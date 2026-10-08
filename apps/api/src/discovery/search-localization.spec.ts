import { describe, expect, it } from 'vitest';
import {
  searchableTerms,
  searchCountryName,
  searchLanguagesForMarkets,
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

  it('strips qualifiers in linear time on adversarial input', () => {
    const started = performance.now();
    expect(searchLanguagesForMarkets(['('.repeat(100_000), `${' '.repeat(100_000)}x`])).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
