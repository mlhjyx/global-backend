import { Prisma } from '@prisma/client';
import { types } from 'node:util';
import { ExecutionControlError } from '../execution-budget/execution-control-error';
import { parseDiscoveryQueryReceipt } from './discovery-query-receipt';
import {
  DISCOVERY_QUERY_LINEAGE_CONTRACT_SHA256,
  DISCOVERY_QUERY_RAW_RELATION_SHA256,
} from './discovery-query-governed-lineage';

const INVALID = 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID';
const UNAVAILABLE = 'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_UNAVAILABLE';
const STABLE_DATABASE_ERRORS = Object.freeze([
  'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_INVALID',
  'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_CONFLICT',
  'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH',
  'DOMAIN_ACK_DISCOVERY_GOVERNED_LINEAGE_REPLAY_INTEGRITY_HOLD',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;
const KEY_FIELDS = Object.freeze([
  'schemaVersion', 'workspaceId', 'runId', 'planId', 'queryKey',
  'queryOrdinal', 'authorityId', 'accountKey', 'purpose', 'subjectType',
  'subjectId', 'requestSha256',
] as const);
const COMMAND_FIELDS = Object.freeze([
  'schemaVersion', 'contractSha256', 'lookup', 'queryReceipt',
  'queryReceiptContractSha256', 'rawRelationContractSha256', 'attempts',
  'items', 'authorization',
] as const);

type RecordValue = Record<string, unknown>;
export interface DiscoveryQueryLineageTransaction {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}
export type DiscoveryQueryLineageAppendResult = Readonly<{
  status: 'APPLIED'; attemptCount: number; itemCount: number; queryKey: string;
}>;
export type DiscoveryQueryLineageAttestResult = Readonly<{
  status: 'NOT_FOUND' | 'REPLAYED';
  queryReceipt: unknown;
  attemptCount: number;
  itemCount: number;
  replay: boolean;
}>;

function fail(code = INVALID): never {
  throw new ExecutionControlError(code);
}

function ownRecord(value: unknown, keys?: readonly string[]): RecordValue {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      (keys && (ownKeys.length !== keys.length || ownKeys.some(
        (key) => typeof key !== 'string' || !keys.includes(key)))) ||
      ownKeys.length > 128 || ownKeys.some((key) => typeof key !== 'string') ||
      Object.values(descriptors).some((descriptor) =>
        descriptor.enumerable !== true || !Object.hasOwn(descriptor, 'value'))
    ) fail();
    return value as RecordValue;
  } catch (error) {
    if (error instanceof ExecutionControlError && error.code === INVALID) throw error;
    return fail();
  }
}

function field(record: RecordValue, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function denseArray(value: unknown, maximum: number): readonly unknown[] {
  try {
    if (!Array.isArray(value) || types.isProxy(value)) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) fail();
    if (Reflect.ownKeys(value).length !== length + 1) fail();
    return Object.freeze(Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) fail();
      return descriptor.value;
    }));
  } catch (error) {
    if (error instanceof ExecutionControlError && error.code === INVALID) throw error;
    return fail();
  }
}

function stringField(record: RecordValue, key: string, pattern: RegExp): string {
  const value = field(record, key);
  if (typeof value !== 'string' || value.normalize('NFC') !== value || !pattern.test(value)) fail();
  return value;
}

function snapshotKey(value: unknown): Readonly<RecordValue> {
  const key = ownRecord(value, KEY_FIELDS);
  if (
    field(key, 'schemaVersion') !== 'discovery-query-lineage-lookup/v1' ||
    !Number.isSafeInteger(field(key, 'queryOrdinal')) ||
    Number(field(key, 'queryOrdinal')) < 0 || Number(field(key, 'queryOrdinal')) > 1_023 ||
    stringField(key, 'purpose', /^discovery\.run$/u) !== 'discovery.run' ||
    stringField(key, 'subjectType', /^discovery_run$/u) !== 'discovery_run'
  ) fail();
  for (const id of ['workspaceId', 'runId', 'planId', 'authorityId']) stringField(key, id, UUID);
  const queryKey = stringField(key, 'queryKey', SHA);
  const request = stringField(key, 'requestSha256', SHA);
  const subject = stringField(key, 'subjectId', /^request:[0-9a-f]{64}$/u);
  const accountKey = stringField(key, 'accountKey', /^.{1,200}$/u);
  if (
    subject !== `request:${request}` ||
    accountKey !== `discovery.run:discovery_run:${subject}:${request}`
  ) fail();
  return Object.freeze({
    schemaVersion: 'discovery-query-lineage-lookup/v1',
    workspaceId: field(key, 'workspaceId'), runId: field(key, 'runId'),
    planId: field(key, 'planId'), queryKey,
    queryOrdinal: field(key, 'queryOrdinal'), authorityId: field(key, 'authorityId'),
    accountKey, purpose: 'discovery.run', subjectType: 'discovery_run',
    subjectId: subject, requestSha256: request,
  });
}

