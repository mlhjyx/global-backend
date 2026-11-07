import { describe, expect, it, vi } from 'vitest';
import type { DurableExecutionReceipt } from '../../durable-results/durable-execution-receipt';
import { ToolDurableResultProjectionError } from '../../tools/tool-broker';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import { parseDiscoveryCompanyResultLineage } from '../company-discovery-lineage';
import { WikidataDiscoveryProvider } from './wikidata.provider';
import { OsmDiscoveryProvider } from './osm.provider';
import { TedDiscoveryProvider } from './ted.provider';
import { OpenFdaDiscoveryProvider } from './openfda.provider';

const CTX = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  runId: '00000000-0000-4000-8000-000000000002',
};

let operationCounter = 100;
function receipt(resultSchema: string): DurableExecutionReceipt {
  operationCounter += 1;
  // 两位十六进制后缀（保持 operationId 的 UUID 末段 12 位）。
  const suffix = (operationCounter % 256).toString(16).padStart(2, '0');
  return {
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: CTX.workspaceId,
    authorityId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
    accountId: '5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0',
    operationId: `1b3d6096-b924-4bc8-bb4f-8436efb3${suffix}dd`,
    operationKey: `tool:${resultSchema}:${suffix}`,
    resultStrategy: 'typed_projection',
    resultSchema,
    resultDigest: 'a'.repeat(63) + (operationCounter % 10),
    artifactId: null,
    usage: {
      currency: 'USD',
      unit: 'microusd',
      callCount: 1,
      chargedMicrousd: '0',
      upperBoundMicrousd: '0',
    },
    costBasis: 'estimated_upper_bound',
    status: 'SETTLED',
  };
}

/** Broker double：按工具 id 返回数据，并在返回前发出与工具投影 schema 匹配的回执。 */
function fakeBroker(
  handlers: Record<
    string,
    | { data: unknown }
    | (() => never)
  >,
): ExecutionBroker & { invokeMock: ReturnType<typeof vi.fn> } {
  const invokeMock = vi.fn(
    async (toolId: string, _input: unknown, ctx: ToolContext) => {
      const handler = handlers[toolId];
      if (!handler) throw new Error(`unexpected tool ${toolId}`);
      if (typeof handler === 'function') handler();
      const schemas: Record<string, string> = {
        'wikidata.sparql': 'wikidata-sparql/v1',
        'osm.overpass': 'osm-overpass/v1',
        'ted.search': 'ted-search/v1',
        'openfda.search': 'openfda-search/v1',
      };
      const schema = schemas[toolId];
      if (!schema) throw new Error(`no schema for ${toolId}`);
      ctx.onDurableReceipt?.(toolId, receipt(schema));
      return { data: handler.data, costCents: 0 };
    },
  );
  return { invoke: invokeMock, invokeMock } as unknown as ExecutionBroker & {
    invokeMock: ReturnType<typeof vi.fn>;
  };
}

const WIKIDATA_QUERY = {
  sourceClass: 'company_registry' as const,
  filters: { industry: 'manufacturing', country: 'germany' },
  keywords: [],
  limit: 5,
};
const OSM_QUERY = {
  sourceClass: 'industry_data' as const,
  filters: { industry: 'metal fabrication', country: 'bavaria' },
  keywords: [],
  limit: 5,
};
const TED_QUERY = {
  sourceClass: 'public_intelligence' as const,
  filters: { cpv: '42120000', buyer_country: 'DEU' },
  keywords: [],
  limit: 5,
};
const OPENFDA_QUERY = {
  sourceClass: 'public_intelligence' as const,
  filters: { product_code: 'LLZ', trade_side: 'importer' },
  keywords: [],
  limit: 5,
};

