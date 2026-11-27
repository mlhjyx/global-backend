import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectModelResultForReplay } from '../durable-results/model-result-replay';
import { projectGenericOperationResult } from '../tools/generic-operation-projection';
import { registerCatalogResultProjections } from '../durable-results/catalog-result-projections';
import { TypedProjectionRegistry } from '../durable-results/typed-projection.registry';
import type { DiscoveryV3ResultLink } from './discovery-v3-operation-scope';
import type { CompanyDiscoveryQuery } from './provider-contract';
import { publicWebReceiptCandidates, publicWebRecordFromModelReceipt } from './discovery-v3-public-web-receipts';

const query: CompanyDiscoveryQuery = { sourceClass: 'public_intelligence', filters: { country: 'DE' }, keywords: ['industrial pumps'], limit: 5 };
const registry = registerCatalogResultProjections(new TypedProjectionRegistry());
registry.freeze();
const source = 'https://www.acme-pumps.example/products';
const searchProjection = projectGenericOperationResult({
  kind: 'tool', schema: 'searxng-search/v1',
  data: JSON.parse(JSON.stringify(registry.project('searxng-search/v1', {
    data: { results: [
      { url: `${source}?tracking=source`, title: 'Industrial pumps from Acme' },
      { url: 'http://unproven.example/only', title: 'An HTTP-only result' },
      { url: 'https://no-title.example/only' },
    ] }, costCents: 0,
  }))),
});
const modelProjection = projectModelResultForReplay('discovery-extract-company/v1', {
  provider: 'fixture', model: 'fixture-model', data: { is_company_site: true, name: 'Acme Pumps GmbH', country: 'Germany' },
});
const searchLink: DiscoveryV3ResultLink = {
  operationId: 'fixture-search', resultSha256: searchProjection.digest,
  operation: { step: 'query/0/public_web/search/1/tool/1', kind: 'TOOL', ordinal: 1,
    provider: 'searxng.search', action: 'searxng.search', method: 'invoke', requestSha256: '1'.repeat(64), maxDurationMs: 100 },
};
const modelLink: DiscoveryV3ResultLink = {
  operationId: 'fixture-model', resultSha256: modelProjection.digest,
  operation: { step: `query/0/public_web/company/${createHash('sha256').update('acme-pumps.example').digest('hex')}/model/1`,
    kind: 'MODEL', ordinal: 1, provider: 'fixture', action: 'discovery.extract_company',
    method: 'generateStructured', requestSha256: '2'.repeat(64), maxDurationMs: 100 },
};

describe('Discovery v3 public web composition proof', () => {
  it('reconstructs an observed approved-shape source and binds it to the exact model digest', () => {
    const candidates = publicWebReceiptCandidates(query, 0, [{ link: searchLink, projection: searchProjection }]);
    expect([...candidates.keys()]).toEqual(['acme-pumps.example']);
    const candidate = candidates.get('acme-pumps.example')!;
    const record = publicWebRecordFromModelReceipt(query, 0, candidate, { link: modelLink, projection: modelProjection },
      new Date('2026-11-27T02:00:00Z'));
    expect(record).toMatchObject({
      domain: 'acme-pumps.example', country: 'DE', name: 'Acme Pumps GmbH',
      provenance: {
        sourceUrl: source, parserVersion: 'public_web/v3',
        contentHash: createHash('sha256').update(`public-web-v3\n${modelProjection.digest}\n${source}`).digest('hex'),
      },
    });
  });

  it('rejects a different query, result digest or company-scope model even for the same provider', () => {
    expect(() => publicWebReceiptCandidates(query, 1, [{ link: searchLink, projection: searchProjection }]))
      .toThrow('DISCOVERY_V3_PUBLIC_WEB_RECEIPT_MISMATCH');
    expect(() => publicWebReceiptCandidates(query, 0, [{
      link: { ...searchLink, resultSha256: '4'.repeat(64) }, projection: searchProjection,
    }])).toThrow('DISCOVERY_V3_PUBLIC_WEB_RECEIPT_MISMATCH');
    const candidate = publicWebReceiptCandidates(query, 0, [{ link: searchLink, projection: searchProjection }])
      .get('acme-pumps.example')!;
    expect(() => publicWebRecordFromModelReceipt(query, 0, candidate, {
      link: { ...modelLink, operation: { ...modelLink.operation, step: 'query/0/public_web/company/other/model/1' } },
      projection: modelProjection,
    }, new Date('2026-11-27T02:00:00Z'))).toThrow('DISCOVERY_V3_PUBLIC_WEB_RECEIPT_MISMATCH');
  });
});
