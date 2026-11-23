import { describe, expect, it } from 'vitest';
import { queryableIndustryNodes, queryTaxonomyTerms } from './query-taxonomy-terms';
import { ISIC_SEED } from './isic-seed';
import {
  MAX_QUERY_TAXONOMY_COUNTRY_TERMS,
  MAX_QUERY_TAXONOMY_INDUSTRY_TERMS,
} from './execution-envelope';

describe('queryTaxonomyTerms', () => {
  it('takes industry then sub-industry terms, and country then region terms', () => {
    expect(
      queryTaxonomyTerms({
        industry: 'Pumpen',
        sub_industry: ['Kreiselpumpen'],
        country: 'Germany',
        region: 'Bayern',
      }),
    ).toEqual({
      industryTerms: ['Pumpen', 'Kreiselpumpen'],
      countryTerms: ['Germany', 'Bayern'],
    });
  });

  it('caps each list at the quoted per-query ceiling however many values the planner emitted', () => {
    const many = Array.from({ length: 32 }, (_, i) => `term-${i}`);
    const terms = queryTaxonomyTerms({
      industry: many,
      sub_industry: many,
      country: many,
      region: many,
    });

    expect(terms.industryTerms).toHaveLength(MAX_QUERY_TAXONOMY_INDUSTRY_TERMS);
    expect(terms.countryTerms).toHaveLength(MAX_QUERY_TAXONOMY_COUNTRY_TERMS);
  });

  it('drops empty values and repeated terms before spending the ceiling', () => {
    expect(
      queryTaxonomyTerms({
        industry: ['pumps', '', null, 'pumps'],
        sub_industry: 'valves',
        country: [undefined, 'DE'],
      }),
    ).toEqual({ industryTerms: ['pumps', 'valves'], countryTerms: ['DE'] });
  });
});


describe('Wikidata pivots retain the requested scope of shared ISIC 279', () => {
  const shared = ISIC_SEED.find((node) => node.code === '279')!;
  const qids = (term: string, node = shared) =>
    queryableIndustryNodes([node], 'enforce', [term]).map((value) => value.wikidataQid);

  it.each(['充电桩', '充电设备', '储能变流器', 'ev charging', 'charging station'])(
    'does not turn the non-PV term %s into a photovoltaics query', (term) => {
      expect(qids(term)).toEqual([]);
    },
  );
  it.each(['太阳能光伏', '光伏组件制造', 'solar photovoltaics', 'solarmodule', 'panneaux solaires'])(
    'retains the verified PV pivot for %s without binding the shared node', (term) => {
      expect(qids(term, { ...shared, wikidataQid: undefined })).toEqual(['Q192127']);
    },
  );
  it('does not trust a persisted whole-node PV binding for a charging request', () => {
    expect(qids('ev charging', { ...shared, wikidataQid: 'Q192127' })).toEqual([]);
  });
  it('does not mutate the canonical node when resolving a PV request', () => {
    const node = { ...shared, wikidataQid: undefined };
    expect(qids('光伏组件制造', node)).toEqual(['Q192127']);
    expect(node.wikidataQid).toBeUndefined();
  });
});
