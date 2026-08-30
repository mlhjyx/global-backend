import { types } from 'node:util';
import { Prisma } from '@prisma/client';
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import type { PrismaService } from '../prisma/prisma.service';
import { companyIdentity } from '../discovery/identity';
import type { PrecomputedCompanySuppressionDecision } from '../discovery/company-suppression-gate';
import {
  buildDiscoveryCompanyMaterializationBatchPlanV1,
  compareDiscoveryCompanyMaterializationItems,
  DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_SHA256,
} from '../discovery/discovery-company-materialization-ctx';
import {
  parseExecutionBudgetBinding,
  type ExecutionBudgetBinding,
} from '../execution-budget/execution-budget-binding';
import { materializeDiscoveryCompanyCanonicalCandidate } from './discovery-company-materialization-canonical';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const STABLE_FAILURES = new Set([
  'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID', 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_CONFLICT',
  'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_UNAVAILABLE', 'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD',
  'DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT',
]);
type Data = Readonly<Record<string, unknown>>;
type Transaction = Prisma.TransactionClient;
export type DiscoveryCompanyMaterializationInput = Readonly<{ workspaceId: string; runId: string; executionContractVersion?: 2; executionBudget?: ExecutionBudgetBinding }>;
type Admission = Readonly<{ admissionId: string; mode: 'LEGACY' | 'GOVERNED_C_TX' }>;
type NextWork =
  | Readonly<{ kind: 'BATCH'; queryKey: string; queryOrdinal: number; batchOrdinal: number }> |
  Readonly<{ kind: 'FINALIZE_QUERY'; queryKey: string; queryOrdinal: number }> | Readonly<{ kind: 'FINALIZE_RUN' }>;
type Inspection =
  | Readonly<{ status: 'REPLAYED'; runReceipt: Readonly<{ summary: Readonly<{
      companies: number; suppressed: number }> }> }> | Readonly<{ status: 'NOT_FOUND' | 'PARTIAL_RESUMABLE'; nextWork: NextWork }>;
export type LockedDiscoveryCompanyMaterializationBatchFacts = Readonly<{ queryOrdinal: number;
  batchOrdinal: number; fenceId: string; snapshotSha256: string; facts: readonly unknown[] }>;
