import { createHash } from 'node:crypto';
import { types } from 'node:util';
import {
  parseDurableExecutionReceiptFacts,
  parseDurableExecutionReceipt,
  type DurableExecutionReceipt,
} from '../durable-results/durable-execution-receipt';
import { parseExecutionBudgetBinding } from '../execution-budget/execution-budget-binding';
import { ExecutionControlError } from '../execution-budget/execution-control-error';
import {
  DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
  parseDiscoveryCompanyResultLineage,
  type DiscoveryCompanyLineageProviderKey,
} from './company-discovery-lineage';
import { discoveryQueryKey, parseDiscoveryQueryReceipt } from './discovery-query-receipt';

export const DISCOVERY_QUERY_LINEAGE_COMMAND_V2 =
  'discovery-query-lineage-command/v2' as const;
export const DISCOVERY_QUERY_LINEAGE_LOOKUP_V1 =
  'discovery-query-lineage-lookup/v1' as const;
export const DISCOVERY_QUERY_LINEAGE_CONTRACT_V2 =
  'discovery-query-lineage-contract/v2' as const;
export const DISCOVERY_QUERY_RAW_RELATION_V1 =
  'discovery-query-raw-relation/v1' as const;

const INVALID = 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID';
const MISMATCH = 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_KEY = /^[a-z][a-z0-9._-]{0,127}$/u;
const LOOKUP_KEYS = Object.freeze([
  'workspaceId', 'runId', 'planId', 'queryKey', 'queryOrdinal',
  'query', 'binding',
] as const);
const PROVIDER_INPUT_KEYS = Object.freeze([
  'selectedProviders', 'providerResults', 'callbackReceipts',
  'auxiliaryOperationIds',
] as const);
const SELECTED_KEYS = Object.freeze(['providerKey', 'lineageSchema'] as const);
const RESULT_KEYS = Object.freeze(['providerKey', 'lineage', 'costCents'] as const);
const QUERY_KEYS = Object.freeze(['source_class', 'filters', 'keywords', 'priority'] as const);
const RECEIPT_KEYS = Object.freeze(['producerId', 'receipt'] as const);
const FINAL_KEYS = Object.freeze([
  'lookup', 'providerPlan', 'resolutions', 'rawReceipts',
  'budgetAuthorization', 'budgetTruncated', 'ackFacts',
] as const);
const AUTHORIZATION_KEYS = Object.freeze([
  'accountId', 'authorityId', 'authorizedCapMicrousd', 'generation',
] as const);
const ACK_FACT_KEYS = Object.freeze(['producerId', 'operationId', 'status', 'ack'] as const);
const ACK_KEYS = Object.freeze([
  'schemaVersion', 'ackId', 'operationId', 'operationKey', 'authorityId',
  'accountId', 'scopeKey', 'consumer', 'domainAggregateType', 'domainAckKey',
  'domainRevision', 'resultStrategy', 'resultSchema', 'resultDigest',
  'artifactId', 'usage', 'costBasis',
] as const);
const RESOLUTION_KEYS = Object.freeze({
  WRITE: Object.freeze(['providerKey', 'recordIndex', 'kind', 'row']),
  EXISTING: Object.freeze(['providerKey', 'recordIndex', 'kind', 'rawRecordId']),
  REUSE_BATCH: Object.freeze(['providerKey', 'recordIndex', 'kind', 'sourceRecordIndex']),
});
const RAW_RECEIPT_KEYS = Object.freeze([
  'providerKey', 'recordIndex', 'rawRecordId', 'payloadHash', 'ingestStatus',
  'materialization',
] as const);
const PROVIDER_CONTRACT = Object.freeze({
  trade_fair: Object.freeze({
    producerId: 'tradefair.algolia', resultSchema: 'tradefair-algolia/v1',
    consumer: 'TradeFairDiscoveryProvider', classes: Object.freeze(['industry_data']),
  }),
  public_web: Object.freeze({
    producerId: 'discovery.extract_company', resultSchema: 'discovery-extract-company/v1',
    consumer: 'PublicWebDiscoveryProvider.mineDomain',
    classes: Object.freeze(['public_intelligence', 'industry_data']),
  }),
  directory: Object.freeze({
    producerId: 'discovery.extract_list', resultSchema: 'discovery-extract-list/v1',
    consumer: 'DirectoryDiscoveryProvider.extractList', classes: Object.freeze(['industry_data']),
  }),
} satisfies Record<DiscoveryCompanyLineageProviderKey, Readonly<{
  producerId: string; resultSchema: string; consumer: string; classes: readonly string[];
}>>);
const LINEAGE_DESCRIPTOR = Object.freeze({
  schemaVersion: DISCOVERY_QUERY_LINEAGE_CONTRACT_V2,
  commandSchema: DISCOVERY_QUERY_LINEAGE_COMMAND_V2,
  lookupSchema: DISCOVERY_QUERY_LINEAGE_LOOKUP_V1,
  queryReceiptSchema: 'discovery-query-receipt/v1',
  commandFields: Object.freeze([
    'schemaVersion', 'contractSha256', 'lookup', 'queryReceipt',
    'queryReceiptContractSha256', 'rawRelationContractSha256',
    'budgetTruncated', 'attempts', 'items', 'authorization',
  ]),
  lookupFields: Object.freeze([
    'workspaceId', 'runId', 'planId', 'queryKey', 'queryOrdinal',
    'authorityId', 'accountKey', 'purpose', 'subjectType', 'subjectId',
    'requestSha256', 'sourceClass',
  ]),
  queryReceiptFields: Object.freeze([
    'schemaVersion', 'queryKey', 'queryOrdinal', 'sourceClass', 'providers',
    'accepted', 'quarantined', 'rejected', 'governanceDenied', 'duplicate',
    'usageQuantity', 'costCents',
  ]),
  attemptFields: Object.freeze([
    'providerKey', 'producerId', 'operationId', 'authorityId', 'accountId',
    'operationGeneration', 'ackId', 'consumer', 'domainAggregateType',
    'domainAckKey', 'domainRevision', 'resultDigest', 'resultSchema',
    'lineageSchema', 'providerRecordCount', 'coveredItemCount', 'contractSha256',
  ]),
  itemFields: Object.freeze([
    'id', 'providerKey', 'operationId', 'recordIndex', 'resolutionKind',
    'sourceRecordIndex', 'rawRecordId', 'rawPayloadHash', 'rawIngestStatus',
    'relationKey', 'sourceRefNamespace', 'sourceRefUuid', 'ackId',
    'contractSha256',
  ]),
  providerContracts: Object.freeze({
    trade_fair: Object.freeze({
      producerId: 'tradefair.algolia', consumer: 'TradeFairDiscoveryProvider',
      resultSchema: 'tradefair-algolia/v1', classes: Object.freeze(['industry_data']),
    }),
    public_web: Object.freeze({
      producerId: 'discovery.extract_company',
      consumer: 'PublicWebDiscoveryProvider.mineDomain',
      resultSchema: 'discovery-extract-company/v1',
      classes: Object.freeze(['public_intelligence', 'industry_data']),
    }),
    directory: Object.freeze({
      producerId: 'discovery.extract_list',
      consumer: 'DirectoryDiscoveryProvider.extractList',
      resultSchema: 'discovery-extract-list/v1', classes: Object.freeze(['industry_data']),
    }),
  }),
  ackIdentity: Object.freeze({
    aggregateType: 'RawSourceRecord',
    domainAckKeyInput: 'runId:providerKey:operationId',
    domainRevisionInput: 'resultDigest',
    requiredStatus: 'APPLIED',
  }),
  resolutionKinds: Object.freeze(['INSERTED', 'EXISTING', 'REUSE_BATCH']),
  countPolicy: Object.freeze({
    accepted: 'INSERTED+ACCEPTED',
    quarantined: 'INSERTED+QUARANTINED',
    rejected: 'INSERTED+REJECTED',
    duplicate: 'EXISTING+REUSE_BATCH',
    governanceDenied: 'quarantined+rejected',
    usageQuantity: 'accepted',
  }),
  zeroCompanyShapes: Object.freeze([
    'selected_empty_global_zero_ack',
    'selected_not_invoked_aux_ack_only',
    'settled_zero_output_company_ack',
  ]),
  authorizationFields: Object.freeze(['authorityId', 'accountId', 'operationGeneration']),
  maxAttempts: 128,
  maxCoveredItemsPerAttempt: 4_095,
  maxProviderRecords: 1_000_000,
  maxCostCents: 1_000_000_000,
});
const RAW_RELATION_DESCRIPTOR = Object.freeze({
  schemaVersion: DISCOVERY_QUERY_RAW_RELATION_V1,
  rootSubjectType: 'tool_operation',
  rootSubjectIdFrom: 'attempt.operationId',
  rootDataClass: 'NON_PERSONAL',
  rootDsrSubjectType: null,
  rootDsrSubjectId: null,
  parentGovernedSubjectId: null,
  childSubjectType: 'raw_source_record',
  childSubjectIdFrom: 'item.rawRecordId',
  childDataClass: 'NON_PERSONAL',
  childDsrSubjectType: null,
  childDsrSubjectId: null,
  relationKind: 'MATERIALIZED_CHILD',
  relationKeyPrefix: 'discovery.raw_source_record:',
  relationKeySuffixFrom: 'item.recordIndex',
  sourceRefNamespace: 'discovery_query_attempt_item',
  sourceRefUuidFrom: 'item.id',
  sourceRefSha256: null,
  cardinality: 'one_relation_per_provider_index',
  duplicateRawPolicy: 'preserve_distinct_index_relations',
});
export const DISCOVERY_QUERY_LINEAGE_CONTRACT_SHA256 = sha(canonical(LINEAGE_DESCRIPTOR));
export const DISCOVERY_QUERY_RAW_RELATION_SHA256 = sha(canonical(RAW_RELATION_DESCRIPTOR));

