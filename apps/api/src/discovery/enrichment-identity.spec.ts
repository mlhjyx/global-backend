import { describe, expect, it, vi } from 'vitest';
import { enrichmentIdentityConflicts, scopeIndependentEnrichment } from './enrichment-identity';
import { WikidataEnrichmentProvider } from './providers/wikidata-enrich.provider';

const company = { country: 'DE', domain: 'pumpen.example' };
describe('independent enrichment identity scope', () => {
  it.each(['DE', '德国', 'Germany', 'Deutschland', 'DEU'])('accepts the same country spelling %s', (country) => {
    expect(enrichmentIdentityConflicts(company, 'gleif', { registered_country: country })).toBe(false);
  });
  it.each(['FR', 'France', 'Czechia', 'Czech Republic'])('rejects a different registered country %s', (country) => {
    expect(enrichmentIdentityConflicts(company, 'gleif', { registered_country: country })).toBe(true);
  });
  it('rejects another known Wikidata country even on exact company-name matches', () => {
    expect(enrichmentIdentityConflicts(company, 'wikidata', { country: 'France' })).toBe(true);
  });
  it('uses raw country identity when labels are missing or misleading', () => {
    expect(enrichmentIdentityConflicts(company, 'wikidata', { country_qid: 'Q183' })).toBe(false);
    expect(enrichmentIdentityConflicts(company, 'wikidata', { country: 'Q142' })).toBe(true);
    expect(enrichmentIdentityConflicts(company, 'wikidata', { country_qid: 'Q142', country: 'Germany' })).toBe(true);
    expect(enrichmentIdentityConflicts(company, 'wikidata', { country_qid: 'Q999999' })).toBe(true);
  });
  it.each(['failed_labels', 'missing_labels'])(
    'does not lose a known foreign country when optional labels are unavailable: %s', async (mode) => {
      const entity = { labels: { en: { value: 'Muster GmbH' } }, claims: {
        P31: [{ mainsnak: { datavalue: { value: { id: 'Q4830453' } } } }],
        P17: [{ mainsnak: { datavalue: { value: { id: 'Q142' } } } }],
      } };
      const invoke = vi.fn(async (_id: string, input: { op: string; props?: string }) => {
        if (input.op === 'search') return { data: { search: [{ qid: 'Q999', label: 'Muster GmbH' }] } };
        if (input.props === 'labels') {
          if (mode === 'failed_labels') throw new Error('label service unavailable');
          return { data: { entities: { Q142: {} } } };
        }
        return { data: { entities: { Q999: entity } } };
      });
      const result = await new WikidataEnrichmentProvider({ broker: { invoke } as never })
        .enrichCompany({ name: 'Muster GmbH', country: 'DE', domain: 'muster.de' }, { workspaceId: 'test' });
      expect(result.matched).toBe(true);
      expect(enrichmentIdentityConflicts({ country: 'DE', domain: 'muster.de' }, 'wikidata', result.attributes)).toBe(true);
    },
  );
  it('rejects a different website and preserves www aliases', () => {
    expect(enrichmentIdentityConflicts(company, 'wikidata', { website: 'https://other.example/about' })).toBe(true);
    expect(enrichmentIdentityConflicts(company, 'wikidata', { website: 'https://www.pumpen.example/about' })).toBe(false);
  });
  it.each([undefined, null, [], 'bad', {}])('does not invent an identity conflict from missing facts %j', (attributes) => {
    expect(enrichmentIdentityConflicts({ country: null, domain: null }, 'gleif', attributes)).toBe(false);
  });
  it('removes conflicting stored facts only from the fit snapshot, preserving audit data', () => {
    const attributes = { gleif: { registered_country: 'FR' }, wikidata: { country: 'Germany' }, other: { fact: 'retained' } };
    expect(scopeIndependentEnrichment({ ...company, attributes })).toEqual({ wikidata: attributes.wikidata, other: attributes.other });
    expect(attributes.gleif.registered_country).toBe('FR');
  });
  it('rejects a different registered country for vies even when company.country is null using ccTLD inference', () => {
    expect(enrichmentIdentityConflicts({ country: null, domain: 'foo.it' }, 'vies', { registered_country: 'FR' })).toBe(true);
    expect(enrichmentIdentityConflicts({ country: null, domain: 'foo.it' }, 'vies', { registered_country: 'IT' })).toBe(false);
    expect(enrichmentIdentityConflicts({ country: null, domain: 'solarplace.net' }, 'vies', { registered_country: 'IT' })).toBe(false);
    const attributes = { vies: { registered_country: 'FR' }, website_profile: { trade_role: 'distributor' } };
    expect(scopeIndependentEnrichment({ country: null, domain: 'foo.it', attributes })).toEqual({
      website_profile: { trade_role: 'distributor' },
    });
  });

  it('returns the same object when no scope change is needed', () => {
    const attributes = { gleif: { registered_country: 'DE' } };
    expect(scopeIndependentEnrichment({ ...company, attributes })).toBe(attributes);
    expect(scopeIndependentEnrichment({ ...company, attributes: null })).toBeNull();
  });
});