export type DiscoveryCompanyMaterializationAppendCommand = Readonly<{
  schemaVersion: 'discovery-company-materialization-append/v1'; workspaceId: string; admissionId: string;
  runId: string; queryKey: string; batchOrdinal: number; fenceId: string; snapshotSha256: string;
  firstItemKey: string; lastItemKey: string; itemSetSha256: string;
  suppressionSnapshotCount: number; suppressionSnapshotSha256: string; items: readonly Data[];
}>;
export type DiscoveryCompanyMaterializationDependencies = Readonly<{
  prisma: PrismaService;
  canonicalizeLegacyDiscoveryRun: (input: DiscoveryCompanyMaterializationInput) => Promise<{ companies: number; suppressed: number }>;
  resolveSuppressionMatches: (transaction: Transaction,
    expectation: Readonly<{ workspaceId: string; count: number; sha256: string }>, companies: readonly Readonly<{
      key: string; name: string; domain?: string }>[]) => Promise<ReadonlyMap<string, readonly string[]>>;
}>;
function fail(code: string): never {
  throw ApplicationFailure.nonRetryable(code, code);
}
function record(value: unknown, keys: readonly string[]): Data {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
    ) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Object.values(descriptors).some(
        (descriptor) => descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value'),
      )
    ) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    return Object.freeze(value as Record<string, unknown>);
  } catch (error) {
    if (error instanceof ApplicationFailure) throw error;
    return fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  }
}
function field(value: Data, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
function text(value: unknown, pattern: RegExp): string {
  if (
    typeof value !== 'string' ||
    value.length > 1_024 ||
    value.normalize('NFC') !== value ||
    !pattern.test(value)
  ) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  return value;
}
function uuid(value: unknown): string {
  return text(value, UUID);
}
function sha256(value: unknown): string {
  return text(value, SHA256);
}
function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  }
  return Number(value);
}
function oneRow(value: unknown, keys: readonly string[]): Data {
  if (!Array.isArray(value) || types.isProxy(value) || value.length !== 1) {
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  }
  return record(value[0], keys);
}
function frozenJson(value: unknown, depth = 0): unknown {
  if (depth > 20) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    return value;
  }
  if (Array.isArray(value)) {
    if (types.isProxy(value) || value.length > 128) {
      fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    }
    return Object.freeze(value.map((item) => frozenJson(item, depth + 1)));
  }
  if (value === null || typeof value !== 'object' || types.isProxy(value)) {
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  }
  const keys = Reflect.ownKeys(value);
  if (Object.getPrototypeOf(value) !== Object.prototype || keys.length > 128) {
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  }
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== 'string') fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) {
      fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    }
    result[key] = frozenJson(descriptor.value, depth + 1);
  }
  return Object.freeze(result);
}
function trustedDatabaseMarker(error: unknown): string | null {
  try {
    if (types.isProxy(error) || !(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(error);
    const meta = descriptors.meta?.value;
    if (descriptors.code?.value !== 'P2010' || !meta || typeof meta !== 'object' || types.isProxy(meta)) {
      return null;
    }
    const metaDescriptors = Object.getOwnPropertyDescriptors(meta);
    if (metaDescriptors.code?.value !== 'P0001' && metaDescriptors.code?.value !== '42501') return null;
    const message = metaDescriptors.message?.value;
    if (typeof message !== 'string' || !message.startsWith('ERROR: ')) return null;
    const marker = message.slice('ERROR: '.length);
    return STABLE_FAILURES.has(marker) ? marker : null;
  } catch {
    return null;
  }
}
async function databaseCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const marker = trustedDatabaseMarker(error);
    if (marker) fail(marker);
    throw error;
  }
}
async function admitDiscoveryCompanyMaterialization(
  input: DiscoveryCompanyMaterializationInput,
  binding: ExecutionBudgetBinding,
  deps: DiscoveryCompanyMaterializationDependencies,
): Promise<Admission> {
  if (binding.scopeKey !== input.workspaceId) {
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  }
  return deps.prisma.withWorkspace(input.workspaceId, async (transaction) => {
    const rows = await databaseCall(() => transaction.$queryRaw<unknown[]>(
      Prisma.sql`SELECT * FROM public.admit_discovery_company_materialization_v1(
        ${JSON.stringify({ workspaceId: input.workspaceId, runId: input.runId })}::jsonb
      )`,
    ));
    const row = oneRow(rows, ['status', 'admission_id', 'mode']);
    const status = field(row, 'status');
    const mode = field(row, 'mode');
    if (!['APPLIED', 'REPLAYED'].includes(String(status)) || !['LEGACY', 'GOVERNED_C_TX'].includes(String(mode))) {
      fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    }
    return Object.freeze({ admissionId: uuid(field(row, 'admission_id')), mode }) as Admission;
  });
}
function parseNextWork(value: unknown): NextWork {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  }
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
  if (kind === 'FINALIZE_RUN') {
    record(value, ['kind']);
    return Object.freeze({ kind });
  }
  const row = record(
    value,
    kind === 'BATCH'
      ? ['kind', 'queryKey', 'queryOrdinal', 'batchOrdinal']
      : ['kind', 'queryKey', 'queryOrdinal'],
  );
  if (kind !== 'BATCH' && kind !== 'FINALIZE_QUERY') {
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  }
  const common = {
    kind,
    queryKey: sha256(field(row, 'queryKey')),
    queryOrdinal: count(field(row, 'queryOrdinal'), 1_023),
  } as const;
  return kind === 'BATCH'
    ? Object.freeze({ ...common, batchOrdinal: count(field(row, 'batchOrdinal'), 4_095) })
    : Object.freeze(common);
}
async function inspectDiscoveryCompanyMaterialization(
  input: DiscoveryCompanyMaterializationInput,
  admission: Admission,
  deps: DiscoveryCompanyMaterializationDependencies,
): Promise<Inspection> {
  return deps.prisma.withWorkspace(input.workspaceId, async (transaction) => {
    const rows = await databaseCall(() => transaction.$queryRaw<unknown[]>(
      Prisma.sql`SELECT * FROM public.inspect_discovery_company_materialization_v1(
        ${JSON.stringify({ workspaceId: input.workspaceId, admissionId: admission.admissionId, runId: input.runId })}::jsonb
      )`,
    ));
    const row = oneRow(rows, ['status', 'next_work', 'run_summary']);
    const status = field(row, 'status');
    if (status === 'REPLAYED') {
      if (field(row, 'next_work') !== null) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
      const summary = record(field(row, 'run_summary'), ['companies', 'suppressed']);
      return Object.freeze({
        status,
        runReceipt: Object.freeze({
          summary: Object.freeze({
            companies: count(field(summary, 'companies')),
            suppressed: count(field(summary, 'suppressed')),
          }),
        }),
      });
    }
    if (status !== 'NOT_FOUND' && status !== 'PARTIAL_RESUMABLE') {
      fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    }
    if (field(row, 'run_summary') !== null) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    return Object.freeze({ status, nextWork: parseNextWork(field(row, 'next_work')) });
  });
}
async function lockDiscoveryCompanyMaterializationBatchFacts(
  transaction: Transaction,
  input: DiscoveryCompanyMaterializationInput,
  admission: Admission,
  nextWork: Extract<NextWork, { kind: 'BATCH' }>,
): Promise<LockedDiscoveryCompanyMaterializationBatchFacts> {
  const identity = {
    workspaceId: input.workspaceId,
    admissionId: admission.admissionId,
    runId: input.runId,
    queryKey: nextWork.queryKey,
    batchOrdinal: nextWork.batchOrdinal,
  };
  const rows = await databaseCall(() => transaction.$queryRaw<unknown[]>(
    Prisma.sql`SELECT * FROM public.lock_discovery_company_materialization_batch_facts_v1(
      ${JSON.stringify(identity)}::jsonb
    )`,
  ));
  const row = oneRow(rows, ['status', 'fence_id', 'snapshot_sha256', 'facts']);
  if (field(row, 'status') !== 'APPLIED') fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  const facts = frozenJson(field(row, 'facts'));
  if (!Array.isArray(facts) || facts.length < 1 || facts.length > 128) {
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  }
  return Object.freeze({
    queryOrdinal: nextWork.queryOrdinal,
    batchOrdinal: nextWork.batchOrdinal,
    fenceId: uuid(field(row, 'fence_id')),
    snapshotSha256: sha256(field(row, 'snapshot_sha256')),
    facts,
  });
}
const FACT_CANDIDATE_KEYS = [
  'qItem', 'lockedFacts', 'exactExistingOutcome', 'reusableIdentity',
  'reusableManifestCandidates', 'companyParse', 'canonicalWrite',
] as const;
const Q_ITEM_KEYS = [
  'queryItemId', 'queryKey', 'queryOrdinal', 'providerKey', 'recordIndex',
  'operationId', 'rawRecordId', 'rawGovernedSubjectId', 'qRelationId', 'qIngestStatus',
] as const;
const LOCKED_FACT_KEYS = [
  'rawStatus', 'rawExpiredAt', 'restrictedDispositionId',
  'suppressionSnapshotCount', 'suppressionSnapshotSha256', 'product',
] as const;
const BUILDER_FACT_KEYS = [
  'rawStatus', 'rawExpiredAt', 'restrictedDispositionId', 'suppressionRecordIds', 'product',
] as const;
const REUSABLE_IDENTITY_KEYS = ['canonicalCompanyId', 'identityLinkId', 'identityCanonicalType',
  'canonicalGovernedSubjectId', 'cRelationId', 'cRelationKey', 'matchRule', 'confidence',
  'mutationClass', 'evidenceCount', 'evidenceManifestSha256'] as const;
