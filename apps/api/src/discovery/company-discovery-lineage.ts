import { types } from 'node:util';
import {
  parseDurableExecutionReceipt,
  type DurableExecutionReceipt,
} from '../durable-results/durable-execution-receipt';

export const DISCOVERY_COMPANY_LINEAGE_INVALID =
  'DISCOVERY_COMPANY_LINEAGE_INVALID' as const;
export const DISCOVERY_COMPANY_RESULT_LINEAGE_V1 =
  'discovery-company-result-lineage/v1' as const;

export type DiscoveryCompanyLineageProviderKey =
  | 'trade_fair'
  | 'public_web'
  | 'directory';

export type DiscoveryCompanyReceiptAttemptV1 = Readonly<{
  producerId: string;
  receipt: DurableExecutionReceipt;
}>;

export type DiscoveryCompanyReceiptCoverageV1 =
  DiscoveryCompanyReceiptAttemptV1 & Readonly<{
    recordIndexes: readonly number[];
  }>;

export type DiscoveryCompanyResultLineageV1 = Readonly<{
  schemaVersion: typeof DISCOVERY_COMPANY_RESULT_LINEAGE_V1;
  recordCount: number;
  attemptReceipts: readonly DiscoveryCompanyReceiptAttemptV1[];
  receiptCoverage: readonly DiscoveryCompanyReceiptCoverageV1[];
}>;

export type DiscoveryCompanyReceiptObservation = Readonly<{
  producerId: string;
  invoked: boolean;
  receipt: DurableExecutionReceipt | null;
  recordIndexes: readonly number[];
}>;

export type DiscoveryCompanyReceiptCollector = Readonly<{
  markExpectedInvocation: () => void;
  onDurableReceipt: (
    producerId: string,
    receipt: DurableExecutionReceipt,
  ) => void;
  finish: (recordIndexes: readonly number[]) => DiscoveryCompanyReceiptObservation;
}>;

const LINEAGE_KEYS = Object.freeze([
  'schemaVersion',
  'recordCount',
  'attemptReceipts',
  'receiptCoverage',
] as const);
const ATTEMPT_KEYS = Object.freeze(['producerId', 'receipt'] as const);
const COVERAGE_KEYS = Object.freeze([
  'producerId',
  'receipt',
  'recordIndexes',
] as const);
const OBSERVATION_KEYS = Object.freeze([
  'producerId',
  'invoked',
  'receipt',
  'recordIndexes',
] as const);
const PROVIDER_PRODUCER = Object.freeze({
  trade_fair: 'tradefair.algolia',
  public_web: 'discovery.extract_company',
  directory: 'discovery.extract_list',
} satisfies Record<DiscoveryCompanyLineageProviderKey, string>);

type DataRecord = Record<string, unknown>;

type CollectorState = Readonly<
  | { phase: 'idle' }
  | { phase: 'invoked' }
  | { phase: 'settled'; receipt: DurableExecutionReceipt }
  | { phase: 'invalid' }
>;

function invalid(): never {
  throw new Error(DISCOVERY_COMPANY_LINEAGE_INVALID);
}

export function isDiscoveryCompanyLineageInvalid(error: unknown): boolean {
  return error instanceof Error && error.message === DISCOVERY_COMPANY_LINEAGE_INVALID;
}

function ownDataRecord(value: unknown, keys: readonly string[]): DataRecord {
  try {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      types.isProxy(value)
    ) {
      invalid();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
      keys.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
      })
    ) {
      invalid();
    }
    return value as DataRecord;
  } catch (error) {
    if (isDiscoveryCompanyLineageInvalid(error)) throw error;
    return invalid();
  }
}

function field(record: DataRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function strictArray(value: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(value) || types.isProxy(value)) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      !lengthDescriptor ||
      !Object.hasOwn(lengthDescriptor, 'value') ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      invalid();
    }
    const length = lengthDescriptor.value as number;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== length + 1) invalid();
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  } catch (error) {
    if (isDiscoveryCompanyLineageInvalid(error)) throw error;
    return invalid();
  }
}

function providerKey(value: unknown): DiscoveryCompanyLineageProviderKey {
  if (
    value !== 'trade_fair' &&
    value !== 'public_web' &&
    value !== 'directory'
  ) {
    invalid();
  }
  return value;
}