describe('structured source governed lineage (lineage v3)', () => {
  it('wikidata: one SPARQL settlement covers every record and forwards the receipt', async () => {
    const onDurableReceipt = vi.fn();
    const broker = fakeBroker({
      'wikidata.sparql': {
        data: {
          companies: [
            { qid: 'Q1', name: 'Alpha GmbH', website: 'https://alpha.de' },
            { qid: 'Q2', name: 'Beta AG', website: 'https://beta.de' },
          ],
        },
      },
    });
    const res = await new WikidataDiscoveryProvider({ broker }).discoverCompanies(
      WIKIDATA_QUERY,
      { ...CTX, onDurableReceipt },
    );
    expect(res.records).toHaveLength(2);
    const lineage = parseDiscoveryCompanyResultLineage(res.lineage, 'wikidata');
    expect(lineage.recordCount).toBe(2);
    expect(lineage.attemptReceipts).toEqual([]);
    expect(lineage.receiptCoverage).toHaveLength(1);
    expect(lineage.receiptCoverage[0]!.producerId).toBe('wikidata.sparql');
    expect(lineage.receiptCoverage[0]!.recordIndexes).toEqual([0, 1]);
    expect(onDurableReceipt).toHaveBeenCalledOnce();
  });

  it('openstreetmap: Overpass settlement covers every record', async () => {
    const broker = fakeBroker({
      'osm.overpass': {
        data: {
          places: [
            {
              osmId: 'node/1',
              name: 'Metallbau Süd',
              latitude: 48.1,
              longitude: 11.5,
              city: 'München',
              tags: { craft: 'metal_construction' },
            },
          ],
        },
      },
    });
    const res = await new OsmDiscoveryProvider({ broker }).discoverCompanies(OSM_QUERY, CTX);
    expect(res.records).toHaveLength(1);
    const lineage = parseDiscoveryCompanyResultLineage(res.lineage, 'openstreetmap');
    expect(lineage.recordCount).toBe(1);
    expect(lineage.receiptCoverage[0]!.producerId).toBe('osm.overpass');
    expect(lineage.receiptCoverage[0]!.recordIndexes).toEqual([0]);
  });

  it('ted: one Search API settlement covers the deduped award winners', async () => {
    const broker = fakeBroker({
      'ted.search': {
        data: {
          awards: [
            {
              publicationNumber: '123-2026',
              publicationDate: '2026-07-08+02:00',
              noticeType: 'can-standard',
              formType: 'result',
              cpvCodes: ['42120000'],
              buyerNames: ['City of X'],
              buyerCountries: ['DEU'],
              winners: [
                { name: 'Pumpenwerk AG', country: 'DEU', identifier: 'DE123' },
                { name: 'Pumpenwerk AG', country: 'DEU', identifier: 'DE123' },
              ],
            },
          ],
        },
      },
    });
    const res = await new TedDiscoveryProvider({ broker }).discoverCompanies(TED_QUERY, CTX);
    expect(res.records).toHaveLength(1);
    const lineage = parseDiscoveryCompanyResultLineage(res.lineage, 'ted');
    expect(lineage.recordCount).toBe(1);
    expect(lineage.receiptCoverage[0]!.producerId).toBe('ted.search');
    expect(lineage.receiptCoverage[0]!.recordIndexes).toEqual([0]);
  });

  it('openfda: registration settlement covers the deduped establishments', async () => {
    const broker = fakeBroker({
      'openfda.search': {
        data: {
          establishments: [
            {
              registrationNumber: '3001',
              name: 'Imaging Importers Inc',
              country: 'US',
              establishmentTypes: ['Importer'],
              initialImporter: true,
              productCodes: ['LLZ'],
              deviceNames: ['X-Ray System'],
              ownerOperatorNumbers: ['1000'],
            },
            {
              registrationNumber: '3002',
              name: 'Second Devices LLC',
              country: 'US',
              establishmentTypes: ['Manufacturer'],
              initialImporter: false,
              productCodes: ['LLZ'],
              deviceNames: ['CT Scanner'],
              ownerOperatorNumbers: ['1001'],
            },
          ],
        },
      },
    });
    const res = await new OpenFdaDiscoveryProvider({ broker }).discoverCompanies(OPENFDA_QUERY, CTX);
    expect(res.records).toHaveLength(2);
    const lineage = parseDiscoveryCompanyResultLineage(res.lineage, 'openfda');
    expect(lineage.recordCount).toBe(2);
    expect(lineage.receiptCoverage[0]!.producerId).toBe('openfda.search');
    expect(lineage.receiptCoverage[0]!.recordIndexes).toEqual([0, 1]);
  });

  it('a settled projection rejection is a proven failure: empty lineage stays valid', async () => {
    const broker = fakeBroker({
      'openfda.search': () => {
        throw new ToolDurableResultProjectionError('5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0');
      },
    });
    const res = await new OpenFdaDiscoveryProvider({ broker }).discoverCompanies(OPENFDA_QUERY, CTX);
    expect(res.records).toEqual([]);
    const lineage = parseDiscoveryCompanyResultLineage(res.lineage, 'openfda');
    expect(lineage.recordCount).toBe(0);
    expect(lineage.attemptReceipts).toEqual([]);
    expect(lineage.receiptCoverage).toEqual([]);
  });

  it('an unknown wire failure voids the lineage instead of attesting records', async () => {
    const broker = fakeBroker({
      'wikidata.sparql': () => {
        throw new Error('socket hang up');
      },
    });
    const res = await new WikidataDiscoveryProvider({ broker }).discoverCompanies(
      WIKIDATA_QUERY,
      CTX,
    );
    expect(res.records).toEqual([]);
    expect(res.lineage).toBeUndefined();
  });
});