type DataRecord = Record<string, unknown>;
type GovernedAttempt = Readonly<{
  providerKey: DiscoveryCompanyLineageProviderKey;
  producerId: string;
  receipt: DurableExecutionReceipt;
  recordIndexes: readonly number[];
  providerRecordCount: number;
}>;
type GovernedPlan = Readonly<{
  mode: 'governed';
  providers: readonly string[];
  attempts: readonly GovernedAttempt[];
  auxiliaryOperationIds: readonly string[];
  costCents: number;
}>;

const BUILT_LOOKUPS = new WeakSet<object>();
const BUILT_PLANS = new WeakSet<object>();

function fail(code = INVALID): never {
  throw new ExecutionControlError(code);
}

function isControl(error: unknown, code: string): boolean {
  return error instanceof ExecutionControlError && error.code === code;
}

function ownRecord(value: unknown, keys: readonly string[], code = INVALID): DataRecord {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
      fail(code);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
      keys.some((key) => {
        const descriptor = descriptors[key];
        return descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value');
      })
    ) fail(code);
    return value as DataRecord;
  } catch (error) {
    if (isControl(error, code)) throw error;
    return fail(code);
  }
}

function field(record: DataRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function boundedDataRecord(value: unknown): DataRecord {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > 64 ||
      keys.some((key) => typeof key !== 'string') ||
      Object.values(descriptors).some((descriptor) =>
        descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value'))
    ) fail();
    return value as DataRecord;
  } catch (error) {
    if (isControl(error, INVALID)) throw error;
    return fail();
  }
}

