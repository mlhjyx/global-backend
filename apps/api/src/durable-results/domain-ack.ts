import { createHash } from 'node:crypto';
import {
  parseDurableExecutionReceipt,
  type DurableExecutionReceipt,
  type DurableExecutionUsageFacts,
} from './durable-execution-receipt';

export interface DomainAckInput {
  readonly receipt: DurableExecutionReceipt;
  readonly consumer: string;
  readonly domainAggregateType: string;
  readonly domainAckKey: string;
}

export interface DomainAckRecord {
  readonly schemaVersion: 'domain-ack/v1';
  readonly ackId: string;
  readonly operationId: string;
  readonly operationKey: string;
  readonly authorityId: string;
  readonly accountId: string;
  readonly scopeKey: string;
  readonly consumer: string;
  readonly domainAggregateType: string;
  readonly domainAckKey: string;
  readonly resultStrategy: DurableExecutionReceipt['resultStrategy'];
  readonly resultSchema: string;
  readonly resultDigest: string;
  readonly artifactId: string | null;
  readonly usage: DurableExecutionUsageFacts;
  readonly costBasis: DurableExecutionReceipt['costBasis'];
}

export interface DomainAckApplyResult<T> {
  readonly status: 'APPLIED' | 'REPLAYED';
  readonly ack: DomainAckRecord;
  readonly value?: T;
}

export interface DomainAckRepository {
  apply<T>(
    record: DomainAckRecord,
    apply: () => Promise<T>,
  ): Promise<DomainAckApplyResult<T>>;
}

export class DomainAckConflictError extends Error {
  readonly code = 'DOMAIN_ACK_CONFLICT';

  constructor(operationId: string) {
    super(`domain ack conflict for operation ${operationId}`);
    this.name = 'DomainAckConflictError';
  }
}

const SAFE_TEXT = /^[A-Za-z0-9:._/-]{1,200}$/u;
const PII_LIKE = /@|email|phone|address|credential|token|secret|prompt|reasoning|rawResponse|responseBody/i;

function invalid(): never {
  throw new Error('DOMAIN_ACK_INVALID');
}

function safeText(value: string): string {
  if (
    typeof value !== 'string' ||
    !SAFE_TEXT.test(value) ||
    PII_LIKE.test(value) ||
    value !== value.normalize('NFC')
  ) {
    invalid();
  }
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(record[key])}`
  )).join(',')}}`;
}

function ackId(input: {
  readonly operationId: string;
  readonly consumer: string;
  readonly domainAggregateType: string;
  readonly domainAckKey: string;
  readonly resultDigest: string;
}): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}

function sameAck(left: DomainAckRecord, right: DomainAckRecord): boolean {
  return canonical(left) === canonical(right);
}

function freezeRecord(record: DomainAckRecord): DomainAckRecord {
  return Object.freeze({
    ...record,
    usage: Object.freeze({ ...record.usage }),
  });
}

export class InMemoryDomainAckRepository implements DomainAckRepository {
  private readonly records = new Map<string, DomainAckRecord>();

  async apply<T>(
    record: DomainAckRecord,
    apply: () => Promise<T>,
  ): Promise<DomainAckApplyResult<T>> {
    const existing = this.records.get(record.operationId);
    if (existing) {
      if (!sameAck(existing, record)) throw new DomainAckConflictError(record.operationId);
      return Object.freeze({ status: 'REPLAYED' as const, ack: existing, value: undefined });
    }
    const value = await apply();
    const stored = freezeRecord(record);
    this.records.set(record.operationId, stored);
    return Object.freeze({ status: 'APPLIED' as const, ack: stored, value });
  }

  snapshot(): readonly DomainAckRecord[] {
    return Object.freeze([...this.records.values()].map((record) => freezeRecord(record)));
  }
}

export class DomainAckService {
  constructor(private readonly repository: DomainAckRepository) {}

  async applyWithAck<T>(
    input: DomainAckInput,
    apply: () => Promise<T>,
  ): Promise<DomainAckApplyResult<T>> {
    const receipt = parseDurableExecutionReceipt(input.receipt);
    const consumer = safeText(input.consumer);
    const domainAggregateType = safeText(input.domainAggregateType);
    const domainAckKey = safeText(input.domainAckKey);
    const record = freezeRecord({
      schemaVersion: 'domain-ack/v1',
      ackId: ackId({
        operationId: receipt.operationId,
        consumer,
        domainAggregateType,
        domainAckKey,
        resultDigest: receipt.resultDigest,
      }),
      operationId: receipt.operationId,
      operationKey: receipt.operationKey,
      authorityId: receipt.authorityId,
      accountId: receipt.accountId,
      scopeKey: receipt.scopeKey,
      consumer,
      domainAggregateType,
      domainAckKey,
      resultStrategy: receipt.resultStrategy,
      resultSchema: receipt.resultSchema,
      resultDigest: receipt.resultDigest,
      artifactId: receipt.artifactId,
      usage: receipt.usage,
      costBasis: receipt.costBasis,
    });
    return this.repository.apply(record, apply);
  }
}
