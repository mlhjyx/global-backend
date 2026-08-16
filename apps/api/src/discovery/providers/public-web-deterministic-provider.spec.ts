import { describe, expect, it, vi } from 'vitest';

vi.mock('../../adapters/robots', () => ({
  isAllowedByRobots: vi.fn(async () => true),
}));

import { PublicWebDiscoveryProvider } from './public-web.provider';
import type { ExecutionBroker } from '../../tools/tool-contract';

const query = {
  sourceClass: 'public_intelligence' as const,
  filters: { industry: 'industrial pumps', country: 'DE' },
  keywords: ['pump'],
  limit: 5,
};

describe('PublicWebDiscoveryProvider deterministic company admission', () => {
  it('turns a search candidate into a company record only after same-site JSON-LD proof', async () => {
    let searchCalls = 0;
    const invoke = vi.fn(async (toolId: string) => {
      if (toolId === 'searxng.search') {
        searchCalls += 1;
        return {
          data: {
            results: searchCalls === 1
              ? [{ title: 'ACME', url: 'https://acme.example/products' }]
              : [],
          },
          costCents: 1,
        };
      }
      if (toolId === 'crawl4ai.render') {
        return {
          data: {
            url: 'https://acme.example/',
            html: `<html><script type="application/ld+json">${JSON.stringify({
              '@type': 'Organization',
              name: 'ACME Pumps GmbH',
              url: 'https://www.acme.example/',
              address: { addressCountry: 'DE' },
            })}</script></html>`,
            headers: {},
          },
          costCents: 1,
        };
      }
      throw new Error(`unexpected tool ${toolId}`);
    });
    const generateStructured = vi.fn();
    const provider = new PublicWebDiscoveryProvider({
      gateway: { generateStructured } as never,
      broker: { invoke } as unknown as ExecutionBroker,
      searchBackends: ['searxng.search'],
      aiCandidateExpansionEnabled: false,
    });

    const result = await provider.discoverCompanies(query, { workspaceId: 'ws-1', runId: 'run-1' });

    expect(result).toMatchObject({
      costCents: 3,
      usage: {
        callCount: 3,
        breakdown: [
          { phase: 'search', backend: 'searxng.search', callCount: 2, completedCount: 2, costCents: 2 },
          { phase: 'crawl', backend: 'crawl4ai.render', callCount: 1, completedCount: 1, costCents: 1 },
        ],
      },
      records: [{
        externalId: 'acme.example',
        name: 'ACME Pumps GmbH',
        domain: 'acme.example',
        country: 'DE',
        attributes: {
          extraction_method: 'jsonld_same_site',
          organization_type: 'Organization',
          organization_url: 'https://www.acme.example/',
        },
        provenance: {
          sourceUrl: 'https://acme.example/',
          parserVersion: 'public_web/deterministic-jsonld-v2',
        },
      }],
    });
    expect(invoke.mock.calls.filter(([toolId]) => toolId === 'crawl4ai.render')).toHaveLength(1);
    expect(
      invoke.mock.calls
        .filter(([toolId]) => toolId === 'searxng.search')
        .map(([, input]) => input),
    ).toEqual([
      expect.objectContaining({ count: 10 }),
      expect.objectContaining({ count: 10 }),
    ]);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('returns zero records without strict JSON-LD proof and never falls back to a model', async () => {
    const invoke = vi.fn(async (toolId: string) => {
      if (toolId === 'searxng.search') {
        return {
          data: { results: [{ title: 'ACME', url: 'https://acme.example/' }] },
          costCents: 0,
        };
      }
      if (toolId === 'crawl4ai.render') {
        return {
          data: {
            url: 'https://acme.example/',
            html: '<html><title>ACME</title><p>Industrial pumps</p></html>'.padEnd(220, ' '),
            headers: {},
          },
          costCents: 1,
        };
      }
      throw new Error(`unexpected tool ${toolId}`);
    });
    const generateStructured = vi.fn();
    const provider = new PublicWebDiscoveryProvider({
      gateway: { generateStructured } as never,
      broker: { invoke } as unknown as ExecutionBroker,
      searchBackends: ['searxng.search'],
      aiCandidateExpansionEnabled: false,
    });

    await expect(provider.discoverCompanies(query, { workspaceId: 'ws-1' }))
      .resolves.toEqual({
        records: [],
        costCents: 1,
        usage: {
          callCount: 3,
          breakdown: [
            { phase: 'search', backend: 'searxng.search', callCount: 2, completedCount: 2, costCents: 0 },
            { phase: 'crawl', backend: 'crawl4ai.render', callCount: 1, completedCount: 1, costCents: 1 },
          ],
        },
      });
    expect(generateStructured).not.toHaveBeenCalled();
  });
});