function snapshotJson(value: unknown, remaining = { value: 1_024 }, depth = 0): unknown {
  remaining.value -= 1;
  if (remaining.value < 0 || depth > 8) fail();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail();
    return value;
  }
  if (typeof value === 'string') {
    if (value.normalize('NFC') !== value || Buffer.byteLength(value, 'utf8') > 1_024) fail();
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(strictArray(value, 128).map((item) =>
      snapshotJson(item, remaining, depth + 1)));
  }
  const record = boundedDataRecord(value);
  const result = Object.create(null) as DataRecord;
  for (const key of Object.keys(record).sort()) {
    if (key.normalize('NFC') !== key || Buffer.byteLength(key, 'utf8') > 128) fail();
    Object.defineProperty(result, key, {
      enumerable: true,
      configurable: false,
      writable: false,
      value: snapshotJson(field(record, key), remaining, depth + 1),
    });
  }
  return Object.freeze(result);
}

function snapshotQuery(value: unknown): Readonly<{
  source_class: string; filters: Record<string, unknown>; keywords: string[]; priority: number;
}> {
  const input = ownRecord(value, QUERY_KEYS);
  const sourceClass = text(field(input, 'source_class'), /^[a-z0-9][a-z0-9._-]{0,63}$/u);
  const filters = snapshotJson(field(input, 'filters'));
  const keywords = snapshotJson(field(input, 'keywords'));
  const priority = field(input, 'priority');
  if (
    !filters || typeof filters !== 'object' || Array.isArray(filters) ||
    !Array.isArray(keywords) || !keywords.every((item) => typeof item === 'string') ||
    !Number.isSafeInteger(priority) || Number(priority) < 0 || Number(priority) > 1_000_000
  ) fail();
  return Object.freeze({
    source_class: sourceClass,
    filters: filters as Record<string, unknown>,
    keywords: Object.freeze([...keywords]) as unknown as string[],
    priority: Number(priority),
  });
}

function strictArray(value: unknown, maximum = 1_000, code = INVALID): readonly unknown[] {
  try {
    if (!Array.isArray(value) || types.isProxy(value)) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) fail(code);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) fail(code);
    return Object.freeze(Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) fail(code);
      return descriptor.value;
    }));
  } catch (error) {
    if (isControl(error, code)) throw error;
    return fail(code);
  }
}

function text(value: unknown, pattern: RegExp, code = INVALID): string {
  if (typeof value !== 'string' || value.normalize('NFC') !== value || !pattern.test(value)) {
    fail(code);
  }
  return value;
}

function providerKey(value: unknown): DiscoveryCompanyLineageProviderKey {
  if (value !== 'trade_fair' && value !== 'public_web' && value !== 'directory') fail();
  return value;
}

