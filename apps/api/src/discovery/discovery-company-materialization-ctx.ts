import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { ExecutionControlError } from '../execution-budget/execution-control-error';

export const DISCOVERY_COMPANY_MATERIALIZATION_OUTCOMES = Object.freeze([
  'CANONICALIZED', 'RAW_QUARANTINED', 'RAW_REJECTED',
  'RESTRICTED_PROCESSING', 'SUPPRESSED', 'NOT_CANONICALIZABLE',
  'EXPIRED_BEFORE_CANONICALIZATION',
] as const);
export const DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_VERSION =
  'discovery-company-materialization/v1' as const;
export const DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_SHA256 =
  '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe' as const;

const INVALID = 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID';
const HOLD = 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const SAFE_KEY = /^[a-z][a-z0-9._-]{0,127}$/u;
const RELATION_KEY = /^[a-z][a-z0-9._:-]{0,199}$/u;
const BATCH_KEYS = Object.freeze([
  'schemaVersion', 'workspaceId', 'admissionId', 'runId', 'queryKey',
  'batchOrdinal', 'contractSha256', 'items',
]);
const CANDIDATE_KEYS = Object.freeze([
  'qItem', 'lockedFacts', 'exactExistingOutcome', 'reusableIdentity',
  'reusableManifestCandidates', 'companyParse', 'canonicalWrite',
]);
const Q_KEYS = Object.freeze([
  'queryItemId', 'queryKey', 'queryOrdinal', 'providerKey', 'recordIndex',
  'operationId', 'rawRecordId', 'rawGovernedSubjectId', 'qRelationId', 'qIngestStatus',
]);
const FACT_KEYS = Object.freeze([
  'rawStatus', 'rawExpiredAt', 'restrictedDispositionId',
  'suppressionRecordIds', 'product',
]);
const CANONICAL_KEYS = Object.freeze([
  'canonicalCompanyId', 'identityLinkId', 'identityCanonicalType',
  'canonicalGovernedSubjectId', 'cRelationId', 'cRelationKey', 'matchRule',
  'confidence', 'mutationClass', 'evidenceCount', 'evidenceManifestSha256',
]);
const MANIFEST_SHARED_KEYS = Object.freeze([
  'workspaceId', 'admissionId', 'runId', 'rawRecordId', 'identityLinkId',
  'canonicalCompanyId', 'contractSha256', 'evidenceCount',
  'evidenceManifestSha256', 'queryItemId', 'operationId', 'cRelationId',
  'cRelationKey', 'sourceRefUuid', 'recordIndex', 'coveringBatchReceipt',
]);
const OUTCOME_KEYS = Object.freeze([
  ...Q_KEYS, 'outcome', 'contractSha256',
  'canonicalCompanyId', 'identityLinkId', 'identityCanonicalType',
  'canonicalGovernedSubjectId', 'cRelationId', 'cRelationKey', 'matchRule',
  'confidence', 'mutationClass', 'evidenceCount', 'evidenceManifestSha256',
  'restrictedDispositionId', 'suppressionMatchSha256', 'suppressionMatchCount',
  'rawExpiredAt', 'notCanonicalizableReasonCode',
]);

type Data = Record<string, unknown>;
type Outcome = typeof DISCOVERY_COMPANY_MATERIALIZATION_OUTCOMES[number];
type SnapshotBudget = { remaining: number; bytes: number };

