import { describe, expect, it } from 'vitest';
import {
  canonicalNace,
  nacePrefixesForIndustryTerms,
  nacePrefixesForIsicCodes,
  resolveNacePrefixes,
} from './industry-map';

describe('canonicalNace', () => {
  it('folds national variants to the NACE class form', () => {
    expect(canonicalNace('28.13Z')).toBe('28.13');
    expect(canonicalNace('2813')).toBe('28.13');
    expect(canonicalNace('28.13')).toBe('28.13');
    expect(canonicalNace('28')).toBe('28');
    expect(canonicalNace('32.5')).toBe('32.5');
  });

  it('rejects values the loader would not accept as NACE', () => {
    expect(canonicalNace('281')).toBeNull();
    expect(canonicalNace('NACE28')).toBeNull();
    expect(canonicalNace('')).toBeNull();
    expect(canonicalNace(null)).toBeNull();
  });
});

describe('nacePrefixesForIndustryTerms', () => {
  it('matches English, German compounds and Chinese terms through the ISIC crosswalk', () => {
    expect(nacePrefixesForIndustryTerms(['industrial pumps']).prefixes).toEqual(['28']);
    // 德语复合词：Kreiselpumpen 含 pump（≥4 字符拉丁别名允许子串匹配）。
    expect(nacePrefixesForIndustryTerms(['Kreiselpumpen']).prefixes).toEqual(['28']);
    expect(nacePrefixesForIndustryTerms(['工业阀门']).prefixes).toEqual(['28']);
    expect(nacePrefixesForIndustryTerms(['医疗器械']).prefixes).toEqual(['32.5']);
    expect(nacePrefixesForIndustryTerms(['sheet metal']).prefixes).toEqual(['25.99']);
  });

  it('reports unmatched terms instead of guessing', () => {
    const resolution = nacePrefixesForIndustryTerms(['pump', 'quantum basket weaving']);
    expect(resolution.prefixes).toEqual(['28']);
    expect(resolution.matchedTerms).toEqual(['pump']);
    expect(resolution.unmatchedTerms).toEqual(['quantum basket weaving']);
  });

  it('dedupes prefixes across terms', () => {
    expect(nacePrefixesForIndustryTerms(['pump', 'machinery']).prefixes).toEqual(['28']);
  });
});

describe('nacePrefixesForIsicCodes', () => {
  it('maps exact ISIC nodes through their NACE crosswalk entries', () => {
    expect(nacePrefixesForIsicCodes(['28', '325'])).toEqual(['28', '32.5']);
    expect(nacePrefixesForIsicCodes(['C'])).toEqual([]);
    expect(nacePrefixesForIsicCodes(['unknown'])).toEqual([]);
  });
});

describe('resolveNacePrefixes', () => {
  it('prefers explicit prefixes, then industry terms, then taxonomy codes', () => {
    expect(
      resolveNacePrefixes({
        nacePrefix: ['2813'],
        industry: 'pump',
        industryCodes: ['26'],
      }),
    ).toEqual(['28.13']);
    expect(resolveNacePrefixes({ industry: 'Kreiselpumpen', industryCodes: ['26'] })).toEqual(['28']);
    expect(resolveNacePrefixes({ industryCodes: ['26'] })).toEqual(['26']);
    expect(resolveNacePrefixes({})).toEqual([]);
  });

  it('ignores unusable values without throwing', () => {
    expect(resolveNacePrefixes({ nacePrefix: 42, industry: [1, 'pump'], industryCodes: '28' })).toEqual([
      '28',
    ]);
  });
});
