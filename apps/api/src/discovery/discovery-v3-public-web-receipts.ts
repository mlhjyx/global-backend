import { createHash } from 'node:crypto';
import { registerCatalogResultProjections } from '../durable-results/catalog-result-projections';
import { restoreModelResultFromReplay } from '../durable-results/model-result-replay';
import { TypedProjectionRegistry } from '../durable-results/typed-projection.registry';
import type { SearxngSearchOutput, SearxngSearchResult } from '../tools/builtin-tools';
import type { GenericOperationProjection } from '../tools/generic-operation-projection';
import type { ToolResult } from '../tools/tool-contract';
import { readBuyerProcurementScenario } from './buyer-procurement-scenarios';
import { normalizeCompanyNameTypography } from './company-name-format';
import { fuseSearchEngineHits, type SearchSourceBucket } from './cross-source-fusion';
import type { DiscoveryV3ResultLink } from './discovery-v3-operation-scope';
import type { CompanyDiscoveryQuery, DiscoveryOptions, ProviderCompanyRecord } from './provider-contract';
import {
  collectPublicWebCandidateHits, type ExtractedCompany, mapPublicWebCompanyToRecord,
  observedPublicWebEvidenceUrl, publicWebEvidencePage, searchEvidenceText,
} from './providers/public-web.provider';

const projections = registerCatalogResultProjections(new TypedProjectionRegistry());
projections.freeze();

type SearchProducer = 'searxng.search' | 'serper.search';
const searchContracts = {
  'searxng.search': { schema: 'searxng-search/v1', engine: 'searxng', slot: '1' },
  'serper.search': { schema: 'serper-search/v1', engine: 'serper', slot: '2' },
} as const;
export const PUBLIC_WEB_MODEL_SCHEMA = 'discovery-extract-company/v1';

interface PublicWebResultProof {
  readonly link: DiscoveryV3ResultLink;
  readonly projection: GenericOperationProjection;
}

export interface DiscoveryV3PublicWebCandidate {
  readonly domain: string;
  readonly evidenceText: string;
  readonly sourceUrl: string;
  readonly sourceLink: DiscoveryV3ResultLink;
}

export function publicWebReceiptMismatch(): never {
  throw new Error('DISCOVERY_V3_PUBLIC_WEB_RECEIPT_MISMATCH');
}

export function publicWebModelScope(queryOrdinal: number, domain: string): string {
  return `query/${queryOrdinal}/public_web/company/${createHash('sha256').update(domain).digest('hex')}`;
}

export function publicWebSearchRoles(queryOrdinal: number, proof: PublicWebResultProof) {
  const { link, projection } = proof;
  const { operation } = link;
  if (!Object.hasOwn(searchContracts, operation.action)) return publicWebReceiptMismatch();
  const contract = searchContracts[operation.action as SearchProducer];
  const [kind, ordinal, source, stage, index, kindOfOperation, slot, extra] = operation.step.split('/');
  if (kind !== 'query' || ordinal !== String(queryOrdinal) || source !== 'public_web' || stage !== 'search' ||
    !index || !/^[1-9][0-9]?$/u.test(index) || kindOfOperation !== 'tool' || slot !== contract.slot ||
    extra !== undefined || operation.kind !== 'TOOL' || operation.ordinal !== 1 || operation.method !== 'invoke' ||
    operation.provider !== operation.action || projection.kind !== 'tool' || projection.schema !== contract.schema ||
    projection.digest !== link.resultSha256) return publicWebReceiptMismatch();
  const restored = projections.restore(projection.data) as ToolResult<SearxngSearchOutput>;
  return { index: Number(index), engine: contract.engine, hits: restored.data.results };
}

/** Replay both search engines through the same rank fusion and candidate filter as discovery. */
export function publicWebReceiptCandidates(
  query: CompanyDiscoveryQuery, queryOrdinal: number, proofs: readonly PublicWebResultProof[], options?: DiscoveryOptions,
): Map<string, DiscoveryV3PublicWebCandidate> {
  const searchGroups = new Map<number, SearchSourceBucket[]>();
  const sourceLinks = new Map<string, DiscoveryV3ResultLink>();
  for (const proof of proofs) {
    const { index, engine, hits } = publicWebSearchRoles(queryOrdinal, proof);
    const group = searchGroups.get(index) ?? [];
    if (group.some((entry) => entry.source === engine)) return publicWebReceiptMismatch();
    const eligible: SearxngSearchResult[] = [];
    for (const hit of hits) {
      const url = observedPublicWebEvidenceUrl(hit.url);
      if (!url || !hit.title?.trim()) continue;
      eligible.push({ url, title: hit.title });
      if (!sourceLinks.has(url)) sourceLinks.set(url, proof.link);
    }
    group.push({ source: engine, hits: eligible });
    searchGroups.set(index, group);
  }
  const perQuery = [...searchGroups.entries()].sort(([a], [b]) => a - b).map(([, group]) => fuseSearchEngineHits(group));
  const scenario = readBuyerProcurementScenario(query.filters);
  const preferProjectPage = scenario === 'factory_direct' || scenario === 'equipment_integration';
  const output = new Map<string, DiscoveryV3PublicWebCandidate>();
  for (const [domain, hits] of collectPublicWebCandidateHits(perQuery, query, options)) {
    const sourceUrl = publicWebEvidencePage(domain, hits.map(({ url }) => url), preferProjectPage);
    const evidenceText = searchEvidenceText(hits);
    if (!sourceUrl || !evidenceText || !evidenceText.split('\n').includes(`  URL：${sourceUrl}`)) continue;
    const sourceLink = sourceLinks.get(sourceUrl);
    if (!sourceLink) return publicWebReceiptMismatch();
    output.set(domain, { domain, evidenceText, sourceUrl, sourceLink });
  }
  return output;
}

export function publicWebRecordFromModelReceipt(
  query: CompanyDiscoveryQuery, queryOrdinal: number, candidate: DiscoveryV3PublicWebCandidate,
  proof: PublicWebResultProof, sourceClaimedAt: Date,
): ProviderCompanyRecord | null {
  const { link, projection } = proof;
  if (link.operation.kind !== 'MODEL' || link.operation.action !== 'discovery.extract_company' ||
    link.operation.method !== 'generateStructured' || link.operation.step !== `${publicWebModelScope(queryOrdinal, candidate.domain)}/model/1` ||
    projection.digest !== link.resultSha256 || projection.schema !== PUBLIC_WEB_MODEL_SCHEMA ||
    !Number.isFinite(sourceClaimedAt.getTime())) return publicWebReceiptMismatch();
  const { data } = restoreModelResultFromReplay(PUBLIC_WEB_MODEL_SCHEMA, projection) as { data: ExtractedCompany };
  if (!data.is_company_site || !data.name || !normalizeCompanyNameTypography(data.name)) return null;
  const record = mapPublicWebCompanyToRecord({
    domain: candidate.domain, hitUrls: [candidate.sourceUrl], sourceText: candidate.evidenceText,
    extracted: data, sourceClass: query.sourceClass, fetchedAt: sourceClaimedAt.toISOString(),
  });
  if (!record.provenance || record.provenance.sourceUrl !== candidate.sourceUrl) return publicWebReceiptMismatch();
  const contentHash = createHash('sha256').update(`public-web-v3\n${link.resultSha256}\n${candidate.sourceUrl}`).digest('hex');
  return { ...record, provenance: { ...record.provenance, contentHash, parserVersion: 'public_web/v3' } };
}
