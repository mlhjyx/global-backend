import { describe, expect, it } from 'vitest';
import type { CompanyDiscoveryQuery } from '../provider-contract';
import { collectPublicWebCandidateHits } from './public-web.provider';

const query: CompanyDiscoveryQuery = {
  sourceClass: 'public_intelligence',
  filters: { country: 'DE', procurement_scenario: 'equipment_integration' },
  keywords: ['Abwasser Anlage', 'Pumpstation Referenz'],
  limit: 20,
};

const hit = (url: string) => ({ url, title: 'Engineering project' });

describe('engineering search hits', () => {
  const main = 'https://www.lueckmann-anlagenbau.de/projektdatenbank';
  const domain = 'lueckmann-anlagenbau.de';

  it('does not spend the same company’s page allowance on project-index filter variants', () => {
    const firstCase = `${main}/werk-nord`;
    const secondCase = `${main}/werk-sued`;
    const results = collectPublicWebCandidateHits(
      [
        [
          hit(`${main}?f%5B0%5D=field_baujahr%3A2014`),
          hit(`${main}?f%5B0%5D=field_baujahr%3A2016`),
          hit(firstCase),
        ],
        [
          hit(main),
          hit(`${main}?f%5B1%5D=field_baujahr%3A2020`),
          hit(secondCase),
        ],
      ],
      query,
    );
    expect([...results.keys()]).toEqual([domain]);
    expect(results.get(domain)?.map(({ url }) => url)).toEqual([main, firstCase, secondCase]);
  });

  it('preserves distinct project identifiers and independent documents from one company', () => {
    const urls = [
      `${main}?projectId=4711`,
      `${main}?projectId=9478`,
      'https://www.lueckmann-anlagenbau.de/downloads/werk-nord.pdf',
      'https://www.lueckmann-anlagenbau.de/downloads/werk-sued.pdf',
    ];
    const results = collectPublicWebCandidateHits([urls.map(hit)], query);
    expect(results.get(domain)?.map(({ url }) => url)).toEqual(urls);
  });

  it('keeps the observed address when no unfiltered catalogue was returned', () => {
    const found = `${main}?f%5B0%5D=field_baujahr%3A2014`;
    const otherFilter = `${main}?f%5B0%5D=field_baujahr%3A2016`;
    const results = collectPublicWebCandidateHits([[hit(found), hit(otherFilter)]], query);
    expect(results.get(domain)?.map(({ url }) => url)).toEqual([found]);
  });

  it('keeps the legacy dealer search candidate ordering', () => {
    const urls = [
      `${main}?f%5B0%5D=field_baujahr%3A2014`,
      `${main}?f%5B0%5D=field_baujahr%3A2016`,
      main,
    ];
    const distribution = { ...query, filters: { ...query.filters, procurement_scenario: 'distribution' } };
    const results = collectPublicWebCandidateHits([urls.map(hit)], distribution);
    expect(results.get(domain)?.map(({ url }) => url)).toEqual(urls);
  });
});
