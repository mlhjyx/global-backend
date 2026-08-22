import { types } from 'node:util';

export type DurableExecutionResultStrategy =
  | 'typed_projection'
  | 'artifact_reference';

export type DurableExecutionCostBasis =
  | 'provider_reported'
  | 'token_pricing'
  | 'estimated_upper_bound'
  | 'not_incurred';

export interface DurableExecutionUsageFacts {
  readonly currency: 'USD';
  readonly unit: 'microusd';
  readonly callCount?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly bytesProcessed?: string;
  readonly bytesBilled?: string;
  readonly maximumBytesBilled?: string;
  readonly chargedMicrousd?: string;
  readonly upperBoundMicrousd?: string;
}

export interface DurableExecutionReceipt {
  readonly schemaVersion: 'durable-execution-receipt/v1';
  readonly scopeKey: string;
  readonly authorityId: string;
  readonly accountId: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly resultStrategy: DurableExecutionResultStrategy;
  readonly resultSchema: string;
  readonly resultDigest: string;
  readonly artifactId: string | null;
  readonly usage: DurableExecutionUsageFacts;
  readonly costBasis: DurableExecutionCostBasis;
}

const RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'scopeKey',
  'authorityId',
  'accountId',
  'operationId',
  'operationKey',
  'resultStrategy',
  'resultSchema',
  'resultDigest',
  'artifactId',
  'usage',
  'costBasis',
] as const);

const USAGE_KEYS = Object.freeze([
  'currency',
  'unit',
  'callCount',
  'inputTokens',
  'outputTokens',
  'bytesProcessed',
  'bytesBilled',
  'maximumBytesBilled',
  'chargedMicrousd',
  'upperBoundMicrousd',
] as const);

const COST_BASIS: ReadonlySet<string> = new Set([
  'provider_reported',
  'token_pricing',
  'estimated_upper_bound',
  'not_incurred',
]);

const RESULT_STRATEGIES: ReadonlySet<string> = new Set([
  'typed_projection',
  'artifact_reference',
]);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const DECIMAL_STRING = /^(0|[1-9][0-9]{0,39})$/u;
const RESULT_SCHEMA = /^[a-z][a-z0-9-]{0,79}\/v[1-9][0-9]{0,3}$/u;
const SAFE_KEY = /^[A-Za-z0-9:._/-]{1,200}$/u;

/*
 * These names are deliberately present as data, not as allowed fields. The
 * parser rejects them through the closed top-level and usage key checks:
 * body, data, prompt, reasoning, rawResponse, responseBody, credential,
 * compactToken, email.
 */
const FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
  'body',
  'data',
  'prompt',
  'reasoning',
  'rawResponse',
  'responseBody',
  'credential',
  'compactToken',
  'email',
] as const);

type ReceiptRecord = Record<string, unknown>;

function invalid(): never {
  throw new Error('DURABLE_EXECUTION_RECEIPT_INVALID');
}

function ownDataRecord(
  value: unknown,
  keys: readonly string[],
): ReceiptRecord {
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
      ownKeys.some(
        (key) =>
          typeof key !== 'string' ||
          !keys.includes(key) ||
          FORBIDDEN_PAYLOAD_KEYS.includes(key as never),
      )
    ) {
      invalid();
    }
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
    }
    if (keys.some((key) => !Object.hasOwn(descriptors, key))) invalid();
    return value as ReceiptRecord;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'DURABLE_EXECUTION_RECEIPT_INVALID'
    ) {
      throw error;
    }
    invalid();
  }
}

function partialOwnDataRecord(
  value: unknown,
  keys: readonly string[],
  required: readonly string[],
): ReceiptRecord {
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
      ownKeys.some(
        (key) =>
          typeof key !== 'string' ||
          !keys.includes(key) ||
          FORBIDDEN_PAYLOAD_KEYS.includes(key as never),
      )
    ) {
      invalid();
    }
    for (const key of ownKeys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
    }
    if (required.some((key) => !Object.hasOwn(descriptors, key))) invalid();
    return value as ReceiptRecord;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'DURABLE_EXECUTION_RECEIPT_INVALID'
    ) {
      throw error;
    }
    invalid();
  }
}

function field(record: ReceiptRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function boundedString(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes('\0') ||
    value !== value.normalize('NFC')
  ) {
    invalid();
  }
  return value;
}