function snapshotJson(value: unknown, state = { nodes: 0 }, depth = 0): unknown {
  state.nodes += 1;
  if (state.nodes > 100_000 || depth > 16) fail();
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail();
    return value;
  }
  if (typeof value !== 'object' || types.isProxy(value)) fail();
  if (Array.isArray(value)) return Object.freeze(denseArray(value, 524_160).map(
    (item) => snapshotJson(item, state, depth + 1)));
  const record = ownRecord(value);
  const result = Object.create(null) as RecordValue;
  for (const key of Object.keys(record).sort()) {
    Object.defineProperty(result, key, {
      enumerable: true, configurable: false, writable: false,
      value: snapshotJson(field(record, key), state, depth + 1),
    });
  }
  return Object.freeze(result);
}

function snapshotCommand(value: unknown): Readonly<RecordValue> {
  const command = ownRecord(value, COMMAND_FIELDS);
  if (field(command, 'schemaVersion') !== 'discovery-query-lineage-command/v1') fail();
  const lookupValue = field(command, 'lookup');
  const lookupRecord = ownRecord(lookupValue, [...KEY_FIELDS, 'sourceClass']);
  const lookup = snapshotKey(Object.fromEntries(KEY_FIELDS.map((key) => [key, field(lookupRecord, key)])));
  const sourceClass = stringField(lookupRecord, 'sourceClass', /^[a-z0-9][a-z0-9._-]{0,127}$/u);
  const queryReceipt = parseDiscoveryQueryReceipt(field(command, 'queryReceipt'));
  if (
    queryReceipt.queryKey !== lookup.queryKey ||
    queryReceipt.queryOrdinal !== lookup.queryOrdinal ||
    queryReceipt.sourceClass !== sourceClass
  ) fail();
  for (const digest of ['contractSha256', 'queryReceiptContractSha256', 'rawRelationContractSha256']) {
    stringField(command, digest, SHA);
  }
  if (
    field(command, 'contractSha256') !== DISCOVERY_QUERY_LINEAGE_CONTRACT_SHA256 ||
    field(command, 'queryReceiptContractSha256') !== DISCOVERY_QUERY_LINEAGE_CONTRACT_SHA256 ||
    field(command, 'rawRelationContractSha256') !== DISCOVERY_QUERY_RAW_RELATION_SHA256
  ) fail();
  denseArray(field(command, 'attempts'), 128).forEach((item) => ownRecord(item));
  const items = denseArray(field(command, 'items'), 524_160).map((item) => ownRecord(item));
  const itemKeys = new Set<string>();
  const indexes = new Map<string, number[]>();
  for (const item of items) {
    const provider = stringField(item, 'providerKey', /^[a-z][a-z0-9._-]{0,127}$/u);
    const index = field(item, 'recordIndex');
    if (!Number.isSafeInteger(index) || Number(index) < 0) fail();
    const composite = `${provider}\0${index}`;
    if (itemKeys.has(composite)) fail();
    itemKeys.add(composite);
    const values = indexes.get(provider) ?? [];
    values.push(Number(index));
    indexes.set(provider, values);
  }
  for (const values of indexes.values()) {
    values.sort((left, right) => left - right);
    if (values.some((index, position) => index !== position)) fail();
  }
  const accepted = items.filter((item) =>
    field(item, 'resolutionKind') === 'INSERTED' && field(item, 'rawIngestStatus') === 'ACCEPTED').length;
  const quarantined = items.filter((item) =>
    field(item, 'resolutionKind') === 'INSERTED' && field(item, 'rawIngestStatus') === 'QUARANTINED').length;
  const rejected = items.filter((item) =>
    field(item, 'resolutionKind') === 'INSERTED' && field(item, 'rawIngestStatus') === 'REJECTED').length;
  if (
    queryReceipt.accepted !== accepted || queryReceipt.quarantined !== quarantined ||
    queryReceipt.rejected !== rejected ||
    queryReceipt.duplicate !== items.length - accepted - quarantined - rejected
  ) fail();
  const authorization = ownRecord(field(command, 'authorization'), [
    'accountId', 'authorityId', 'generation',
  ]);
  stringField(authorization, 'accountId', UUID);
  stringField(authorization, 'authorityId', UUID);
  const generation = field(authorization, 'generation');
  if (!Number.isSafeInteger(generation) || Number(generation) < 1 || Number(generation) > 2_147_483_647) fail();
  return snapshotJson(command) as Readonly<RecordValue>;
}

