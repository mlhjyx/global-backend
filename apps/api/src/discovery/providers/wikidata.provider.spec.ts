import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionBroker } from '../../tools/tool-contract';
import { WikidataDiscoveryProvider } from './wikidata.provider';

const QUERY = {
  sourceClass: 'company_registry' as const,
  filters: { industry: 'metal fabrication', country: 'Germany' },
  keywords: ['metal fabrication'],
  limit: 25,
};

function brokerWith(companies: unknown[]): ExecutionBroker {
  return {
    invoke: vi.fn(async () => ({ data: { companies }, costCents: 0 })),
    checkSourcePolicy: vi.fn(async () => ({ allowed: true })),
  } as unknown as ExecutionBroker;
}

describe('Wikidata discovery provider identity projection', () => {
  it('不把 Broker 超时伪装成正常零结果', async () => {
    const broker = {
      invoke: vi.fn(async () => {
        throw Object.assign(new Error('operation timed out'), { name: 'TimeoutError' });
      }),
      checkSourcePolicy: vi.fn(async () => ({ allowed: true })),
    } as unknown as ExecutionBroker;
    const provider = new WikidataDiscoveryProvider({ broker });

    await expect(
      provider.discoverCompanies(QUERY, {
        workspaceId: 'workspace-1',
        runId: 'run-1',
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('projects QID, domain and a valid LEI into the existing Identity v2 contract', async () => {
    const company = {
      qid: 'Q123',
      name: 'Acme GmbH',
      website: 'https://www.acme.example/catalogue',
      employees: 120,
      countryCode: 'DE',
      lei: '529900T8BM49AURSDO55',
    };
    const provider = new WikidataDiscoveryProvider({ broker: brokerWith([company]) });

    const result = await provider.discoverCompanies(QUERY, { workspaceId: 'workspace-1', runId: 'run-1' });

    expect(result.costCents).toBe(0);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      externalId: 'wikidata:Q123',
      name: 'Acme GmbH',
      domain: 'acme.example',
      country: 'DE',
      identifiers: [
        { scheme: 'wikidata-qid', jurisdiction: 'GLOBAL', value: 'Q123' },
        { scheme: 'lei', jurisdiction: 'GLOBAL', value: '529900T8BM49AURSDO55' },
      ],
      license: 'CC0-1.0',
      attributes: {
        wikidata_qid: 'Q123',
        wikidata_lei_claim: '529900T8BM49AURSDO55',
        discovery_match: {
          industries: ['metal fabrication'],
          industry_qids: ['Q19541171'],
        },
      },
      provenance: { parserVersion: 'wikidata/2' },
    });
    expect(result.records[0].provenance?.contentHash).toBe(
      createHash('sha256')
        .update(JSON.stringify(['Q123', 'Acme GmbH', 'https://www.acme.example/catalogue', 'DE', 120, '529900T8BM49AURSDO55', null, null]))
        .digest('hex'),
    );
  });

  it('keeps the source claim but refuses to bind an invalid LEI', async () => {
    const provider = new WikidataDiscoveryProvider({
      broker: brokerWith([
        {
          qid: 'Q456',
          name: 'Unsafe Claim GmbH',
          website: 'https://unsafe.example',
          countryCode: 'DE',
          lei: '529900T8BM49AURSDO54',
        },
      ]),
    });

    const result = await provider.discoverCompanies(QUERY, { workspaceId: 'workspace-1', runId: 'run-1' });

    expect(result.records[0].identifiers).toEqual([
      { scheme: 'wikidata-qid', jurisdiction: 'GLOBAL', value: 'Q456' },
    ]);
    expect(result.records[0].attributes).toMatchObject({ wikidata_lei_claim: '529900T8BM49AURSDO54' });
  });
});