function fail(code = INVALID): never { throw new ExecutionControlError(code); }
function field(record: Data, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}
function record(value: unknown, keys: readonly string[]): Data {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) fail();
    if (Object.getPrototypeOf(value) !== Object.prototype) fail();
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
    ) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.values(descriptors).some((descriptor) =>
        descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value'))
    ) fail();
    return value as Data;
  } catch (error) {
    if (error instanceof ExecutionControlError) throw error;
    return fail();
  }
}
function array(value: unknown, maximum: number): readonly unknown[] {
  try {
    if (!Array.isArray(value) || types.isProxy(value)) fail();
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) fail();
    if (Reflect.ownKeys(value).length !== length + 1) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.freeze(Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) fail();
      return descriptor.value;
    }));
  } catch (error) {
    if (error instanceof ExecutionControlError) throw error;
    return fail();
  }
}
function text(value: unknown, pattern: RegExp): string {
  if (
    typeof value !== 'string' || value.length > 1_024 ||
    value.normalize('NFC') !== value || !pattern.test(value)
  ) fail();
  return value;
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) fail();
  return Number(value);
}
function canonicalTimestamp(value: unknown, code = INVALID): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) fail(code);
  return value;
}
function sha(value: unknown): string { return text(value, SHA); }
function uuid(value: unknown): string { return text(value, UUID); }
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function frozen<T extends Data>(value: T): Readonly<T> { return Object.freeze(value); }
function snapshotPlain(
  value: unknown,
  state: SnapshotBudget,
  depth = 0,
): unknown {
  state.remaining -= 1;
  if (depth > 12 || state.remaining < 0) fail();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    state.bytes += bytes;
    if (value.normalize('NFC') !== value || bytes > 1_048_576 || state.bytes > 4_194_304) fail();
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail();
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(
    array(value, 1_024).map((item) => snapshotPlain(item, state, depth + 1)),
  );
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length > 128) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Data = {};
  for (const key of ownKeys) {
    if (typeof key !== 'string') fail();
    const keyBytes = Buffer.byteLength(key, 'utf8');
    state.bytes += keyBytes;
    if (keyBytes > 1_048_576 || state.bytes > 4_194_304 || key.normalize('NFC') !== key) fail();
    const descriptor = descriptors[key];
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) fail();
    result[key] = snapshotPlain(descriptor.value, state, depth + 1);
  }
  return Object.freeze(result);
}

function parseQ(value: unknown): Readonly<Data> {
  const q = record(value, Q_KEYS);
  const status = field(q, 'qIngestStatus');
  if (!['ACCEPTED', 'QUARANTINED', 'REJECTED'].includes(String(status))) fail();
  return frozen({ queryItemId: uuid(field(q, 'queryItemId')), queryKey: sha(field(q, 'queryKey')),
    queryOrdinal: integer(field(q, 'queryOrdinal'), 0, 1_023), providerKey: text(field(q, 'providerKey'), SAFE_KEY),
    recordIndex: integer(field(q, 'recordIndex'), 0, 999_999), operationId: uuid(field(q, 'operationId')),
    rawRecordId: uuid(field(q, 'rawRecordId')), rawGovernedSubjectId: uuid(field(q, 'rawGovernedSubjectId')),
    qRelationId: uuid(field(q, 'qRelationId')), qIngestStatus: status });
}

function parseFacts(value: unknown, snapshotBudget: SnapshotBudget): Readonly<Data> {
  const facts = record(value, FACT_KEYS);
  const rawStatus = field(facts, 'rawStatus');
  if (rawStatus !== 'ACCEPTED' && rawStatus !== 'EXPIRED') fail();
  const expired = field(facts, 'rawExpiredAt');
  if (expired !== null) canonicalTimestamp(expired);
  if ((rawStatus === 'ACCEPTED') !== (expired === null)) fail();
  const disposition = field(facts, 'restrictedDispositionId');
  if (disposition !== null) uuid(disposition);
  const suppressions = array(field(facts, 'suppressionRecordIds'), 64).map(uuid);
  if (new Set(suppressions).size !== suppressions.length) fail();
  return frozen({ rawStatus, rawExpiredAt: expired, restrictedDispositionId: disposition,
    suppressionRecordIds: Object.freeze([...suppressions].sort()),
    product: snapshotPlain(field(facts, 'product'), snapshotBudget) });
}