function productRecord(value: unknown): Record<string, unknown> | null {
  const snapshot = frozenJson(value);
  return snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? (snapshot as Record<string, unknown>)
    : null;
}
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
 async function materializeLockedDiscoveryCompanyBatch(
  transaction: Transaction,
  input: DiscoveryCompanyMaterializationInput,
  admission: Admission,
  nextWork: Extract<NextWork, { kind: 'BATCH' }>,
  facts: LockedDiscoveryCompanyMaterializationBatchFacts,
  deps: DiscoveryCompanyMaterializationDependencies,
): Promise<DiscoveryCompanyMaterializationAppendCommand> {
  const rawCandidates = facts.facts.map((value) => record(value, FACT_CANDIDATE_KEYS))
    .sort((left, right) => {
      const key = (candidate: Data) => {
        const q = record(field(candidate, 'qItem'), Q_ITEM_KEYS);
        return { providerKey: text(field(q, 'providerKey'), /^[a-z][a-z0-9._-]{0,127}$/u), recordIndex:
          count(field(q, 'recordIndex'), 999_999), rawRecordId: uuid(field(q, 'rawRecordId')),
          queryItemId: uuid(field(q, 'queryItemId')) };
      };
      return compareDiscoveryCompanyMaterializationItems(key(left), key(right));
    });
  let snapshotCount: number | null = null;
  let snapshotSha256: string | null = null;
  const sourceInputs: Array<{ key: string; name: string; domain?: string }> = [];
  for (const candidate of rawCandidates) {
    const locked = record(field(candidate, 'lockedFacts'), LOCKED_FACT_KEYS);
    const candidateCount = count(field(locked, 'suppressionSnapshotCount'));
    const candidateSha = sha256(field(locked, 'suppressionSnapshotSha256'));
    if ((snapshotCount !== null && snapshotCount !== candidateCount) ||
        (snapshotSha256 !== null && snapshotSha256 !== candidateSha))
      fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
    snapshotCount = candidateCount; snapshotSha256 = candidateSha;
    const product = productRecord(field(locked, 'product'));
    const name = product ? optionalText(product.name) : undefined;
    if (name) sourceInputs.push({ key: `source:${String(field(record(field(candidate, 'qItem'), Q_ITEM_KEYS), 'queryItemId'))}`,
      name, domain: optionalText(product?.domain) });
  }
  if (snapshotCount === null || snapshotSha256 === null || snapshotSha256 !== facts.snapshotSha256)
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
  const identityKeys = new Set<string>();
  const identities = new Map<string, Readonly<{ dedupeKey: string; reusableCanonicalId?: string }>>();
  for (const candidate of rawCandidates) {
    const qItem = record(field(candidate, 'qItem'), Q_ITEM_KEYS);
    const locked = record(field(candidate, 'lockedFacts'), LOCKED_FACT_KEYS);
    const key = String(field(qItem, 'queryItemId'));
    const reusableValue = field(candidate, 'reusableIdentity');
    if (reusableValue !== null) {
      const reusable = record(reusableValue, REUSABLE_IDENTITY_KEYS);
      const canonicalCompanyId = uuid(field(reusable, 'canonicalCompanyId'));
      const canonical = await transaction.canonicalCompany.findUnique({
        where: { id: canonicalCompanyId },
        select: { id: true, dedupeKey: true, name: true, domain: true, status: true },
      });
      if (!canonical || canonical.id !== canonicalCompanyId)
        fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
      identities.set(key, { dedupeKey: canonical.dedupeKey, reusableCanonicalId: canonicalCompanyId });
      identityKeys.add(canonical.dedupeKey); continue;
    }
    if (field(qItem, 'qIngestStatus') !== 'ACCEPTED' ||
        field(candidate, 'exactExistingOutcome') !== null ||
        field(locked, 'restrictedDispositionId') !== null ||
        field(locked, 'rawStatus') !== 'ACCEPTED') continue;
    const product = productRecord(field(locked, 'product'));
    const name = product ? optionalText(product.name) : undefined;
    if (!product || !name) continue;
    const rawIdentifier = product.identifier;
    if (rawIdentifier && (typeof rawIdentifier !== 'object' || Array.isArray(rawIdentifier))) continue;
    const identifier = rawIdentifier as { scheme?: unknown; value?: unknown } | undefined;
    if (identifier && (typeof identifier.scheme !== 'string' || typeof identifier.value !== 'string')) continue;
    const identity = companyIdentity({ name, domain: optionalText(product.domain),
      country: optionalText(product.country), identifier: identifier as { scheme: string; value: string } });
    identities.set(key, identity); identityKeys.add(identity.dedupeKey);
  }
  for (const identityKey of [...identityKeys].sort()) {
    await transaction.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(
      ${`discovery-company-identity:${input.workspaceId}:${identityKey}`},0))`);
  }
  const canonicalByIdentity = new Map<string, Readonly<{
    id: string; dedupeKey: string; name: string; domain: string | null; status: string }> | null>();
  for (const identityKey of [...identityKeys].sort()) {
    canonicalByIdentity.set(identityKey, await transaction.canonicalCompany.findUnique({
      where: { workspaceId_dedupeKey: { workspaceId: input.workspaceId, dedupeKey: identityKey } },
      select: { id: true, dedupeKey: true, name: true, domain: true, status: true },
    }));
  }
  for (const identity of identities.values()) {
    const canonical = canonicalByIdentity.get(identity.dedupeKey);
    if (identity.reusableCanonicalId && canonical?.id !== identity.reusableCanonicalId)
      fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD');
  }
  const canonicalInputs = [...identities].flatMap(([key, identity]) => {
    const canonical = canonicalByIdentity.get(identity.dedupeKey);
    return canonical ? [{ key: `canonical:${key}`, name: canonical.name, domain: canonical.domain ?? undefined }] : [];
  });
  const matches = await deps.resolveSuppressionMatches(transaction,
    { workspaceId: input.workspaceId, count: snapshotCount, sha256: snapshotSha256 }, [...sourceInputs, ...canonicalInputs]);
  const decisions = new Map<string, PrecomputedCompanySuppressionDecision>();
  const candidates = rawCandidates.map((candidate) => {
    const locked = record(field(candidate, 'lockedFacts'), LOCKED_FACT_KEYS);
    const key = String(field(record(field(candidate, 'qItem'), Q_ITEM_KEYS), 'queryItemId'));
    const identity = identities.get(key); const canonical = identity ? canonicalByIdentity.get(identity.dedupeKey) : null;
    const sourceIds = matches.get(`source:${key}`) ?? [], canonicalIds = matches.get(`canonical:${key}`) ?? [];
    if (identity) decisions.set(key, Object.freeze({ canonicalCompanyId: canonical?.id ?? null,
      sourceMatched: sourceIds.length > 0, canonicalMatched: canonicalIds.length > 0,
      sourceSuppressionIds: sourceIds, canonicalSuppressionIds: canonicalIds }));
    const suppressionRecordIds = [...new Set([...sourceIds, ...canonicalIds])].sort();
    return Object.freeze({ ...candidate, lockedFacts: Object.freeze({
      rawStatus: field(locked, 'rawStatus'), rawExpiredAt: field(locked, 'rawExpiredAt'),
      restrictedDispositionId: field(locked, 'restrictedDispositionId'),
      suppressionRecordIds: Object.freeze(suppressionRecordIds), product: field(locked, 'product') }) });
  });
  const enriched: Data[] = [];
  for (const candidate of candidates) {
    const key = String(field(record(field(candidate, 'qItem'), Q_ITEM_KEYS), 'queryItemId'));
    let decision = decisions.get(key);
    const identity = identities.get(key);
    if (decision && decision.canonicalCompanyId === null && identity) {
      const current = await transaction.canonicalCompany.findUnique({
        where: { workspaceId_dedupeKey: { workspaceId: input.workspaceId, dedupeKey: identity.dedupeKey } },
        select: { id: true },
      });
      if (current) decision = Object.freeze({ ...decision, canonicalCompanyId: current.id });
    }
    const canonical = identity ? canonicalByIdentity.get(identity.dedupeKey) ?? undefined : undefined;
    enriched.push(await materializeDiscoveryCompanyCanonicalCandidate(
      transaction, input.workspaceId, candidate, decision, canonical,
    ));
  }
  const plan = buildDiscoveryCompanyMaterializationBatchPlanV1({
    schemaVersion: 'discovery-company-materialization-builder-input/v1',
    workspaceId: input.workspaceId,
    admissionId: admission.admissionId,
    runId: input.runId,
    queryKey: nextWork.queryKey,
    batchOrdinal: nextWork.batchOrdinal,
    contractSha256: DISCOVERY_COMPANY_MATERIALIZATION_CONTRACT_SHA256,
    items: enriched,
  });
  if (!plan.firstItemKey || !plan.lastItemKey) {
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  }
  return Object.freeze({
    schemaVersion: 'discovery-company-materialization-append/v1',
    workspaceId: input.workspaceId,
    admissionId: admission.admissionId,
    runId: input.runId,
    queryKey: nextWork.queryKey,
    batchOrdinal: nextWork.batchOrdinal,
    fenceId: facts.fenceId,
    snapshotSha256: facts.snapshotSha256,
    firstItemKey: plan.firstItemKey,
    lastItemKey: plan.lastItemKey,
    itemSetSha256: plan.itemSetSha256,
    suppressionSnapshotCount: snapshotCount,
    suppressionSnapshotSha256: snapshotSha256,
    items: plan.items.map((item) => {
      const source = candidates.find((candidate) =>
        field(record(field(candidate, 'qItem'), Q_ITEM_KEYS), 'queryItemId') === item.queryItemId);
      if (!source) fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
      const locked = record(field(source, 'lockedFacts'), BUILDER_FACT_KEYS);
      return Object.freeze({ ...item, suppressionRecordIds: field(locked, 'suppressionRecordIds') });
    }),
  });
}
async function appendDiscoveryCompanyMaterializationBatch(
  transaction: Transaction,
  command: DiscoveryCompanyMaterializationAppendCommand,
): Promise<void> {
  const rows = await databaseCall(() => transaction.$queryRaw<unknown[]>(
    Prisma.sql`SELECT * FROM public.append_discovery_company_materialization_batch_v1(
      ${JSON.stringify(command)}::jsonb
    )`,
  ));
  const row = oneRow(rows, ['status', 'batch_ordinal']);
  if (!['APPLIED', 'REPLAYED'].includes(String(field(row, 'status'))) ||
      count(field(row, 'batch_ordinal'), 4_095) !== command.batchOrdinal) {
    fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
  }
}
async function commitDiscoveryCompanyMaterializationQuery(
  nextWork: Extract<NextWork, { kind: 'FINALIZE_QUERY' }>,
  input: DiscoveryCompanyMaterializationInput,
  admission: Admission,
  deps: DiscoveryCompanyMaterializationDependencies,
): Promise<void> {
  await deps.prisma.withWorkspace(input.workspaceId, async (transaction) => {
    const identity = {
      workspaceId: input.workspaceId,
      admissionId: admission.admissionId,
      runId: input.runId,
      queryKey: nextWork.queryKey,
      batchOrdinal: 0,
    };
    const rows = await databaseCall(() => transaction.$queryRaw<unknown[]>(
      Prisma.sql`SELECT * FROM public.finalize_discovery_company_materialization_query_v1(
        ${JSON.stringify(identity)}::jsonb
      )`,
    ));
    const row = oneRow(rows, ['status', 'query_key']);
    if (!['APPLIED', 'REPLAYED'].includes(String(field(row, 'status'))) ||
        sha256(field(row, 'query_key')) !== nextWork.queryKey) {
      fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    }
  });
}
async function finalizeDiscoveryCompanyMaterializationRun(
  input: DiscoveryCompanyMaterializationInput,
  admission: Admission,
  deps: DiscoveryCompanyMaterializationDependencies,
): Promise<{ companies: number; suppressed: number }> {
  return deps.prisma.withWorkspace(input.workspaceId, async (transaction) => {
    const rows = await databaseCall(() => transaction.$queryRaw<unknown[]>(
      Prisma.sql`SELECT * FROM public.finalize_discovery_company_materialization_run_v1(
        ${JSON.stringify({ workspaceId: input.workspaceId, admissionId: admission.admissionId, runId: input.runId })}::jsonb
      )`,
    ));
    const row = oneRow(rows, ['status', 'companies', 'suppressed']);
    if (!['APPLIED', 'REPLAYED'].includes(String(field(row, 'status')))) {
      fail('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID');
    }
    return Object.freeze({
      companies: count(field(row, 'companies')),
      suppressed: count(field(row, 'suppressed')),
    });
  });
}
function replayDiscoveryCompanyMaterializationRunReceipt(
  runReceipt: Readonly<{ summary: Readonly<{ companies: number; suppressed: number }> }>,
): Readonly<{ companies: number; suppressed: number }> {
  return runReceipt.summary;
}
function heartbeatDiscoveryCompanyMaterializationBatch(value: {
  queryOrdinal: number;
  batchOrdinal: number;
}): void {
  heartbeat(Object.freeze({
    stage: 'discovery-company-materialization',
    queryOrdinal: value.queryOrdinal,
    batchOrdinal: value.batchOrdinal,
  }));
}
export async function executeDiscoveryCompanyMaterialization(
  input: DiscoveryCompanyMaterializationInput,
  deps: DiscoveryCompanyMaterializationDependencies,
): Promise<{ companies: number; suppressed: number }> {
  const { canonicalizeLegacyDiscoveryRun } = deps;
  let binding: ExecutionBudgetBinding;
  try {
    if (input.executionContractVersion !== 2) throw new Error('invalid version');
    binding = parseExecutionBudgetBinding(input.executionBudget, {
      scopeKey: input.workspaceId,
      purpose: 'discovery.run',
      subjectType: 'discovery_run',
    });
  } catch {
    fail('EXECUTION_BUDGET_LEGACY_HISTORY_PARKED');
  }
  const admission = await admitDiscoveryCompanyMaterialization(input, binding, deps);
  const finalizeDiscoveryCompanyMaterializationQuery = (
    nextWork: Extract<NextWork, { kind: 'FINALIZE_QUERY' }>,
  ) => commitDiscoveryCompanyMaterializationQuery(nextWork, input, admission, deps);
  if (admission.mode === 'LEGACY') {
    return canonicalizeLegacyDiscoveryRun(input);
  }
  let inspection = await inspectDiscoveryCompanyMaterialization(input, admission, deps);
  while (true) {
    if (inspection.status === 'REPLAYED') {
      return replayDiscoveryCompanyMaterializationRunReceipt(inspection.runReceipt);
    }
    switch (inspection.nextWork.kind) {
      case 'BATCH': {
        const nextWork = inspection.nextWork;
        await deps.prisma.withWorkspace(input.workspaceId, async (transaction) => {
          const facts = await lockDiscoveryCompanyMaterializationBatchFacts(
            transaction,
            input,
            admission,
            nextWork,
          );
          const command = await materializeLockedDiscoveryCompanyBatch(
            transaction,
            input,
            admission,
            nextWork,
            facts,
            deps,
          );
          await appendDiscoveryCompanyMaterializationBatch(transaction, {
            ...command,
            fenceId: facts.fenceId,
            snapshotSha256: facts.snapshotSha256,
          });
          heartbeatDiscoveryCompanyMaterializationBatch({
            queryOrdinal: facts.queryOrdinal,
            batchOrdinal: facts.batchOrdinal,
          });
        });
        break;
      }
      case 'FINALIZE_QUERY':
        await finalizeDiscoveryCompanyMaterializationQuery(inspection.nextWork);
        break;
      case 'FINALIZE_RUN':
        return finalizeDiscoveryCompanyMaterializationRun(input, admission, deps);
    }
    inspection = await inspectDiscoveryCompanyMaterialization(input, admission, deps);
  }
}