function receiptSignature(producerId: string, receipt: DurableExecutionReceipt): string {
  return JSON.stringify({ producerId, receipt });
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseCallbackReceipt(value: unknown): Readonly<{
  producerId: string; receipt: DurableExecutionReceipt;
}> {
  const record = ownRecord(value, RECEIPT_KEYS);
  const producerId = text(field(record, 'producerId'), SAFE_KEY);
  const provider = (Object.keys(PROVIDER_CONTRACT) as DiscoveryCompanyLineageProviderKey[])
    .find((key) => PROVIDER_CONTRACT[key].producerId === producerId);
  if (!provider) fail(MISMATCH);
  const receipt = parseDurableExecutionReceipt(field(record, 'receipt'));
  if (
    receipt.resultStrategy !== 'typed_projection' ||
    receipt.resultSchema !== PROVIDER_CONTRACT[provider].resultSchema
  ) fail(MISMATCH);
  return Object.freeze({ producerId, receipt });
}

function deterministicUuid(material: string): string {
  const hex = createHash('sha256').update(material).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!;
  const joined = hex.join('');
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

export function buildDiscoveryQueryLineageLookup(value: unknown): Readonly<DataRecord> {
  try {
    const input = ownRecord(value, LOOKUP_KEYS);
    const workspaceId = text(field(input, 'workspaceId'), UUID);
    const runId = text(field(input, 'runId'), UUID);
    const planId = text(field(input, 'planId'), UUID);
    const queryKey = text(field(input, 'queryKey'), SHA256);
    const queryOrdinal = field(input, 'queryOrdinal');
    if (
      !Number.isSafeInteger(queryOrdinal) || Number(queryOrdinal) < 0 || Number(queryOrdinal) > 1_023
    ) fail();
    const query = snapshotQuery(field(input, 'query'));
    const calculatedQueryKey = discoveryQueryKey({
      runId, planId, queryOrdinal: Number(queryOrdinal), query,
    });
    if (queryKey !== calculatedQueryKey) fail();
    const bindingRecord = ownRecord(field(input, 'binding'), [
      'authorityId', 'replay', 'scopeKey', 'accountKey', 'purpose',
      'subjectType', 'subjectId', 'requestSha256',
    ]);
    const binding = parseExecutionBudgetBinding(bindingRecord, {
      scopeKey: workspaceId, purpose: 'discovery.run', subjectType: 'discovery_run',
    });
    if (binding.subjectId !== `request:${binding.requestSha256}`) fail();
    const result = Object.freeze({
      schemaVersion: DISCOVERY_QUERY_LINEAGE_LOOKUP_V1,
      workspaceId, runId, planId, queryKey, queryOrdinal: Number(queryOrdinal),
      authorityId: binding.authorityId,
      accountKey: binding.accountKey,
      purpose: binding.purpose,
      subjectType: binding.subjectType,
      subjectId: binding.subjectId,
      requestSha256: binding.requestSha256,
      sourceClass: query.source_class,
    });
    BUILT_LOOKUPS.add(result);
    return result;
  } catch (error) {
    if (isControl(error, INVALID)) throw error;
    return fail();
  }
}

export function projectDiscoveryQueryLineageAttestKey(
  lookup: unknown,
): Readonly<DataRecord> {
  if (!lookup || typeof lookup !== 'object' || !BUILT_LOOKUPS.has(lookup)) fail();
  const source = lookup as DataRecord;
  return Object.freeze({
    schemaVersion: DISCOVERY_QUERY_LINEAGE_LOOKUP_V1,
    workspaceId: source.workspaceId,
    runId: source.runId,
    planId: source.planId,
    queryKey: source.queryKey,
    queryOrdinal: source.queryOrdinal,
    authorityId: source.authorityId,
    accountKey: source.accountKey,
    purpose: source.purpose,
    subjectType: source.subjectType,
    subjectId: source.subjectId,
    requestSha256: source.requestSha256,
  });
}

export function buildDiscoveryQueryProviderPlan(value: unknown): GovernedPlan | Readonly<{ mode: 'legacy' }> {
  try {
    const input = ownRecord(value, PROVIDER_INPUT_KEYS);
    const selected = strictArray(field(input, 'selectedProviders'), 16).map((entry) => {
      const item = ownRecord(entry, SELECTED_KEYS);
      const rawKey = field(item, 'providerKey');
      const lineageSchema = field(item, 'lineageSchema');
      if (lineageSchema === null) {
        text(rawKey, SAFE_KEY);
        return Object.freeze({ providerKey: rawKey as string, lineageSchema: null });
      }
      return Object.freeze({
        providerKey: providerKey(rawKey),
        lineageSchema: lineageSchema === DISCOVERY_COMPANY_RESULT_LINEAGE_V1
          ? DISCOVERY_COMPANY_RESULT_LINEAGE_V1 : fail(),
      });
    });
    if (new Set(selected.map((item) => item.providerKey)).size !== selected.length) fail();
    if (selected.some((item) => item.lineageSchema === null)) {
      return Object.freeze({ mode: 'legacy' as const });
    }
    const providers = Object.freeze(selected.map((item) => item.providerKey).sort());
    const resultEntries = strictArray(field(input, 'providerResults'), 16);
    if (resultEntries.length !== providers.length) fail();
    const seen = new Set<string>();
    const attempts: GovernedAttempt[] = [];
    const expectedCallbacks: string[] = [];
    let costCents = 0;
    for (const entry of resultEntries) {
      const item = ownRecord(entry, RESULT_KEYS);
      const key = providerKey(field(item, 'providerKey'));
      if (!providers.includes(key) || seen.has(key)) fail();
      seen.add(key);
      const providerCost = field(item, 'costCents');
      if (!Number.isSafeInteger(providerCost) || Number(providerCost) < 0) fail();
      costCents += Number(providerCost);
      if (!Number.isSafeInteger(costCents) || costCents > 1_000_000_000) fail();
      const lineage = parseDiscoveryCompanyResultLineage(field(item, 'lineage'), key);
      if (
        lineage.recordCount > 1_000_000 ||
        lineage.receiptCoverage.some((coverage) => coverage.recordIndexes.length > 4_095)
      ) fail();
      for (const attempt of lineage.attemptReceipts) {
        attempts.push(Object.freeze({
          providerKey: key, producerId: attempt.producerId, receipt: attempt.receipt,
          recordIndexes: Object.freeze([]), providerRecordCount: lineage.recordCount,
        }));
        expectedCallbacks.push(receiptSignature(attempt.producerId, attempt.receipt));
      }
      for (const coverage of lineage.receiptCoverage) {
        attempts.push(Object.freeze({
          providerKey: key, producerId: coverage.producerId, receipt: coverage.receipt,
          recordIndexes: coverage.recordIndexes,
          providerRecordCount: lineage.recordCount,
        }));
        expectedCallbacks.push(receiptSignature(coverage.producerId, coverage.receipt));
      }
    }
    if (attempts.length > 128) fail();
    const callbacks = strictArray(field(input, 'callbackReceipts'), 128)
      .map(parseCallbackReceipt)
      .map((item) => receiptSignature(item.producerId, item.receipt));
    const expected = [...expectedCallbacks].sort();
    const actual = [...callbacks].sort();
    if (expected.length !== actual.length || expected.some((item, index) => item !== actual[index])) {
      fail(MISMATCH);
    }
    const auxiliaryOperationIds = Object.freeze(
      strictArray(field(input, 'auxiliaryOperationIds'), 512)
        .map((id) => text(id, UUID)).sort(),
    );
    if (
      new Set(auxiliaryOperationIds).size !== auxiliaryOperationIds.length ||
      auxiliaryOperationIds.some((id) => attempts.some(
        (attempt) => attempt.receipt.operationId === id,
      ))
    ) fail();
    const result = Object.freeze({
      mode: 'governed' as const,
      providers,
      attempts: Object.freeze(attempts.sort((left, right) =>
        left.receipt.operationId.localeCompare(right.receipt.operationId))),
      auxiliaryOperationIds,
      costCents,
    });
    BUILT_PLANS.add(result);
    return result;
  } catch (error) {
    if (isControl(error, INVALID) || isControl(error, MISMATCH)) throw error;
    return fail();
  }
}

function parseAuthorization(value: unknown): Readonly<{
  accountId: string; authorityId: string; generation: number;
}> {
  const input = ownRecord(value, AUTHORIZATION_KEYS);
  const accountId = text(field(input, 'accountId'), UUID);
  const authorityId = text(field(input, 'authorityId'), UUID);
  const generation = field(input, 'generation');
  const cap = field(input, 'authorizedCapMicrousd');
  if (
    !Number.isInteger(generation) || Number(generation) < 1 || Number(generation) > 2_147_483_647 ||
    typeof cap !== 'bigint' || cap < 0n
  ) fail();
  return Object.freeze({ accountId, authorityId, generation: Number(generation) });
}

function parseAckFact(value: unknown): Readonly<{
  producerId: string; operationId: string; status: 'APPLIED' | 'REPLAYED'; ack: DataRecord;
}> {
  const input = ownRecord(value, ACK_FACT_KEYS, MISMATCH);
  const producerId = text(field(input, 'producerId'), SAFE_KEY, MISMATCH);
  const operationId = text(field(input, 'operationId'), UUID, MISMATCH);
  const status = field(input, 'status');
  if (status !== 'APPLIED' && status !== 'REPLAYED') fail(MISMATCH);
  const ack = ownRecord(field(input, 'ack'), ACK_KEYS, MISMATCH);
  if (
    field(ack, 'schemaVersion') !== 'domain-ack/v1' ||
    field(ack, 'ackId') !== text(field(ack, 'ackId'), SHA256, MISMATCH) ||
    field(ack, 'operationId') !== operationId ||
    field(ack, 'operationKey') !== text(field(ack, 'operationKey'), /^[A-Za-z0-9:._/-]{1,200}$/u, MISMATCH) ||
    field(ack, 'authorityId') !== text(field(ack, 'authorityId'), UUID, MISMATCH) ||
    field(ack, 'accountId') !== text(field(ack, 'accountId'), UUID, MISMATCH) ||
    field(ack, 'scopeKey') !== text(field(ack, 'scopeKey'), UUID, MISMATCH) ||
    field(ack, 'consumer') !== text(field(ack, 'consumer'), /^[A-Za-z0-9:._/-]{1,200}$/u, MISMATCH) ||
    field(ack, 'domainAggregateType') !== 'RawSourceRecord' ||
    field(ack, 'domainAckKey') !== text(field(ack, 'domainAckKey'), SHA256, MISMATCH) ||
    field(ack, 'domainRevision') !== text(field(ack, 'domainRevision'), SHA256, MISMATCH) ||
    field(ack, 'resultStrategy') !== 'typed_projection' ||
    field(ack, 'resultSchema') !== text(field(ack, 'resultSchema'), /^[a-z][a-z0-9-]{0,99}\/v[1-9][0-9]{0,5}$/u, MISMATCH) ||
    field(ack, 'resultDigest') !== text(field(ack, 'resultDigest'), SHA256, MISMATCH) ||
    field(ack, 'artifactId') !== null ||
    field(ack, 'costBasis') !== text(field(ack, 'costBasis'), /^[a-z_]{1,40}$/u, MISMATCH)
  ) fail(MISMATCH);
  const facts = parseDurableExecutionReceiptFacts({
    usage: field(ack, 'usage'),
    costBasis: field(ack, 'costBasis'),
  }, String(field(ack, 'resultSchema')));
  const snapshot = Object.freeze(Object.fromEntries(ACK_KEYS.map((key) => [
    key,
    key === 'usage' ? facts.usage : key === 'costBasis' ? facts.costBasis : field(ack, key),
  ]))) as DataRecord;
  return Object.freeze({ producerId, operationId, status, ack: snapshot });
}

export function finalizeDiscoveryQueryLineageCommand(value: unknown): Readonly<DataRecord> {
  try {
    const input = ownRecord(value, FINAL_KEYS);
    const lookup = field(input, 'lookup');
    const providerPlan = field(input, 'providerPlan');
    if (!lookup || typeof lookup !== 'object' || !BUILT_LOOKUPS.has(lookup)) fail();
    if (!providerPlan || typeof providerPlan !== 'object' || !BUILT_PLANS.has(providerPlan)) fail();
    const plan = providerPlan as GovernedPlan;
    const sourceClass = String((lookup as DataRecord).sourceClass);
    if (plan.providers.some((key) =>
      !PROVIDER_CONTRACT[providerKey(key)].classes.includes(sourceClass))) fail(MISMATCH);
    const authorization = parseAuthorization(field(input, 'budgetAuthorization'));
    const budgetTruncated = field(input, 'budgetTruncated');
    if (typeof budgetTruncated !== 'boolean') fail();
    if (authorization.authorityId !== (lookup as DataRecord).authorityId) fail(MISMATCH);
    const facts = strictArray(field(input, 'ackFacts'), 128, MISMATCH).map(parseAckFact);
    if (facts.some((fact) => fact.status !== 'APPLIED')) fail(MISMATCH);
    const operations = plan.attempts.map((attempt) => attempt.receipt.operationId).sort();
    const factOperations = facts.map((fact) => fact.operationId).sort();
    if (
      operations.length !== factOperations.length ||
      operations.some((operation, index) => operation !== factOperations[index]) ||
      new Set(factOperations).size !== factOperations.length
    ) fail(MISMATCH);
    const factByOperation = new Map(facts.map((fact) => [fact.operationId, fact]));
    const attemptCommands: DataRecord[] = [];
    for (const attempt of plan.attempts) {
      const fact = factByOperation.get(attempt.receipt.operationId);
      const contract = PROVIDER_CONTRACT[attempt.providerKey];
      const expectedDomainAckKey = sha(
        `${String((lookup as DataRecord).runId)}:${attempt.providerKey}:${attempt.receipt.operationId}`,
      );
      const expectedDomainRevision = sha(attempt.receipt.resultDigest);
      const expectedAckId = sha(canonical({
        operationId: attempt.receipt.operationId,
        consumer: contract.consumer,
        domainAggregateType: 'RawSourceRecord',
        domainAckKey: expectedDomainAckKey,
        domainRevision: expectedDomainRevision,
        resultDigest: attempt.receipt.resultDigest,
      }));
      if (
        !fact || fact.producerId !== attempt.producerId ||
        attempt.receipt.scopeKey !== (lookup as DataRecord).workspaceId ||
        attempt.receipt.authorityId !== authorization.authorityId ||
        attempt.receipt.accountId !== authorization.accountId ||
        field(fact.ack, 'authorityId') !== authorization.authorityId ||
        field(fact.ack, 'accountId') !== authorization.accountId ||
        field(fact.ack, 'scopeKey') !== (lookup as DataRecord).workspaceId ||
        field(fact.ack, 'operationId') !== attempt.receipt.operationId ||
        field(fact.ack, 'operationKey') !== attempt.receipt.operationKey ||
        field(fact.ack, 'consumer') !== contract.consumer ||
        field(fact.ack, 'domainAggregateType') !== 'RawSourceRecord' ||
        field(fact.ack, 'domainAckKey') !== expectedDomainAckKey ||
        field(fact.ack, 'domainRevision') !== expectedDomainRevision ||
        field(fact.ack, 'ackId') !== expectedAckId ||
        field(fact.ack, 'resultStrategy') !== attempt.receipt.resultStrategy ||
        field(fact.ack, 'resultSchema') !== contract.resultSchema ||
        field(fact.ack, 'resultDigest') !== attempt.receipt.resultDigest ||
        field(fact.ack, 'artifactId') !== attempt.receipt.artifactId ||
        canonical(field(fact.ack, 'usage')) !== canonical(attempt.receipt.usage) ||
        field(fact.ack, 'costBasis') !== attempt.receipt.costBasis
      ) fail(MISMATCH);
      attemptCommands.push(Object.freeze({
        providerKey: attempt.providerKey,
        producerId: attempt.producerId,
        operationId: attempt.receipt.operationId,
        authorityId: authorization.authorityId,
        accountId: authorization.accountId,
        operationGeneration: authorization.generation,
        ackId: field(fact.ack, 'ackId'),
        consumer: contract.consumer,
        domainAggregateType: 'RawSourceRecord',
        domainAckKey: expectedDomainAckKey,
        domainRevision: expectedDomainRevision,
        resultDigest: attempt.receipt.resultDigest,
        resultSchema: contract.resultSchema,
        lineageSchema: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
        providerRecordCount: attempt.providerRecordCount,
        coveredItemCount: attempt.recordIndexes.length,
        contractSha256: DISCOVERY_QUERY_LINEAGE_CONTRACT_SHA256,
      }));
    }
    const resolutions = strictArray(field(input, 'resolutions'), 524_160);
    const rawReceipts = strictArray(field(input, 'rawReceipts'), 524_160).map((entry) => {
      const receipt = ownRecord(entry, RAW_RECEIPT_KEYS);
      const provider = providerKey(field(receipt, 'providerKey'));
      const recordIndex = field(receipt, 'recordIndex');
      const ingestStatus = field(receipt, 'ingestStatus');
      const materialization = field(receipt, 'materialization');
      if (
        !Number.isSafeInteger(recordIndex) || Number(recordIndex) < 0 ||
        (materialization !== 'INSERTED' && materialization !== 'EXISTING') ||
        !['ACCEPTED', 'QUARANTINED', 'REJECTED'].includes(String(ingestStatus))
      ) fail();
      return Object.freeze({
        providerKey: provider,
        recordIndex: Number(recordIndex), rawRecordId: text(field(receipt, 'rawRecordId'), UUID),
        payloadHash: text(field(receipt, 'payloadHash'), SHA256),
        ingestStatus: String(ingestStatus), materialization,
      });
    });
    const itemKey = (provider: string, index: number) => `${provider}\0${index}`;
    const receiptByIndex = new Map(rawReceipts.map((receipt) => [
      itemKey(receipt.providerKey, receipt.recordIndex), receipt,
    ]));
    if (receiptByIndex.size !== rawReceipts.length) fail(MISMATCH);
    const coverage = new Map<string, GovernedAttempt>();
    for (const attempt of plan.attempts) {
      for (const index of attempt.recordIndexes) {
        const key = itemKey(attempt.providerKey, index);
        if (coverage.has(key)) fail(MISMATCH);
        coverage.set(key, attempt);
      }
    }
    if (coverage.size !== resolutions.length) fail(MISMATCH);
    const itemByIndex = new Map<string, DataRecord>();
    for (const raw of resolutions) {
      if (!raw || typeof raw !== 'object' || types.isProxy(raw)) fail();
      const kindValue: unknown = Object.getOwnPropertyDescriptor(raw, 'kind')?.value;
      if (kindValue !== 'WRITE' && kindValue !== 'EXISTING' && kindValue !== 'REUSE_BATCH') fail();
      const kind = kindValue;
      const resolution = ownRecord(raw, RESOLUTION_KEYS[kind]);
      const resolutionProvider = providerKey(field(resolution, 'providerKey'));
      const recordIndex = field(resolution, 'recordIndex');
      const key = itemKey(resolutionProvider, Number(recordIndex));
      if (!Number.isSafeInteger(recordIndex) || Number(recordIndex) < 0 || itemByIndex.has(key)) fail();
      const index = Number(recordIndex);
      const attempt = coverage.get(key);
      if (!attempt) fail(MISMATCH);
      const rawReceipt = receiptByIndex.get(key);
      let rawRecordId: string;
      let resolutionKind: 'INSERTED' | 'EXISTING' | 'REUSE_BATCH';
      let rawPayloadHash: string;
      let rawIngestStatus: string;
      let sourceRecordIndex: number | null = null;
      if (kind === 'WRITE') {
        boundedDataRecord(field(resolution, 'row'));
        if (!rawReceipt) fail(MISMATCH);
        rawRecordId = rawReceipt.rawRecordId;
        rawPayloadHash = rawReceipt.payloadHash;
        rawIngestStatus = rawReceipt.ingestStatus;
        resolutionKind = rawReceipt.materialization;
      } else if (kind === 'EXISTING') {
        rawRecordId = text(field(resolution, 'rawRecordId'), UUID);
        if (
          !rawReceipt || rawReceipt.rawRecordId !== rawRecordId ||
          rawReceipt.materialization !== 'EXISTING'
        ) fail(MISMATCH);
        rawPayloadHash = rawReceipt.payloadHash;
        rawIngestStatus = rawReceipt.ingestStatus;
        resolutionKind = 'EXISTING';
      } else {
        const source = field(resolution, 'sourceRecordIndex');
        if (!Number.isSafeInteger(source) || Number(source) < 0 || Number(source) >= index) fail();
        sourceRecordIndex = Number(source);
        if (rawReceipt) fail(MISMATCH);
        const prior = itemByIndex.get(itemKey(resolutionProvider, sourceRecordIndex));
        if (!prior || prior.providerKey !== resolutionProvider) fail();
        rawRecordId = String(prior.rawRecordId);
        rawPayloadHash = String(prior.rawPayloadHash);
        rawIngestStatus = String(prior.rawIngestStatus);
        resolutionKind = 'REUSE_BATCH';
      }
      const fact = factByOperation.get(attempt.receipt.operationId)!;
      const itemId = deterministicUuid(`${(lookup as DataRecord).queryKey}:${attempt.providerKey}:${index}`);
      itemByIndex.set(key, Object.freeze({
        id: itemId,
        providerKey: attempt.providerKey,
        operationId: attempt.receipt.operationId,
        recordIndex: index,
        resolutionKind,
        sourceRecordIndex,
        rawRecordId,
        rawPayloadHash,
        rawIngestStatus,
        relationKey: `discovery.raw_source_record:${index}`,
        sourceRefNamespace: 'discovery_query_attempt_item',
        sourceRefUuid: itemId,
        ackId: field(fact.ack, 'ackId'),
        contractSha256: DISCOVERY_QUERY_RAW_RELATION_SHA256,
      }));
    }
    if (rawReceipts.some((receipt) => !itemByIndex.has(
      itemKey(receipt.providerKey, receipt.recordIndex),
    ))) fail(MISMATCH);
    const items = Object.freeze([...itemByIndex.values()].sort((left, right) =>
      String(left.providerKey).localeCompare(String(right.providerKey)) ||
      Number(left.recordIndex) - Number(right.recordIndex)));
    const accepted = items.filter((item) =>
      item.resolutionKind === 'INSERTED' && item.rawIngestStatus === 'ACCEPTED').length;
    const quarantined = items.filter((item) =>
      item.resolutionKind === 'INSERTED' && item.rawIngestStatus === 'QUARANTINED').length;
    const rejected = items.filter((item) =>
      item.resolutionKind === 'INSERTED' && item.rawIngestStatus === 'REJECTED').length;
    const duplicate = items.length - accepted - quarantined - rejected;
    const queryReceipt = parseDiscoveryQueryReceipt({
      schemaVersion: 'discovery-query-receipt/v1',
      queryKey: (lookup as DataRecord).queryKey,
      queryOrdinal: (lookup as DataRecord).queryOrdinal,
      sourceClass: (lookup as DataRecord).sourceClass,
      providers: plan.providers,
      accepted,
      quarantined,
      rejected,
      governanceDenied: quarantined + rejected,
      duplicate,
      usageQuantity: accepted,
      costCents: plan.costCents,
    });
    return Object.freeze({
      schemaVersion: DISCOVERY_QUERY_LINEAGE_COMMAND_V2,
      contractSha256: DISCOVERY_QUERY_LINEAGE_CONTRACT_SHA256,
      lookup,
      queryReceipt,
      queryReceiptContractSha256: DISCOVERY_QUERY_LINEAGE_CONTRACT_SHA256,
      rawRelationContractSha256: DISCOVERY_QUERY_RAW_RELATION_SHA256,
      budgetTruncated,
      attempts: Object.freeze(attemptCommands),
      items,
      authorization: Object.freeze({
        accountId: authorization.accountId,
        authorityId: authorization.authorityId,
        generation: authorization.generation,
      }),
    });
  } catch (error) {
    if (isControl(error, INVALID) || isControl(error, MISMATCH)) throw error;
    return fail();
  }
}
