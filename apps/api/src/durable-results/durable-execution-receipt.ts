import { types } from 'node:util';

export type DurableExecutionResultStrategy =
  | 'typed_projection'
  | 'artifact_reference';

export type DurableExecutionCostBasis =
  | 'provider_reported'
  | 'token_pricing'
  | 'estimated_upper_bound'
  | 'not_incurred';

/** Accounting facts only. Token content, provider payloads and credentials are forbidden. */
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

/**
 * Immutable, ledger-authored result identity. This type is intentionally not
 * attached to RouterModelGateway or ToolBroker until the final cutover task.
 */
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
  readonly status: 'SETTLED';
}

const RECEIPT_KEYS = Object.freeze([
  'schemaVersion', 'scopeKey', 'authorityId', 'accountId', 'operationId',
  'operationKey', 'resultStrategy', 'resultSchema', 'resultDigest',
  'artifactId', 'usage', 'costBasis', 'status',
] as const);

const USAGE_KEYS = Object.freeze([
  'currency', 'unit', 'callCount', 'inputTokens', 'outputTokens',
  'bytesProcessed', 'bytesBilled', 'maximumBytesBilled',
  'chargedMicrousd', 'upperBoundMicrousd',
] as const);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const SCHEMA = /^[a-z][a-z0-9-]{0,99}\/v[1-9][0-9]{0,5}$/;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/;

function invalid(): never {
  throw new Error('DURABLE_EXECUTION_RECEIPT_INVALID');
}

function ownDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key)) ||
      keys.length !== allowedKeys.length
    ) invalid();
    for (const key of allowedKeys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
    }
    return value as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof Error && error.message === 'DURABLE_EXECUTION_RECEIPT_INVALID') throw error;
    invalid();
  }
}

function optionalOwnDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) invalid();
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
    }
    if (requiredKeys.some((key) => !Object.hasOwn(descriptors, key))) invalid();
    return value as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof Error && error.message === 'DURABLE_EXECUTION_RECEIPT_INVALID') throw error;
    invalid();
  }
}

function valueOf(record: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function boundedKey(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_KEY.test(value) || value !== value.normalize('NFC')) invalid();
  return value;
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}

