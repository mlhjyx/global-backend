import { describe, expect, it, vi } from 'vitest';
import { BudgetStoreUnavailableError } from '../../tools/budget-store';
import { GleifEnrichmentProvider } from './gleif.provider';
import { WikidataEnrichmentProvider } from './wikidata-enrich.provider';

describe('independent evidence provider failure boundaries', () => {
  it.each([GleifEnrichmentProvider, WikidataEnrichmentProvider])(
    '%s does not turn an authoritative budget failure into a company miss', async (Provider) => {
      const error = new BudgetStoreUnavailableError('test budget unavailable');
      const broker = { invoke: vi.fn(async () => { throw error; }) };
      await expect(new Provider({ broker: broker as never }).enrichCompany(
        { name: 'Muster Pumpen GmbH', country: 'DE' }, { workspaceId: 'workspace', runId: 'run' },
      )).rejects.toBe(error);
      expect(broker.invoke).toHaveBeenCalledOnce();
    },
  );

  it('does not swallow a GLEIF parent lookup control error after a successful search', async () => {
    const error = new BudgetStoreUnavailableError('test parent budget unavailable');
    const invoke = vi.fn(async (_id: string, input: { op: string }) => {
      if (input.op !== 'search') throw error;
      return { data: { records: [{ lei: 'TESTLEI00000000000001', legalName: 'Muster Pumpen GmbH',
        country: 'DE', hasDirectParent: true, hasUltimateParent: false }] } };
    });
    await expect(new GleifEnrichmentProvider({ broker: { invoke } as never }).enrichCompany(
      { name: 'Muster Pumpen GmbH', country: 'DE' }, { workspaceId: 'test' },
    )).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('does not swallow a Wikidata optional-label control error', async () => {
    const error = new BudgetStoreUnavailableError('test labels budget unavailable');
    const invoke = vi.fn(async (_id: string, input: { op: string; props?: string }) => {
      if (input.op === 'search') return { data: { search: [{ qid: 'Q999', label: 'Muster Pumpen GmbH' }] } };
      if (input.props === 'labels') throw error;
      return { data: { entities: { Q999: { labels: { en: { value: 'Muster Pumpen GmbH' } }, claims: {
        P31: [{ mainsnak: { datavalue: { value: { id: 'Q4830453' } } } }],
        P17: [{ mainsnak: { datavalue: { value: { id: 'Q183' } } } }],
      } } } } };
    });
    await expect(new WikidataEnrichmentProvider({ broker: { invoke } as never }).enrichCompany(
      { name: 'Muster Pumpen GmbH', country: 'DE' }, { workspaceId: 'test' },
    )).rejects.toBe(error);
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});
