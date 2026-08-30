import { createHash } from 'node:crypto';
import { ExecutionControlError } from '../execution-budget/execution-control-error';
import { Prisma } from '@prisma/client';
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
  readonly domainRevision?: string;
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
  readonly domainRevision: string;
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

export interface DomainAckRepository<TTransaction = unknown> {
  apply<T>(
    record: DomainAckRecord,
    apply: (transaction: TTransaction) => Promise<T>,
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
  throw new ExecutionControlError('DOMAIN_ACK_INVALID');
}

function safeText(value: string, options: { readonly rejectPayloadHints?: boolean } = {}): string {
  if (
    typeof value !== 'string' ||
    !SAFE_TEXT.test(value) ||
    (options.rejectPayloadHints === true && PII_LIKE.test(value)) ||
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
  readonly domainRevision: string;
  readonly resultDigest: string;
}): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}

function opaqueDomainIdentity(value: string): string {
  return createHash('sha256').update(value.normalize('NFC')).digest('hex');
}

function opaqueDomainIdentitySource(value: string): string {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > 500 ||
    value.includes('\0') || value !== value.normalize('NFC') || PII_LIKE.test(value)
  ) invalid();
  return value;
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

export class InMemoryDomainAckRepository implements DomainAckRepository<undefined> {
  private readonly records = new Map<string, DomainAckRecord>();
  private readonly pending = new Map<string, Promise<DomainAckRecord>>();

  private key(record: DomainAckRecord): string {
    return [
      record.operationId,
      record.consumer,
      record.domainAggregateType,
      record.domainAckKey,
      record.domainRevision,
    ].join('\0');
  }

  async apply<T>(
    record: DomainAckRecord,
    apply: (transaction: undefined) => Promise<T>,
  ): Promise<DomainAckApplyResult<T>> {
    const key = this.key(record);
    const existing = this.records.get(key);
    if (existing) {
      if (!sameAck(existing, record)) throw new DomainAckConflictError(record.operationId);
      return Object.freeze({ status: 'REPLAYED' as const, ack: existing, value: undefined });
    }
    const pending = this.pending.get(key);
    if (pending) {
      const stored = await pending;
      if (!sameAck(stored, record)) throw new DomainAckConflictError(record.operationId);
      return Object.freeze({ status: 'REPLAYED' as const, ack: stored, value: undefined });
    }
    let resolvePending!: (record: DomainAckRecord) => void;
    let rejectPending!: (error: unknown) => void;
    this.pending.set(key, new Promise<DomainAckRecord>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    }));
    try {
      const value = await apply(undefined);
      const stored = freezeRecord(record);
      this.records.set(key, stored);
      resolvePending(stored);
      return Object.freeze({ status: 'APPLIED' as const, ack: stored, value });
    } catch (error) {
      rejectPending(error);
      throw error;
    } finally {
      this.pending.delete(key);
    }
  }

  snapshot(): readonly DomainAckRecord[] {
    return Object.freeze([...this.records.values()].map((record) => freezeRecord(record)));
  }
}

interface PostgresDomainAckRow {
  status: 'APPLIED' | 'REPLAYED';
  ack_json: unknown;
}

export interface DomainAckTransaction {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
}

function parseAckRow(rows: readonly PostgresDomainAckRow[], expected: DomainAckRecord): {
  readonly status: 'APPLIED' | 'REPLAYED';
  readonly ack: DomainAckRecord;
} {
  const row = rows[0];
  if (!row || (row.status !== 'APPLIED' && row.status !== 'REPLAYED')) invalid();
  const ack = freezeRecord(row.ack_json as DomainAckRecord);
  if (!sameAck(ack, expected)) throw new DomainAckConflictError(expected.operationId);
  return Object.freeze({ status: row.status, ack });
}

export class PostgresDomainAckRepository implements DomainAckRepository<DomainAckTransaction> {
  constructor(private readonly transaction: DomainAckTransaction) {}

  async apply<T>(
    record: DomainAckRecord,
    apply: (transaction: DomainAckTransaction) => Promise<T>,
  ): Promise<DomainAckApplyResult<T>> {
    await this.transaction.$queryRaw(
      Prisma.sql`SELECT public.lock_execution_domain_ack_authority_first_v1(
        ${record.scopeKey}, ${record.authorityId}::uuid
      )`,
    );
    const locked = parseAckRow(
      await this.transaction.$queryRaw<PostgresDomainAckRow[]>(
        Prisma.sql`SELECT * FROM apply_execution_domain_ack_v1(
          ${record.scopeKey}, ${record.operationId}::uuid, ${record.consumer},
          ${record.domainAggregateType}, ${record.domainAckKey},
          ${record.domainRevision}
        )`,
      ),
      record,
    );
    if (locked.status === 'REPLAYED') {
      return Object.freeze({ status: 'REPLAYED' as const, ack: locked.ack, value: undefined });
    }
    const value = await apply(this.transaction);
    return Object.freeze({ status: 'APPLIED' as const, ack: locked.ack, value });
  }
}

export class DomainAckService<TTransaction = unknown> {
  constructor(private readonly repository: DomainAckRepository<TTransaction>) {}

  async applyWithAck<T>(
    input: DomainAckInput,
    apply: (transaction: TTransaction) => Promise<T>,
  ): Promise<DomainAckApplyResult<T>> {
    const receipt = parseDurableExecutionReceipt(input.receipt);
    const consumer = safeText(input.consumer);
    const domainAggregateType = safeText(input.domainAggregateType);
    const domainAckKey = opaqueDomainIdentity(
      opaqueDomainIdentitySource(input.domainAckKey),
    );
    const domainRevision = opaqueDomainIdentity(
      opaqueDomainIdentitySource(input.domainRevision ?? '0'),
    );
    const record = freezeRecord({
      schemaVersion: 'domain-ack/v1',
      ackId: ackId({
        operationId: receipt.operationId,
        consumer,
        domainAggregateType,
        domainAckKey,
        domainRevision,
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
      domainRevision,
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
