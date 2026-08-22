import type { DurableExecutionReceipt } from './durable-execution-receipt';
import {
  DomainAckService,
  PostgresDomainAckRepository,
  type DomainAckApplyResult,
  type DomainAckTransaction,
} from './domain-ack';

export interface DomainAckProductConsumerBinding {
  readonly producerId: string;
  readonly consumer: string;
  readonly domainAggregateType: string;
  readonly identity: string;
}

export const DOMAIN_ACK_PRODUCT_CONSUMER_BINDINGS = Object.freeze([
  { producerId: 'companies_house.search', consumer: 'CompanyRegistryDiscoveryProvider', domainAggregateType: 'CanonicalCompany', identity: 'company-registry-number' },
  { producerId: 'crawl4ai.fetch', consumer: 'WebCrawlKnowledgeSource', domainAggregateType: 'KnowledgeSource', identity: 'source-url-and-content-hash' },
  { producerId: 'crawl4ai.render', consumer: 'RenderedPageCapture', domainAggregateType: 'KnowledgeSource', identity: 'source-url-and-render-hash' },
  { producerId: 'gleif.fetch', consumer: 'LegalEntityEnrichment', domainAggregateType: 'CanonicalCompany', identity: 'lei' },
  { producerId: 'google_patents.search', consumer: 'PatentCacheBrokerScanner', domainAggregateType: 'PatentEvidence', identity: 'publicationNumber' },
  { producerId: 'http.get', consumer: 'GenericHttpArtifactConsumer', domainAggregateType: 'ExternalArtifact', identity: 'url-and-content-hash' },
  { producerId: 'inpi_rne.search', consumer: 'CompanyRegistryDiscoveryProvider', domainAggregateType: 'CanonicalCompany', identity: 'siren-or-siret' },
  { producerId: 'mapyourshow.fetch', consumer: 'TradeFairDiscoveryProvider', domainAggregateType: 'CanonicalCompany', identity: 'show-exhibitor-id' },
  { producerId: 'openfda.search', consumer: 'OpenFdaDiscoveryProvider', domainAggregateType: 'ProductRegistrationEvidence', identity: 'registration-or-k-number' },
  { producerId: 'osm.overpass', consumer: 'GeoDiscoveryProvider', domainAggregateType: 'LocationEvidence', identity: 'osm-element-id' },
  { producerId: 'samgov.search', consumer: 'SamGovDiscoveryProvider', domainAggregateType: 'FederalContractEvidence', identity: 'uei-or-award-id' },
  { producerId: 'sanctions.download', consumer: 'SanctionsScreeningCache', domainAggregateType: 'SanctionsDataset', identity: 'dataset-source-and-published-date' },
  { producerId: 'searxng.search', consumer: 'SearchDiscoveryProvider', domainAggregateType: 'SearchResultEvidence', identity: 'result-url-and-query-digest' },
  { producerId: 'smtp.rcpt_probe', consumer: 'EmailVerificationProvider', domainAggregateType: 'EmailVerification', identity: 'normalized-email-hash' },
  { producerId: 'ted.search', consumer: 'TedTenderDiscoveryProvider', domainAggregateType: 'TenderEvidence', identity: 'ted-notice-id' },
  { producerId: 'tradefair.algolia', consumer: 'TradeFairDiscoveryProvider', domainAggregateType: 'CanonicalCompany', identity: 'event-exhibitor-id' },
  { producerId: 'wikidata.entity', consumer: 'WikidataEntityResolver', domainAggregateType: 'CanonicalCompany', identity: 'wikidata-qid' },
  { producerId: 'wikidata.sparql', consumer: 'WikidataTaxonomyResolver', domainAggregateType: 'TaxonomyEvidence', identity: 'query-digest-and-qid' },
  { producerId: 'company_understanding.extract_claims', consumer: 'UnderstandingActivities.extractClaims', domainAggregateType: 'Claim', identity: 'claim-type-and-statement-digest' },
  { producerId: 'company_understanding.extract_offerings', consumer: 'UnderstandingActivities.extractOfferings', domainAggregateType: 'Offering', identity: 'company-and-offering-name' },
  { producerId: 'company_understanding.extract_profile', consumer: 'UnderstandingActivities.extractAndPersistProfile', domainAggregateType: 'CompanyProfile', identity: 'company-id' },
  { producerId: 'contact.find_decision_makers', consumer: 'DecisionMakerProvider.extract', domainAggregateType: 'Contact', identity: 'source-page-and-person-name' },
  { producerId: 'discovery.extract_company', consumer: 'PublicWebDiscoveryProvider.mineDomain', domainAggregateType: 'CanonicalCompany', identity: 'domain' },
  { producerId: 'discovery.extract_list', consumer: 'DirectoryDiscoveryProvider.extractList', domainAggregateType: 'CanonicalCompany', identity: 'directory-source-and-company-name' },
  { producerId: 'discovery.qualify_fit', consumer: 'FitJudge.upsertLeadFit', domainAggregateType: 'Lead', identity: 'workspace-icp-company' },
  { producerId: 'discovery.query_plan', consumer: 'IcpService.generateQueryPlan', domainAggregateType: 'DiscoveryQueryPlan', identity: 'icp-id' },
  { producerId: 'icp.design', consumer: 'IcpService.generateFromCompany', domainAggregateType: 'IcpDefinition', identity: 'company-id-and-icp-version' },
  { producerId: 'taxonomy.normalize', consumer: 'TaxonomyResolver', domainAggregateType: 'TermAlias', identity: 'taxonomy-kind-and-normalized-term' },
] as const satisfies readonly DomainAckProductConsumerBinding[]);

