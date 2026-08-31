import { types } from 'node:util';
import { ExecutionControlError } from '../execution-budget/execution-control-error';
import {
  parseDurableExecutionReceipt,
  type DurableExecutionReceipt,
  type DurableExecutionResultStrategy,
} from './durable-execution-receipt';

export type DomainAckPrivacyClass =
  | 'PUBLIC_ORGANIZATION'
  | 'CONFIDENTIAL_TENANT'
  | 'PERSONAL_DATA';

export interface DomainAckSubjectRef {
  readonly schemaVersion: 'generic-operation-subject-ref/v1';
  readonly subjectType: string;
  /** SHA-256 of the canonical subject identity; never the email/name itself. */
  readonly subjectIdHash: string;
}

export interface DomainAckContract {
  readonly schemaVersion: 'generic-operation-domain-ack/v1';
  readonly scopeKey: string;
  readonly authorityId: string;
  readonly accountId: string;
  readonly operationId: string;
  readonly resultStrategy: DurableExecutionResultStrategy;
  readonly resultSchema: string;
  readonly resultDigest: string;
  readonly artifactId: string | null;
  readonly consumer: string;
  readonly domainAggregateType: string;
  readonly domainAggregateId: string;
  readonly domainRevision: string;
  readonly privacyClass: DomainAckPrivacyClass;
  readonly subjectRef: DomainAckSubjectRef | null;
  readonly personalDataDsrCompatible: boolean;
  readonly acknowledgedAt: string;
}

export type ExecutionResultDisposition =
  | Readonly<{
      schemaVersion: 'execution-result-disposition/v1';
      kind: 'valid_output';
      receipt: DurableExecutionReceipt;
      automaticPhysicalRetryAllowed: false;
    }>
  | Readonly<{
      schemaVersion: 'execution-result-disposition/v1';
      kind: 'result_unknown' | 'control_error' | 'replay_error';
      code: string;
      operationStatus: 'RESULT_UNKNOWN' | 'RELEASED' | 'SETTLED';
      operationId: string;
      operationKey: string;
      automaticPhysicalRetryAllowed: false;
    }>;

const ACK_KEYS = Object.freeze([
  'schemaVersion', 'scopeKey', 'authorityId', 'accountId', 'operationId',
  'resultStrategy', 'resultSchema', 'resultDigest', 'artifactId', 'consumer',
  'domainAggregateType', 'domainAggregateId', 'domainRevision', 'privacyClass',
  'subjectRef', 'personalDataDsrCompatible', 'acknowledgedAt',
] as const);
const SUBJECT_KEYS = Object.freeze(['schemaVersion', 'subjectType', 'subjectIdHash'] as const);
const VALID_KEYS = Object.freeze(['schemaVersion', 'kind', 'receipt', 'automaticPhysicalRetryAllowed'] as const);
const ERROR_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'code', 'operationStatus', 'operationId',
  'operationKey', 'automaticPhysicalRetryAllowed',
] as const);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SCHEMA = /^[a-z][a-z0-9-]{0,99}\/v[1-9][0-9]{0,5}$/;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/;
const REVISION = /^(?:0|[1-9][0-9]{0,18}|[A-Za-z0-9][A-Za-z0-9:._/-]{0,119})$/;
const CONTROL_CODES = new Set([
  'EXECUTION_BUDGET_GRANT_REQUIRED', 'EXECUTION_BUDGET_GRANT_INVALID',
  'EXECUTION_BUDGET_GRANT_EXPIRED', 'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
  'EXECUTION_BUDGET_GRANT_REUSED', 'EXECUTION_BUDGET_AUTHORITY_REVOKED',
  'EXECUTION_BUDGET_AUTHORITY_EXHAUSTED',
  'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE', 'TOOL_POLICY_DENIED',
  'TOOL_RATE_LIMITED',
]);
const REPLAY_CODES = new Set([
  'GENERIC_OPERATION_REPLAY_INVALID', 'GENERIC_OPERATION_ARTIFACT_INVALID',
  'ARTIFACT_EXPIRED_UNACKED', 'GENERIC_OPERATION_DOMAIN_ACK_CONFLICT',
]);

function ackInvalid(): never { throw new ExecutionControlError('DOMAIN_ACK_CONTRACT_INVALID'); }
function dispositionInvalid(): never { throw new Error('EXECUTION_RESULT_DISPOSITION_INVALID'); }

function ownDataRecord(
  value: unknown,
  keys: readonly string[],
  invalid: () => never,
): Readonly<Record<string, unknown>> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
    ) invalid();
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
    }
    return value as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof Error && [
      'DOMAIN_ACK_CONTRACT_INVALID', 'EXECUTION_RESULT_DISPOSITION_INVALID',
    ].includes(error.message)) throw error;
    invalid();
  }
}

function valueOf(record: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function safeKey(value: unknown, invalid: () => never): string {
  if (typeof value !== 'string' || !SAFE_KEY.test(value) || value !== value.normalize('NFC')) invalid();
  return value;
}

function uuid(value: unknown, invalid: () => never): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value
  ) ackInvalid();
  return value;
}