function decimal(value: unknown): string {
  if (typeof value !== 'string' || !DECIMAL.test(value) || value.length > 19) invalid();
  try {
    if (BigInt(value) > 9_223_372_036_854_775_807n) invalid();
  } catch {
    invalid();
  }
  return value;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function optionalCount(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  return Object.hasOwn(record, key) ? count(valueOf(record, key)) : undefined;
}

function optionalDecimal(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return Object.hasOwn(record, key) ? decimal(valueOf(record, key)) : undefined;
}

function parseUsage(value: unknown, costBasis: DurableExecutionCostBasis): DurableExecutionUsageFacts {
  const source = optionalOwnDataRecord(value, USAGE_KEYS, ['currency', 'unit']);
  if (valueOf(source, 'currency') !== 'USD' || valueOf(source, 'unit') !== 'microusd') invalid();
  const result = Object.freeze({
    currency: 'USD' as const,
    unit: 'microusd' as const,
    ...(optionalCount(source, 'callCount') === undefined ? {} : { callCount: optionalCount(source, 'callCount') }),
    ...(optionalCount(source, 'inputTokens') === undefined ? {} : { inputTokens: optionalCount(source, 'inputTokens') }),
    ...(optionalCount(source, 'outputTokens') === undefined ? {} : { outputTokens: optionalCount(source, 'outputTokens') }),
    ...(optionalDecimal(source, 'bytesProcessed') === undefined ? {} : { bytesProcessed: optionalDecimal(source, 'bytesProcessed') }),
    ...(optionalDecimal(source, 'bytesBilled') === undefined ? {} : { bytesBilled: optionalDecimal(source, 'bytesBilled') }),
    ...(optionalDecimal(source, 'maximumBytesBilled') === undefined ? {} : { maximumBytesBilled: optionalDecimal(source, 'maximumBytesBilled') }),
    ...(optionalDecimal(source, 'chargedMicrousd') === undefined ? {} : { chargedMicrousd: optionalDecimal(source, 'chargedMicrousd') }),
    ...(optionalDecimal(source, 'upperBoundMicrousd') === undefined ? {} : { upperBoundMicrousd: optionalDecimal(source, 'upperBoundMicrousd') }),
  });
  const charged = result.chargedMicrousd === undefined ? undefined : BigInt(result.chargedMicrousd);
  const upper = result.upperBoundMicrousd === undefined ? undefined : BigInt(result.upperBoundMicrousd);
  const billed = result.bytesBilled === undefined ? undefined : BigInt(result.bytesBilled);
  const maximumBilled = result.maximumBytesBilled === undefined
    ? undefined
    : BigInt(result.maximumBytesBilled);
  if (charged !== undefined && upper !== undefined && charged > upper) invalid();
  if (billed !== undefined && maximumBilled !== undefined && billed > maximumBilled) invalid();
  if (costBasis === 'provider_reported' && charged === undefined) invalid();
  if (
    costBasis !== 'not_incurred' &&
    (result.callCount === undefined || result.callCount < 1)
  ) invalid();
  if (
    costBasis === 'token_pricing' &&
    (charged === undefined || upper === undefined ||
      (result.inputTokens === undefined && result.outputTokens === undefined))
  ) invalid();
  if (costBasis === 'estimated_upper_bound' && (charged === undefined || upper === undefined || charged !== upper)) {
    invalid();
  }
  if (
    costBasis === 'not_incurred' &&
    (
      result.callCount !== 0 || charged !== 0n || upper !== 0n ||
      result.inputTokens !== undefined || result.outputTokens !== undefined ||
      result.bytesProcessed !== undefined || result.bytesBilled !== undefined ||
      result.maximumBytesBilled !== undefined
    )
  ) invalid();
  return result;
}

export function parseDurableExecutionReceipt(value: unknown): DurableExecutionReceipt {
  const source = ownDataRecord(value, RECEIPT_KEYS);
  if (valueOf(source, 'schemaVersion') !== 'durable-execution-receipt/v1') invalid();
  const resultStrategy = valueOf(source, 'resultStrategy');
  if (resultStrategy !== 'typed_projection' && resultStrategy !== 'artifact_reference') invalid();
  const resultSchema = valueOf(source, 'resultSchema');
  const resultDigest = valueOf(source, 'resultDigest');
  const artifactValue = valueOf(source, 'artifactId');
  const costBasis = valueOf(source, 'costBasis');
  if (
    typeof resultSchema !== 'string' || !SCHEMA.test(resultSchema) ||
    typeof resultDigest !== 'string' || !DIGEST.test(resultDigest) ||
    !['provider_reported', 'token_pricing', 'estimated_upper_bound', 'not_incurred'].includes(String(costBasis)) ||
    valueOf(source, 'status') !== 'SETTLED'
  ) invalid();
  if (resultStrategy === 'typed_projection' ? artifactValue !== null : typeof artifactValue !== 'string') invalid();
  const artifactId = artifactValue === null ? null : uuid(artifactValue);
  return Object.freeze({
    schemaVersion: 'durable-execution-receipt/v1',
    scopeKey: boundedKey(valueOf(source, 'scopeKey')),
    authorityId: uuid(valueOf(source, 'authorityId')),
    accountId: uuid(valueOf(source, 'accountId')),
    operationId: uuid(valueOf(source, 'operationId')),
    operationKey: boundedKey(valueOf(source, 'operationKey')),
    resultStrategy,
    resultSchema,
    resultDigest,
    artifactId,
    usage: parseUsage(valueOf(source, 'usage'), costBasis as DurableExecutionCostBasis),
    costBasis: costBasis as DurableExecutionCostBasis,
    status: 'SETTLED',
  });
}