function uuid(value: unknown): string {
  const text = boundedString(value, 36);
  if (!UUID.test(text)) invalid();
  return text;
}

function safeKey(value: unknown): string {
  const text = boundedString(value, 200);
  if (!SAFE_KEY.test(text)) invalid();
  return text;
}

function schema(value: unknown): string {
  const text = boundedString(value, 100);
  if (!RESULT_SCHEMA.test(text)) invalid();
  return text;
}

function digest(value: unknown): string {
  const text = boundedString(value, 64);
  if (!DIGEST.test(text)) invalid();
  return text;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function decimalString(value: unknown): string {
  const text = boundedString(value, 40);
  if (!DECIMAL_STRING.test(text)) invalid();
  return text;
}

function parseUsage(value: unknown): DurableExecutionUsageFacts {
  const record = partialOwnDataRecord(value, USAGE_KEYS, ['currency', 'unit']);
  if (field(record, 'currency') !== 'USD' || field(record, 'unit') !== 'microusd') {
    invalid();
  }
  const usage: DurableExecutionUsageFacts = {
    currency: 'USD',
    unit: 'microusd',
    ...(Object.hasOwn(record, 'callCount')
      ? { callCount: nonNegativeInteger(field(record, 'callCount')) }
      : {}),
    ...(Object.hasOwn(record, 'inputTokens')
      ? { inputTokens: nonNegativeInteger(field(record, 'inputTokens')) }
      : {}),
    ...(Object.hasOwn(record, 'outputTokens')
      ? { outputTokens: nonNegativeInteger(field(record, 'outputTokens')) }
      : {}),
    ...(Object.hasOwn(record, 'bytesProcessed')
      ? { bytesProcessed: decimalString(field(record, 'bytesProcessed')) }
      : {}),
    ...(Object.hasOwn(record, 'bytesBilled')
      ? { bytesBilled: decimalString(field(record, 'bytesBilled')) }
      : {}),
    ...(Object.hasOwn(record, 'maximumBytesBilled')
      ? { maximumBytesBilled: decimalString(field(record, 'maximumBytesBilled')) }
      : {}),
    ...(Object.hasOwn(record, 'chargedMicrousd')
      ? { chargedMicrousd: decimalString(field(record, 'chargedMicrousd')) }
      : {}),
    ...(Object.hasOwn(record, 'upperBoundMicrousd')
      ? { upperBoundMicrousd: decimalString(field(record, 'upperBoundMicrousd')) }
      : {}),
  };
  return Object.freeze(usage);
}

export function parseDurableExecutionReceipt(
  value: unknown,
): DurableExecutionReceipt {
  const record = ownDataRecord(value, RECEIPT_KEYS);
  if (field(record, 'schemaVersion') !== 'durable-execution-receipt/v1') {
    invalid();
  }
  const resultStrategy = field(record, 'resultStrategy');
  if (
    typeof resultStrategy !== 'string' ||
    !RESULT_STRATEGIES.has(resultStrategy)
  ) {
    invalid();
  }
  const artifactId = field(record, 'artifactId');
  if (resultStrategy === 'typed_projection' && artifactId !== null) invalid();
  if (resultStrategy === 'artifact_reference' && artifactId === null) invalid();
  const costBasis = field(record, 'costBasis');
  if (typeof costBasis !== 'string' || !COST_BASIS.has(costBasis)) invalid();
  const parsedStrategy = resultStrategy as DurableExecutionResultStrategy;
  const parsedCostBasis = costBasis as DurableExecutionCostBasis;
  return Object.freeze({
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: safeKey(field(record, 'scopeKey')),
    authorityId: uuid(field(record, 'authorityId')),
    accountId: uuid(field(record, 'accountId')),
    operationId: uuid(field(record, 'operationId')),
    operationKey: safeKey(field(record, 'operationKey')),
    resultStrategy: parsedStrategy,
    resultSchema: schema(field(record, 'resultSchema')),
    resultDigest: digest(field(record, 'resultDigest')),
    artifactId: artifactId === null ? null : safeKey(artifactId),
    usage: parseUsage(field(record, 'usage')),
    costBasis: parsedCostBasis,
  } satisfies DurableExecutionReceipt);
}
