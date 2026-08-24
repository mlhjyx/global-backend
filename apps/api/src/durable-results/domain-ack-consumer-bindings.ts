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
  readonly resultStrategy: DurableExecutionReceipt['resultStrategy'];
  readonly resultSchema: string;
}

export const DOMAIN_ACK_PRODUCT_CONSUMER_BINDINGS = Object.freeze([
  { producerId: 'companies_house.search', consumer: 'CompanyRegistryDiscoveryProvider', domainAggregateType: 'CanonicalCompany', identity: 'company-registry-number', resultStrategy: 'typed_projection', resultSchema: 'companies-house-search/v1' },
  { producerId: 'crawl4ai.fetch', consumer: 'WebCrawlKnowledgeSource', domainAggregateType: 'KnowledgeSource', identity: 'source-url-and-content-hash', resultStrategy: 'artifact_reference', resultSchema: 'crawl4ai-fetch/v1' },
  { producerId: 'crawl4ai.render', consumer: 'RenderedPageCapture', domainAggregateType: 'KnowledgeSource', identity: 'source-url-and-render-hash', resultStrategy: 'artifact_reference', resultSchema: 'crawl4ai-render/v1' },
  { producerId: 'gleif.fetch', consumer: 'LegalEntityEnrichment', domainAggregateType: 'CanonicalCompany', identity: 'lei', resultStrategy: 'typed_projection', resultSchema: 'gleif-fetch/v1' },
  { producerId: 'google_patents.search', consumer: 'PatentCacheBrokerScanner', domainAggregateType: 'PatentEvidence', identity: 'publicationNumber', resultStrategy: 'typed_projection', resultSchema: 'google-patents-search/v1' },
  { producerId: 'http.get', consumer: 'GenericHttpArtifactConsumer', domainAggregateType: 'ExternalArtifact', identity: 'url-and-content-hash', resultStrategy: 'artifact_reference', resultSchema: 'http-get/v1' },
  { producerId: 'inpi_rne.search', consumer: 'CompanyRegistryDiscoveryProvider', domainAggregateType: 'CanonicalCompany', identity: 'siren-or-siret', resultStrategy: 'typed_projection', resultSchema: 'inpi-rne-search/v1' },
  { producerId: 'mapyourshow.fetch', consumer: 'TradeFairDiscoveryProvider', domainAggregateType: 'CanonicalCompany', identity: 'show-exhibitor-id', resultStrategy: 'typed_projection', resultSchema: 'mapyourshow-fetch/v1' },
  { producerId: 'openfda.search', consumer: 'OpenFdaDiscoveryProvider', domainAggregateType: 'ProductRegistrationEvidence', identity: 'registration-or-k-number', resultStrategy: 'typed_projection', resultSchema: 'openfda-search/v1' },
  { producerId: 'osm.overpass', consumer: 'GeoDiscoveryProvider', domainAggregateType: 'LocationEvidence', identity: 'osm-element-id', resultStrategy: 'typed_projection', resultSchema: 'osm-overpass/v1' },
  { producerId: 'samgov.search', consumer: 'SamGovDiscoveryProvider', domainAggregateType: 'FederalContractEvidence', identity: 'uei-or-award-id', resultStrategy: 'typed_projection', resultSchema: 'samgov-search/v1' },
  { producerId: 'sanctions.download', consumer: 'SanctionsScreeningCache', domainAggregateType: 'SanctionsDataset', identity: 'dataset-source-and-published-date', resultStrategy: 'artifact_reference', resultSchema: 'sanctions-download/v1' },
  { producerId: 'searxng.search', consumer: 'SearchDiscoveryProvider', domainAggregateType: 'SearchResultEvidence', identity: 'result-url-and-query-digest', resultStrategy: 'typed_projection', resultSchema: 'searxng-search/v1' },
  { producerId: 'smtp.rcpt_probe', consumer: 'EmailVerificationProvider', domainAggregateType: 'EmailVerification', identity: 'normalized-email-hash', resultStrategy: 'typed_projection', resultSchema: 'smtp-probe-verdict/v1' },
  { producerId: 'ted.search', consumer: 'TedTenderDiscoveryProvider', domainAggregateType: 'TenderEvidence', identity: 'ted-notice-id', resultStrategy: 'typed_projection', resultSchema: 'ted-search/v1' },
  { producerId: 'tradefair.algolia', consumer: 'TradeFairDiscoveryProvider', domainAggregateType: 'CanonicalCompany', identity: 'event-exhibitor-id', resultStrategy: 'typed_projection', resultSchema: 'tradefair-algolia/v1' },
  { producerId: 'wikidata.entity', consumer: 'WikidataEntityResolver', domainAggregateType: 'CanonicalCompany', identity: 'wikidata-qid', resultStrategy: 'typed_projection', resultSchema: 'wikidata-entity/v1' },
  { producerId: 'wikidata.sparql', consumer: 'WikidataTaxonomyResolver', domainAggregateType: 'TaxonomyEvidence', identity: 'query-digest-and-qid', resultStrategy: 'typed_projection', resultSchema: 'wikidata-sparql/v1' },
  { producerId: 'company_understanding.extract_claims', consumer: 'UnderstandingActivities.extractClaims', domainAggregateType: 'Claim', identity: 'claim-type-and-statement-digest', resultStrategy: 'typed_projection', resultSchema: 'understanding-claims/v1' },
  { producerId: 'company_understanding.extract_offerings', consumer: 'UnderstandingActivities.extractOfferings', domainAggregateType: 'Offering', identity: 'company-and-offering-name', resultStrategy: 'typed_projection', resultSchema: 'understanding-offerings/v1' },
  { producerId: 'company_understanding.extract_profile', consumer: 'UnderstandingActivities.extractAndPersistProfile', domainAggregateType: 'CompanyProfile', identity: 'company-id', resultStrategy: 'typed_projection', resultSchema: 'understanding-profile/v1' },
  { producerId: 'contact.find_decision_makers', consumer: 'DecisionMakerProvider.extract', domainAggregateType: 'Contact', identity: 'source-page-and-person-name', resultStrategy: 'typed_projection', resultSchema: 'contact-decision-makers/v1' },
  { producerId: 'discovery.extract_company', consumer: 'PublicWebDiscoveryProvider.mineDomain', domainAggregateType: 'CanonicalCompany', identity: 'domain', resultStrategy: 'typed_projection', resultSchema: 'discovery-extract-company/v1' },
  { producerId: 'discovery.extract_list', consumer: 'DirectoryDiscoveryProvider.extractList', domainAggregateType: 'CanonicalCompany', identity: 'directory-source-and-company-name', resultStrategy: 'typed_projection', resultSchema: 'discovery-extract-list/v1' },
  { producerId: 'discovery.qualify_fit', consumer: 'FitJudge.upsertLeadFit', domainAggregateType: 'Lead', identity: 'workspace-icp-company', resultStrategy: 'typed_projection', resultSchema: 'fit-judgment/v1' },
  { producerId: 'discovery.query_plan', consumer: 'IcpService.generateQueryPlan', domainAggregateType: 'DiscoveryQueryPlan', identity: 'icp-id', resultStrategy: 'typed_projection', resultSchema: 'icp-query-plan/v1' },
  { producerId: 'icp.design', consumer: 'IcpService.generateFromCompany', domainAggregateType: 'IcpDefinition', identity: 'company-id-and-icp-version', resultStrategy: 'typed_projection', resultSchema: 'icp-design/v1' },
  { producerId: 'taxonomy.normalize', consumer: 'TaxonomyResolver', domainAggregateType: 'TermAlias', identity: 'taxonomy-kind-and-normalized-term', resultStrategy: 'typed_projection', resultSchema: 'taxonomy-code/v1' },
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

export type DomainAckBatchItemState = Readonly<{
  producerId: string;
  status: 'APPLIED' | 'REPLAYED' | 'UNRECEIPTED';
}>;

export type DomainAckConsumerBatchResult<TValue> = Readonly<{
  status: 'APPLIED' | 'REPLAYED' | 'UNRECEIPTED';
  acknowledgements: readonly DomainAckBatchItemState[];
  value: TValue;
}>;

function assertReceiptBinding(
  binding: DomainAckProductConsumerBinding,
  receipt: DurableExecutionReceipt,
): void {
  if (
    receipt.resultStrategy !== binding.resultStrategy ||
    receipt.resultSchema !== binding.resultSchema
  ) {
    throw new Error('DOMAIN_ACK_RECEIPT_BINDING_MISMATCH');
  }
}

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
  assertReceiptBinding(binding, input.receipt);
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
  readonly readback: (transaction: TTransaction) => Promise<TValue>;
}): Promise<DomainAckConsumerBatchResult<TValue>> {
  for (const acknowledgement of input.acknowledgements) {
    const binding = getDomainAckProductConsumerBinding(
      acknowledgement.producerId,
    );
    if (acknowledgement.receipt) {
      assertReceiptBinding(binding, acknowledgement.receipt);
    }
  }
  const receipted = input.acknowledgements.filter(
    (item): item is typeof item & { receipt: DurableExecutionReceipt } =>
      item.receipt !== undefined,
  );
  if (
    receipted.length > 0 &&
    receipted.length !== input.acknowledgements.length
  ) {
    throw new Error('DOMAIN_ACK_MIXED_RECEIPT_BATCH');
  }
  if (!receipted.length) {
    return Object.freeze({
      status: 'UNRECEIPTED' as const,
      acknowledgements: Object.freeze(
        input.acknowledgements.map((item) => Object.freeze({
          producerId: item.producerId,
          status: 'UNRECEIPTED' as const,
        })),
      ),
      value: await input.apply(input.transaction),
    });
  }
  const states: DomainAckBatchItemState[] = [];
  for (const acknowledgement of receipted) {
    const result = await applyDomainAckConsumerTransaction({
      transaction: input.transaction,
      ...acknowledgement,
      apply: async () => {
        return undefined;
      },
    });
    states.push(Object.freeze({
      producerId: acknowledgement.producerId,
      status: result.status,
    }));
  }
  const statuses = new Set(states.map((state) => state.status));
  if (statuses.size !== 1) {
    throw new Error('DOMAIN_ACK_MIXED_REPLAY_STATE');
  }
  const status = states[0]!.status as 'APPLIED' | 'REPLAYED';
  const value = status === 'APPLIED'
    ? await input.apply(input.transaction)
    : await input.readback(input.transaction);
  return Object.freeze({
    status,
    acknowledgements: Object.freeze(states),
    value,
  });
}
import { createHash } from 'node:crypto';
