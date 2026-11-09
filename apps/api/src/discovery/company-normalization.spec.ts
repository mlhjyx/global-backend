import { describe, expect, it } from 'vitest';
import {
  inferCountryFromAttributes,
  inferIndustryFromAttributes,
  normalizeCountryValue,
  planCompanyNormalization,
} from './company-normalization';

describe('normalizeCountryValue', () => {
  it('folds Chinese/English/German names and alpha-2/alpha-3 variants to ISO alpha-2', () => {
    expect(normalizeCountryValue('德国')).toBe('DE');
    expect(normalizeCountryValue('Deutschland')).toBe('DE');
    expect(normalizeCountryValue('Germany')).toBe('DE');
    expect(normalizeCountryValue('germany')).toBe('DE');
    expect(normalizeCountryValue('DE')).toBe('DE');
    expect(normalizeCountryValue('de')).toBe('DE');
    expect(normalizeCountryValue('DEU')).toBe('DE');
    expect(normalizeCountryValue(' 德国 ')).toBe('DE');
    expect(normalizeCountryValue('奥地利')).toBe('AT');
    expect(normalizeCountryValue('Österreich')).toBe('AT');
    expect(normalizeCountryValue('中国')).toBe('CN');
    expect(normalizeCountryValue('USA')).toBe('US');
  });

  it('returns null instead of guessing for unknown or garbage values', () => {
    expect(normalizeCountryValue('DACH')).toBeNull(); // 三国地区词不是国家
    expect(normalizeCountryValue('Germany (Bavaria)')).toBeNull();
    expect(normalizeCountryValue('ZZ')).toBeNull(); // 不认识的两字母码
    expect(normalizeCountryValue('')).toBeNull();
    expect(normalizeCountryValue(null)).toBeNull();
    expect(normalizeCountryValue(42)).toBeNull();
  });

  it('is idempotent on already-normalized values', () => {
    expect(normalizeCountryValue(normalizeCountryValue('德国')!)).toBe('DE');
  });
});

describe('inferCountryFromAttributes', () => {
  it('prefers the GLEIF registered country (registry fact)', () => {
    expect(
      inferCountryFromAttributes({
        gleif: { registered_country: 'DE' },
        website_profile: { vat_id: 'ATU12345678' },
      }),
    ).toEqual({ iso: 'DE', source: 'gleif_registered_country', evidence: 'DE' });
  });

  it('falls back to the VAT id prefix', () => {
    expect(inferCountryFromAttributes({ website_profile: { vat_id: 'DE136762735' } })).toEqual({
      iso: 'DE',
      source: 'vat_id',
      evidence: 'DE136762735',
    });
    expect(inferCountryFromAttributes({ website_profile: { vat_id: 'ATU64332109' } })?.iso).toBe('AT');
    expect(inferCountryFromAttributes({ website_profile: { vat_id: 'CHE-116.286.684' } })?.iso).toBe('CH');
  });

  it('returns null without registry-grade evidence', () => {
    expect(inferCountryFromAttributes({ website_profile: {} })).toBeNull();
    expect(inferCountryFromAttributes({ gleif: { registered_country: 'DACH' } })).toBeNull();
    expect(inferCountryFromAttributes({ website_profile: { vat_id: 'XX123' } })).toBeNull();
    expect(inferCountryFromAttributes(null)).toBeNull();
  });
});

describe('inferIndustryFromAttributes', () => {
  it('infers the ISIC node from keywords and products through the alias vocabulary', () => {
    const result = inferIndustryFromAttributes({ keywords: ['pump technology'], products: ['pumps'] });
    expect(result).not.toBeNull();
    expect(result!.isicCode).toBe('28');
    expect(result!.nacePrefixes).toContain('28');
    expect(result!.matchedTerms).toEqual(expect.arrayContaining(['pump technology', 'pumps']));
    expect(result!.sources).toEqual(['keywords', 'products']);
  });

  it('reads website-profile evidence but stores only the matched alias, not the sentence', () => {
    const result = inferIndustryFromAttributes({
      website_profile: {
        evidence: ['Pumpen Reparatur Exzenterschnecken- und Schlauchpumpen, Mazeratoren, Kreiselpumpen'],
      },
    });
    expect(result?.isicCode).toBe('28');
    // 落库的是命中的别名（pump 子树），不是整句证据文本
    expect(result!.matchedTerms.every((term) => term.length <= 80)).toBe(true);
  });

  it('uses the TED CPV crosswalk and stores prefix-form terms', () => {
    const result = inferIndustryFromAttributes({ ted: { cpv: ['42123000', '45200000'] } });
    expect(result?.isicCode).toBe('28');
    expect(result!.matchedTerms).toContain('cpv:42123');
    expect(result!.sources).toContain('ted');
  });

  it('uses the FDA product-code crosswalk through the injected code→panel port', () => {
    const fdaPanelOf = (code: string): string | null =>
      ({ PBF: 'RA', LLZ: 'RA', ABC: 'CV' })[code] ?? null;
    const result = inferIndustryFromAttributes(
      { fda: { product_codes: ['PBF', 'ABC'] } },
      { fdaPanelOf },
    );
    expect(result).not.toBeNull();
    expect(result!.isicCode).toBe('325'); // 医疗器械制造（crosswalks.fdaPanels = ['RA']）
    expect(result!.matchedTerms).toContain('fda:PBF');
    expect(result!.sources).toContain('fda');
    // 没有端口时 FDA 证据不参与推断
    expect(inferIndustryFromAttributes({ fda: { product_codes: ['PBF'] } })).toBeNull();
  });

  it('returns null when there is no deterministic evidence', () => {
    expect(inferIndustryFromAttributes({})).toBeNull();
    expect(inferIndustryFromAttributes({ keywords: ['quantum basket weaving'] })).toBeNull();
    expect(inferIndustryFromAttributes(null)).toBeNull();
  });
});

describe('planCompanyNormalization', () => {
  it('normalizes variant country values and backfills empty industry idempotently', () => {
    const row = { country: '德国', industry: null, attributes: { keywords: ['pumps'] } };
    const plan = planCompanyNormalization(row);
    expect(plan.country).toEqual({ from: '德国', to: 'DE', reason: 'variant' });
    expect(plan.industry?.to).toBe('Manufacture of machinery and equipment n.e.c.');

    // 重跑：已是标准值 → 计划为空（幂等）
    const applied = planCompanyNormalization({
      country: 'DE',
      industry: plan.industry!.to,
      attributes: row.attributes,
    });
    expect(applied).toEqual({});
  });

  it('never overwrites a non-empty industry', () => {
    const plan = planCompanyNormalization({
      country: 'DE',
      industry: '流体处理设备',
      attributes: { keywords: ['pumps'] },
    });
    expect(plan.industry).toBeUndefined();
  });

  it('fills an empty country only from deterministic evidence', () => {
    expect(
      planCompanyNormalization({
        country: null,
        industry: null,
        attributes: { website_profile: { vat_id: 'DE136762735' } },
      }).country,
    ).toEqual({ from: null, to: 'DE', reason: 'vat_id' });
    expect(planCompanyNormalization({ country: null, industry: null, attributes: {} }).country).toBeUndefined();
  });

  it('leaves unknown country values untouched', () => {
    const plan = planCompanyNormalization({ country: 'DACH', industry: null, attributes: {} });
    expect(plan.country).toBeUndefined();
  });
});