function parseSubject(value: unknown): DomainAckSubjectRef {
  const source = ownDataRecord(value, SUBJECT_KEYS, ackInvalid);
  if (valueOf(source, 'schemaVersion') !== 'generic-operation-subject-ref/v1') ackInvalid();
  const subjectIdHash = valueOf(source, 'subjectIdHash');
  if (typeof subjectIdHash !== 'string' || !DIGEST.test(subjectIdHash)) ackInvalid();
  return Object.freeze({
    schemaVersion: 'generic-operation-subject-ref/v1',
    subjectType: safeKey(valueOf(source, 'subjectType'), ackInvalid),
    subjectIdHash,
  });
}

export function parseDomainAckContract(value: unknown): DomainAckContract {
  const source = ownDataRecord(value, ACK_KEYS, ackInvalid);
  if (valueOf(source, 'schemaVersion') !== 'generic-operation-domain-ack/v1') ackInvalid();
  const strategy = valueOf(source, 'resultStrategy');
  const schema = valueOf(source, 'resultSchema');
  const digest = valueOf(source, 'resultDigest');
  const artifactValue = valueOf(source, 'artifactId');
  const privacyClass = valueOf(source, 'privacyClass');
  const subjectValue = valueOf(source, 'subjectRef');
  const personalDataDsrCompatible = valueOf(source, 'personalDataDsrCompatible');
  const revision = valueOf(source, 'domainRevision');
  if (
    (strategy !== 'typed_projection' && strategy !== 'artifact_reference') ||
    typeof schema !== 'string' || !SCHEMA.test(schema) ||
    typeof digest !== 'string' || !DIGEST.test(digest) ||
    !['PUBLIC_ORGANIZATION', 'CONFIDENTIAL_TENANT', 'PERSONAL_DATA'].includes(String(privacyClass)) ||
    typeof personalDataDsrCompatible !== 'boolean' ||
    typeof revision !== 'string' || !REVISION.test(revision)
  ) ackInvalid();
  if (strategy === 'typed_projection' ? artifactValue !== null : typeof artifactValue !== 'string') ackInvalid();
  const artifactId = artifactValue === null ? null : uuid(artifactValue, ackInvalid);
  const subjectRef = subjectValue === null ? null : parseSubject(subjectValue);
  if (privacyClass === 'PERSONAL_DATA' && (!personalDataDsrCompatible || subjectRef === null)) ackInvalid();
  return Object.freeze({
    schemaVersion: 'generic-operation-domain-ack/v1',
    scopeKey: safeKey(valueOf(source, 'scopeKey'), ackInvalid),
    authorityId: uuid(valueOf(source, 'authorityId'), ackInvalid),
    accountId: uuid(valueOf(source, 'accountId'), ackInvalid),
    operationId: uuid(valueOf(source, 'operationId'), ackInvalid),
    resultStrategy: strategy,
    resultSchema: schema,
    resultDigest: digest,
    artifactId,
    consumer: safeKey(valueOf(source, 'consumer'), ackInvalid),
    domainAggregateType: safeKey(valueOf(source, 'domainAggregateType'), ackInvalid),
    domainAggregateId: safeKey(valueOf(source, 'domainAggregateId'), ackInvalid),
    domainRevision: revision,
    privacyClass: privacyClass as DomainAckPrivacyClass,
    subjectRef,
    personalDataDsrCompatible,
    acknowledgedAt: timestamp(valueOf(source, 'acknowledgedAt')),
  });
}

export function parseExecutionResultDisposition(value: unknown): ExecutionResultDisposition {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    dispositionInvalid();
  }
  const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value;
  if (kind === 'valid_output') {
    const source = ownDataRecord(value, VALID_KEYS, dispositionInvalid);
    if (
      valueOf(source, 'schemaVersion') !== 'execution-result-disposition/v1' ||
      valueOf(source, 'automaticPhysicalRetryAllowed') !== false
    ) dispositionInvalid();
    try {
      return Object.freeze({
        schemaVersion: 'execution-result-disposition/v1',
        kind: 'valid_output',
        receipt: parseDurableExecutionReceipt(valueOf(source, 'receipt')),
        automaticPhysicalRetryAllowed: false,
      });
    } catch {
      dispositionInvalid();
    }
  }
  const source = ownDataRecord(value, ERROR_KEYS, dispositionInvalid);
  const code = valueOf(source, 'code');
  const status = valueOf(source, 'operationStatus');
  const valid =
    kind === 'result_unknown'
      ? code === 'GENERIC_OPERATION_RESULT_UNKNOWN' && status === 'RESULT_UNKNOWN'
      : kind === 'control_error'
        ? typeof code === 'string' && CONTROL_CODES.has(code) && status === 'RELEASED'
        : kind === 'replay_error'
          ? typeof code === 'string' && REPLAY_CODES.has(code) && status === 'SETTLED'
          : false;
  if (
    !valid || valueOf(source, 'schemaVersion') !== 'execution-result-disposition/v1' ||
    valueOf(source, 'automaticPhysicalRetryAllowed') !== false
  ) dispositionInvalid();
  return Object.freeze({
    schemaVersion: 'execution-result-disposition/v1',
    kind,
    code: code as string,
    operationStatus: status as 'RESULT_UNKNOWN' | 'RELEASED' | 'SETTLED',
    operationId: uuid(valueOf(source, 'operationId'), dispositionInvalid),
    operationKey: safeKey(valueOf(source, 'operationKey'), dispositionInvalid),
    automaticPhysicalRetryAllowed: false,
  });
}