export function getDomainAckProductConsumerBinding(
  producerId: string,
): DomainAckProductConsumerBinding {
  const binding = DOMAIN_ACK_PRODUCT_CONSUMER_BINDINGS.find(
    (entry) => entry.producerId === producerId,
  );
  if (!binding) throw new Error('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
  return binding;
}

export function domainAggregateIdForReceipt(
  receipt: DurableExecutionReceipt,
  producerId: string,
): string {
  const bytes = createHash('sha256')
    .update(`${producerId}\0${receipt.operationId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type DomainAckConsumerApplyResult<TValue> =
  | DomainAckApplyResult<TValue>
  | Readonly<{ status: 'UNRECEIPTED'; value: TValue }>;

export async function applyDomainAckConsumerTransaction<
  TTransaction,
  TValue,
>(input: {
  readonly service?: DomainAckService<TTransaction>;
  readonly transaction?: TTransaction;
  readonly producerId: string;
  readonly receipt?: DurableExecutionReceipt;
  readonly domainAckKey: string;
  readonly domainRevision: string;
  readonly apply: (transaction: TTransaction) => Promise<TValue>;
}): Promise<DomainAckConsumerApplyResult<TValue>> {
  const binding = getDomainAckProductConsumerBinding(input.producerId);
  if (!input.receipt) {
    if (!input.transaction) throw new Error('DOMAIN_ACK_TRANSACTION_REQUIRED');
    return Object.freeze({
      status: 'UNRECEIPTED' as const,
      value: await input.apply(input.transaction),
    });
  }
  const service = input.service ?? (input.transaction
    ? new DomainAckService(
        new PostgresDomainAckRepository(
          input.transaction as unknown as DomainAckTransaction,
        ),
      ) as unknown as DomainAckService<TTransaction>
    : undefined);
  if (!service) throw new Error('DOMAIN_ACK_TRANSACTION_REQUIRED');
  return service.applyWithAck({
    receipt: input.receipt,
    consumer: binding.consumer,
    domainAggregateType: binding.domainAggregateType,
    domainAckKey: input.domainAckKey,
    domainRevision: input.domainRevision,
  }, input.apply);
}

export async function applyDomainAckConsumerTransactions<
  TTransaction extends DomainAckTransaction,
  TValue,
>(input: {
  readonly transaction: TTransaction;
  readonly acknowledgements: readonly Readonly<{
    producerId: string;
    receipt?: DurableExecutionReceipt;
    domainAckKey: string;
    domainRevision: string;
  }>[];
  readonly apply: (transaction: TTransaction) => Promise<TValue>;
}): Promise<TValue | undefined> {
  const receipted = input.acknowledgements.filter(
    (item): item is typeof item & { receipt: DurableExecutionReceipt } =>
      item.receipt !== undefined,
  );
  if (!receipted.length) return input.apply(input.transaction);
  let hasNewAck = false;
  for (const acknowledgement of receipted) {
    await applyDomainAckConsumerTransaction({
      transaction: input.transaction,
      ...acknowledgement,
      apply: async () => {
        hasNewAck = true;
        return undefined;
      },
    });
  }
  return hasNewAck ? input.apply(input.transaction) : undefined;
}
import { createHash } from 'node:crypto';
