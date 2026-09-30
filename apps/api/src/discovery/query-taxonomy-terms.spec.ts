import { describe, expect, it } from 'vitest';
import { queryTaxonomyTerms } from './query-taxonomy-terms';
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