function expectedProducer(
  provider: DiscoveryCompanyLineageProviderKey,
  value: unknown,
): string {
  if (value !== PROVIDER_PRODUCER[provider]) invalid();
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function parseRecordIndexes(value: unknown, allowEmpty: boolean): readonly number[] {
  const values = strictArray(value);
  if (!allowEmpty && values.length === 0) invalid();
  const indexes = values.map(nonNegativeInteger);
  for (let index = 1; index < indexes.length; index += 1) {
    if (indexes[index]! <= indexes[index - 1]!) invalid();
  }
  return Object.freeze(indexes);
}

function parseAttempt(
  value: unknown,
  provider: DiscoveryCompanyLineageProviderKey,
): DiscoveryCompanyReceiptAttemptV1 {
  const record = ownDataRecord(value, ATTEMPT_KEYS);
  return Object.freeze({
    producerId: expectedProducer(provider, field(record, 'producerId')),
    receipt: parseDurableExecutionReceipt(field(record, 'receipt')),
  });
}

function parseCoverage(
  value: unknown,
  provider: DiscoveryCompanyLineageProviderKey,
): DiscoveryCompanyReceiptCoverageV1 {
  const record = ownDataRecord(value, COVERAGE_KEYS);
  return Object.freeze({
    producerId: expectedProducer(provider, field(record, 'producerId')),
    receipt: parseDurableExecutionReceipt(field(record, 'receipt')),
    recordIndexes: parseRecordIndexes(field(record, 'recordIndexes'), false),
  });
}

function parseObservation(
  value: unknown,
  provider: DiscoveryCompanyLineageProviderKey,
): DiscoveryCompanyReceiptObservation {
  const record = ownDataRecord(value, OBSERVATION_KEYS);
  const invoked = field(record, 'invoked');
  if (typeof invoked !== 'boolean') invalid();
  const rawReceipt = field(record, 'receipt');
  const recordIndexes = parseRecordIndexes(field(record, 'recordIndexes'), true);
  if (!invoked && (rawReceipt !== null || recordIndexes.length > 0)) invalid();
  return Object.freeze({
    producerId: expectedProducer(provider, field(record, 'producerId')),
    invoked,
    receipt:
      rawReceipt === null ? null : parseDurableExecutionReceipt(rawReceipt),
    recordIndexes,
  });
}

export function parseDiscoveryCompanyResultLineage(
  value: unknown,
  expectedProviderKey: unknown,
): DiscoveryCompanyResultLineageV1 {
  try {
    const provider = providerKey(expectedProviderKey);
    const record = ownDataRecord(value, LINEAGE_KEYS);
    if (field(record, 'schemaVersion') !== DISCOVERY_COMPANY_RESULT_LINEAGE_V1) {
      invalid();
    }
    const recordCount = nonNegativeInteger(field(record, 'recordCount'));
    const attemptReceipts = Object.freeze(
      strictArray(field(record, 'attemptReceipts')).map((entry) =>
        parseAttempt(entry, provider),
      ),
    );
    const receiptCoverage = Object.freeze(
      strictArray(field(record, 'receiptCoverage')).map((entry) =>
        parseCoverage(entry, provider),
      ),
    );

    const operationIds = new Set<string>();
    for (const entry of [...attemptReceipts, ...receiptCoverage]) {
      if (operationIds.has(entry.receipt.operationId)) invalid();
      operationIds.add(entry.receipt.operationId);
    }
    const covered = new Set<number>();
    for (const entry of receiptCoverage) {
      for (const index of entry.recordIndexes) {
        if (index >= recordCount || covered.has(index)) invalid();
        covered.add(index);
      }
    }
    if (covered.size !== recordCount) invalid();

    return Object.freeze({
      schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
      recordCount,
      attemptReceipts,
      receiptCoverage,
    });
  } catch (error) {
    if (isDiscoveryCompanyLineageInvalid(error)) throw error;
    return invalid();
  }
}

export function createDiscoveryCompanyReceiptCollector(input: Readonly<{
  providerKey: DiscoveryCompanyLineageProviderKey;
  producerId: string;
  parentOnDurableReceipt?: (
    producerId: string,
    receipt: DurableExecutionReceipt,
  ) => void;
}>): DiscoveryCompanyReceiptCollector {
  const provider = providerKey(input.providerKey);
  const producerId = expectedProducer(provider, input.producerId);
  const parent = input.parentOnDurableReceipt;
  if (parent !== undefined && typeof parent !== 'function') invalid();
  let state: CollectorState = Object.freeze({ phase: 'idle' });

  const fail = (): never => {
    state = Object.freeze({ phase: 'invalid' });
    return invalid();
  };

  return Object.freeze({
    markExpectedInvocation: () => {
      if (state.phase !== 'idle') fail();
      state = Object.freeze({ phase: 'invoked' });
    },
    onDurableReceipt: (actualProducerId, value) => {
      if (state.phase !== 'invoked' || actualProducerId !== producerId) fail();
      let receipt: DurableExecutionReceipt;
      try {
        receipt = parseDurableExecutionReceipt(value);
      } catch {
        return fail();
      }
      parent?.(actualProducerId, value);
      state = Object.freeze({ phase: 'settled', receipt });
    },
    finish: (value) => {
      if (state.phase === 'invalid') invalid();
      const recordIndexes = parseRecordIndexes(value, true);
      if (state.phase === 'idle' && recordIndexes.length > 0) invalid();
      return Object.freeze({
        producerId,
        invoked: state.phase !== 'idle',
        receipt: state.phase === 'settled' ? state.receipt : null,
        recordIndexes,
      });
    },
  });
}

export function buildDiscoveryCompanyResultLineage(input: Readonly<{
  providerKey: DiscoveryCompanyLineageProviderKey;
  recordCount: number;
  observations: readonly DiscoveryCompanyReceiptObservation[];
}>): DiscoveryCompanyResultLineageV1 | undefined {
  const provider = providerKey(input.providerKey);
  const recordCount = nonNegativeInteger(input.recordCount);
  const observations = Object.freeze(
    strictArray(input.observations).map((observation) =>
      parseObservation(observation, provider),
    ),
  );
  if (observations.some((observation) => observation.invoked && !observation.receipt)) {
    return undefined;
  }
  const settled = observations.filter(
    (observation): observation is DiscoveryCompanyReceiptObservation & {
      receipt: DurableExecutionReceipt;
    } => observation.invoked && observation.receipt !== null,
  );
  const raw = {
    schemaVersion: DISCOVERY_COMPANY_RESULT_LINEAGE_V1,
    recordCount,
    attemptReceipts: settled
      .filter((observation) => observation.recordIndexes.length === 0)
      .map((observation) => ({
        producerId: observation.producerId,
        receipt: observation.receipt,
      })),
    receiptCoverage: settled
      .filter((observation) => observation.recordIndexes.length > 0)
      .map((observation) => ({
        producerId: observation.producerId,
        receipt: observation.receipt,
        recordIndexes: observation.recordIndexes,
      })),
  };
  return parseDiscoveryCompanyResultLineage(raw, provider);
}