function parseCanonical(
  value: unknown,
  aIdentity: 'new' | 'reuse' | 'persisted',
): Readonly<Data> {
  const item = record(value, CANONICAL_KEYS);
  const mutation = field(item, 'mutationClass');
  const rule = field(item, 'matchRule');
  const confidence = field(item, 'confidence');
  const evidenceCount = integer(field(item, 'evidenceCount'), 0, 1_000_000);
  if (!['CREATED', 'UPDATED', 'LINKED', 'REUSED'].includes(String(mutation)) ||
      !['domain_exact', 'identifier_exact', 'name_country'].includes(String(rule)) ||
      field(item, 'identityCanonicalType') !== 'company' ||
      typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail();
  const governedSubjectId = field(item, 'canonicalGovernedSubjectId');
  const relationId = field(item, 'cRelationId');
  if (aIdentity === 'persisted') {
    uuid(governedSubjectId); uuid(relationId);
  } else if (aIdentity === 'reuse') {
    uuid(governedSubjectId);
    if (relationId !== null) fail();
  } else if (governedSubjectId !== null || relationId !== null) fail();
  return frozen({ canonicalCompanyId: uuid(field(item, 'canonicalCompanyId')),
    identityLinkId: uuid(field(item, 'identityLinkId')), identityCanonicalType: 'company',
    canonicalGovernedSubjectId: governedSubjectId,
    cRelationId: relationId, cRelationKey: text(field(item, 'cRelationKey'), RELATION_KEY),
    matchRule: rule, confidence, mutationClass: mutation, evidenceCount,
    evidenceManifestSha256: sha(field(item, 'evidenceManifestSha256')) });
}

function terminalColumns(outcome: Outcome, facts: Readonly<Data>, reason: string | null): Data {
  const suppressionIds = field(facts, 'suppressionRecordIds') as readonly string[];
  return { canonicalCompanyId: null, identityLinkId: null, identityCanonicalType: null,
    canonicalGovernedSubjectId: null, cRelationId: null, cRelationKey: null,
    matchRule: null, confidence: null, mutationClass: null, evidenceCount: null,
    evidenceManifestSha256: null,
    restrictedDispositionId: outcome === 'RESTRICTED_PROCESSING' ? field(facts, 'restrictedDispositionId') : null,
    suppressionMatchSha256: outcome === 'SUPPRESSED' ? digest(suppressionIds) : null,
    suppressionMatchCount: outcome === 'SUPPRESSED' ? suppressionIds.length : null,
    rawExpiredAt: outcome === 'EXPIRED_BEFORE_CANONICALIZATION' ? field(facts, 'rawExpiredAt') : null,
    notCanonicalizableReasonCode: outcome === 'NOT_CANONICALIZABLE' ? reason : null };
}

function validateManifestCandidates(
  value: unknown,
  context: Data,
  expected: Readonly<Data> | null,
): number {
  const candidates = array(value, 128);
  for (const raw of candidates) {
    const candidate = record(raw, MANIFEST_SHARED_KEYS);
    const exact = field(candidate, 'workspaceId') === context.workspaceId &&
      field(candidate, 'admissionId') === context.admissionId && field(candidate, 'runId') === context.runId &&
      field(candidate, 'rawRecordId') === context.rawRecordId && field(candidate, 'contractSha256') === context.contractSha256 &&
      field(candidate, 'coveringBatchReceipt') === true && expected !== null &&
      field(candidate, 'identityLinkId') === expected.identityLinkId &&
      field(candidate, 'canonicalCompanyId') === expected.canonicalCompanyId &&
      field(candidate, 'evidenceCount') === expected.evidenceCount &&
      field(candidate, 'evidenceManifestSha256') === expected.evidenceManifestSha256;
    for (const key of ['workspaceId', 'admissionId', 'runId', 'rawRecordId', 'identityLinkId',
      'canonicalCompanyId', 'queryItemId', 'operationId', 'cRelationId', 'sourceRefUuid']) uuid(field(candidate, key));
    sha(field(candidate, 'contractSha256')); sha(field(candidate, 'evidenceManifestSha256'));
    integer(field(candidate, 'evidenceCount'), 0, 1_000_000);
    const priorRecordIndex = integer(field(candidate, 'recordIndex'), 0, 999_999);
    if (
      field(candidate, 'sourceRefUuid') !== field(candidate, 'queryItemId') ||
      field(candidate, 'cRelationKey') !== `discovery.canonical_company:${priorRecordIndex}`
    ) fail(HOLD);
    if (!exact) fail(HOLD);
  }
  return candidates.length;
}

function parseExistingOutcome(
  value: unknown,
  q: Readonly<Data>,
  contractSha256: unknown,
  snapshotBudget: SnapshotBudget,
): Readonly<Data> {
  const row = record(value, OUTCOME_KEYS);
  const outcome = field(row, 'outcome') as Outcome;
  if (!DISCOVERY_COMPANY_MATERIALIZATION_OUTCOMES.includes(outcome) ||
      field(row, 'contractSha256') !== contractSha256) fail(HOLD);
  for (const key of Q_KEYS) {
    if (field(row, key) !== q[key]) fail(HOLD);
  }
  if (
    (q.qIngestStatus === 'QUARANTINED' && outcome !== 'RAW_QUARANTINED') ||
    (q.qIngestStatus === 'REJECTED' && outcome !== 'RAW_REJECTED') ||
    (q.qIngestStatus === 'ACCEPTED' &&
      (outcome === 'RAW_QUARANTINED' || outcome === 'RAW_REJECTED'))
  ) fail(HOLD);
  const provenanceKeys = ['restrictedDispositionId', 'suppressionMatchSha256',
    'suppressionMatchCount', 'rawExpiredAt', 'notCanonicalizableReasonCode'];
  if (outcome === 'CANONICALIZED') {
    const canonical = parseCanonical(
      Object.fromEntries(CANONICAL_KEYS.map((key) => [key, field(row, key)])),
      'persisted',
    );
    if (canonical.cRelationKey !== `discovery.canonical_company:${q.recordIndex}`) fail(HOLD);
    if (provenanceKeys.some((key) => field(row, key) !== null)) fail(HOLD);
  } else {
    if (CANONICAL_KEYS.some((key) => field(row, key) !== null)) fail(HOLD);
    const required = outcome === 'RESTRICTED_PROCESSING' ? ['restrictedDispositionId']
      : outcome === 'SUPPRESSED' ? ['suppressionMatchSha256', 'suppressionMatchCount']
        : outcome === 'EXPIRED_BEFORE_CANONICALIZATION' ? ['rawExpiredAt']
          : outcome === 'NOT_CANONICALIZABLE' ? ['notCanonicalizableReasonCode'] : [];
    if (provenanceKeys.some((key) => required.includes(key)
      ? field(row, key) === null : field(row, key) !== null)) fail(HOLD);
    if (outcome === 'RESTRICTED_PROCESSING') uuid(field(row, 'restrictedDispositionId'));
    if (outcome === 'SUPPRESSED') {
      sha(field(row, 'suppressionMatchSha256'));
      integer(field(row, 'suppressionMatchCount'), 1, 64);
    }
    if (outcome === 'EXPIRED_BEFORE_CANONICALIZATION')
      canonicalTimestamp(field(row, 'rawExpiredAt'), HOLD);
    if (outcome === 'NOT_CANONICALIZABLE')
      text(field(row, 'notCanonicalizableReasonCode'), /^[A-Z][A-Z0-9_]{0,63}$/u);
  }
  return snapshotPlain(row, snapshotBudget) as Readonly<Data>;
}

function itemPlan(raw: unknown, context: Data, snapshotBudget: SnapshotBudget): Readonly<Data> {
  const source = record(raw, CANDIDATE_KEYS);
  const q = parseQ(field(source, 'qItem'));
  if (q.queryKey !== context.queryKey) fail();
  const existing = field(source, 'exactExistingOutcome');
  if (existing !== null)
    return parseExistingOutcome(existing, q, context.contractSha256, snapshotBudget);
  if (q.qIngestStatus === 'QUARANTINED' || q.qIngestStatus === 'REJECTED') {
    const outcome = q.qIngestStatus === 'QUARANTINED' ? 'RAW_QUARANTINED' : 'RAW_REJECTED';
    return frozen({ ...q, outcome, contractSha256: context.contractSha256,
      ...terminalColumns(outcome, { suppressionRecordIds: [] }, null) });
  }
  const facts = parseFacts(field(source, 'lockedFacts'), snapshotBudget);
  const reuseSource = field(source, 'reusableIdentity');
  const expectedReuse = reuseSource === null ? null : parseCanonical(reuseSource, 'reuse');
  const manifestCandidateCount = validateManifestCandidates(
    field(source, 'reusableManifestCandidates'), {
    ...context, rawRecordId: q.rawRecordId,
    }, expectedReuse,
  );
  let outcome: Outcome;
  let canonical: Readonly<Data> | null = null;
  let reason: string | null = null;
  if (facts.restrictedDispositionId !== null) outcome = 'RESTRICTED_PROCESSING';
  else if ((facts.suppressionRecordIds as readonly string[]).length > 0) outcome = 'SUPPRESSED';
  else if (
    field(source, 'reusableIdentity') !== null &&
    (facts.rawStatus !== 'EXPIRED' || manifestCandidateCount > 0)
  ) {
    outcome = 'CANONICALIZED'; canonical = parseCanonical(field(source, 'reusableIdentity'), 'reuse');
  } else if (facts.rawStatus === 'EXPIRED') outcome = 'EXPIRED_BEFORE_CANONICALIZATION';
  else {
    const rawParser = field(source, 'companyParse');
    const status = rawParser && typeof rawParser === 'object' && !types.isProxy(rawParser)
      ? Object.getOwnPropertyDescriptor(rawParser, 'status')?.value : null;
    const parser = record(rawParser, status === 'INVALID' ? ['status', 'reasonCode'] : ['status', 'dedupeKey']);
    if (field(parser, 'status') === 'INVALID') {
      outcome = 'NOT_CANONICALIZABLE'; reason = text(field(parser, 'reasonCode'), /^[A-Z][A-Z0-9_]{0,63}$/u);
    } else {
      if (field(parser, 'status') !== 'VALID') fail();
      text(field(parser, 'dedupeKey'), /^[a-z][a-z0-9._:-]{0,255}$/u);
      outcome = 'CANONICALIZED'; canonical = parseCanonical(field(source, 'canonicalWrite'), 'new');
    }
  }
  if (canonical && canonical.cRelationKey !== `discovery.canonical_company:${q.recordIndex}`) fail(HOLD);
  const base = { ...q, outcome, contractSha256: context.contractSha256 };
  return frozen(outcome === 'CANONICALIZED'
    ? { ...base, ...canonical, restrictedDispositionId: null, suppressionMatchSha256: null,
        suppressionMatchCount: null, rawExpiredAt: null, notCanonicalizableReasonCode: null }
    : { ...base, ...terminalColumns(outcome, facts, reason) });
}

export function buildDiscoveryCompanyMaterializationBatchPlanV1(value: unknown): Readonly<{
  schemaVersion: 'discovery-company-materialization-batch-plan/v1'; batchOrdinal: number;
  firstItemKey: string | null; lastItemKey: string | null; itemSetSha256: string;
  items: readonly Readonly<Data>[];
}> {
  const input = record(value, BATCH_KEYS);
  if (field(input, 'schemaVersion') !== 'discovery-company-materialization-builder-input/v1') fail();
  const contractSha256 = sha(field(input, 'contractSha256'));
  if (contractSha256 !== DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_SHA256) fail();
  const context = { workspaceId: uuid(field(input, 'workspaceId')), admissionId: uuid(field(input, 'admissionId')),
    runId: uuid(field(input, 'runId')), queryKey: sha(field(input, 'queryKey')),
    contractSha256 };
  const batchOrdinal = integer(field(input, 'batchOrdinal'), 0, 1_000_000);
  const rawCandidates = array(field(input, 'items'), 128);
  if (rawCandidates.length === 0) fail();
  const candidates = rawCandidates.map((candidate) => ({ candidate,
    q: parseQ(field(record(candidate, CANDIDATE_KEYS), 'qItem')) }));
  const ordinal = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const sorted = candidates.sort((left, right) =>
    ordinal(String(left.q.providerKey), String(right.q.providerKey)) ||
    Number(left.q.recordIndex) - Number(right.q.recordIndex) ||
    ordinal(String(left.q.rawRecordId), String(right.q.rawRecordId)) ||
    ordinal(String(left.q.queryItemId), String(right.q.queryItemId)));
  const queryItemIds = sorted.map(({ q }) => q.queryItemId);
  if (new Set(queryItemIds).size !== queryItemIds.length) fail();
  const keys = sorted.map(({ q }) => `${q.providerKey}:${q.recordIndex}:${q.rawRecordId}:${q.queryItemId}`);
  const snapshotBudget: SnapshotBudget = { remaining: 4_096, bytes: 0 };
  const items = Object.freeze(sorted.map(({ candidate }) => itemPlan(candidate, context, snapshotBudget)));
  return Object.freeze({ schemaVersion: 'discovery-company-materialization-batch-plan/v1', batchOrdinal,
    firstItemKey: keys[0] ?? null, lastItemKey: keys.at(-1) ?? null,
    itemSetSha256: digest(keys), items });
}