function trustedMarker(error: unknown, marker: string): boolean {
  try {
    if (types.isProxy(error) || !(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
    const descriptors = Object.getOwnPropertyDescriptors(error);
    const meta = descriptors.meta?.value;
    if (descriptors.code?.value !== 'P2010' || !meta || typeof meta !== 'object' || types.isProxy(meta)) return false;
    const values = Object.getOwnPropertyDescriptors(meta);
    return values.code?.value === 'P0001' && values.message?.value === `ERROR: ${marker}`;
  } catch { return false; }
}

function mapError(error: unknown): never {
  for (const marker of STABLE_DATABASE_ERRORS) {
    if (trustedMarker(error, marker)) throw new ExecutionControlError(marker);
  }
  throw new ExecutionControlError(UNAVAILABLE);
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail();
  return Number(value);
}

export async function appendQueryLineageV1(
  transaction: DiscoveryQueryLineageTransaction,
  value: unknown,
): Promise<DiscoveryQueryLineageAppendResult> {
  const command = snapshotCommand(value);
  try {
    const rows = await transaction.$queryRaw<unknown[]>(
      Prisma.sql`SELECT * FROM public.append_discovery_query_lineage_v1(${JSON.stringify(command)}::jsonb)`,
    );
    if (!Array.isArray(rows) || rows.length !== 1) fail();
    const row = ownRecord(rows[0]);
    if (field(row, 'status') !== 'APPLIED') fail();
    const queryKey = stringField(row, 'query_key', SHA);
    if (queryKey !== field(ownRecord(field(command, 'lookup')), 'queryKey')) fail();
    const attemptCount = count(field(row, 'attempt_count'));
    const itemCount = count(field(row, 'item_count'));
    if (attemptCount > 128 || itemCount > 524_160) fail();
    return Object.freeze({
      status: 'APPLIED', attemptCount, itemCount, queryKey,
    });
  } catch (error) { return mapError(error); }
}

export async function attestQueryLineageV1(
  transaction: DiscoveryQueryLineageTransaction,
  value: unknown,
): Promise<DiscoveryQueryLineageAttestResult> {
  const key = snapshotKey(value);
  try {
    const rows = await transaction.$queryRaw<unknown[]>(
      Prisma.sql`SELECT * FROM public.attest_discovery_query_lineage_v1(${JSON.stringify(key)}::jsonb)`,
    );
    if (!Array.isArray(rows) || rows.length !== 1) fail();
    const row = ownRecord(rows[0]);
    const status = field(row, 'status');
    const replay = field(row, 'replay');
    if (
      (status !== 'NOT_FOUND' && status !== 'REPLAYED') ||
      typeof replay !== 'boolean' || replay !== (status === 'REPLAYED')
    ) fail();
    const attemptCount = count(field(row, 'attempt_count'));
    const itemCount = count(field(row, 'item_count'));
    if (attemptCount > 128 || itemCount > 524_160) fail();
    const rawReceipt = field(row, 'query_receipt');
    if (status === 'NOT_FOUND') {
      if (rawReceipt !== null || attemptCount !== 0 || itemCount !== 0) fail();
      return Object.freeze({ status, queryReceipt: null, attemptCount, itemCount, replay });
    }
    const receipt = parseDiscoveryQueryReceipt(rawReceipt);
    if (receipt.queryKey !== key.queryKey || receipt.queryOrdinal !== key.queryOrdinal) fail();
    return Object.freeze({
      status, queryReceipt: receipt, attemptCount, itemCount, replay,
    });
  } catch (error) { return mapError(error); }
}
