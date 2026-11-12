import { types as nodeUtilTypes } from 'node:util';
import { Prisma } from '@prisma/client';
import {
  GOVERNED_OPERATION_SUBJECT_INVALID,
  GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE,
  GOVERNED_SUBJECT_AUTHORITY_REVOKED,
  GOVERNED_SUBJECT_INVALID,
  GOVERNED_SUBJECT_RELATION_CONFLICT,
  GOVERNED_SUBJECT_RELATION_INVALID,
  GOVERNED_SUBJECT_TOMBSTONED,
  type GovernedSubjectRelationInput,
  type GovernedSubjectRelationResult,
  type GovernedSubjectTombstoneInput,
  type GovernedSubjectTombstoneOutcome,
  type GovernedSubjectTombstoneResult,
} from './governed-subject-relation.types';

export {
  GOVERNED_OPERATION_SUBJECT_INVALID,
  GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE,
  GOVERNED_SUBJECT_AUTHORITY_REVOKED,
  GOVERNED_SUBJECT_INVALID,
  GOVERNED_SUBJECT_RELATION_CONFLICT,
  GOVERNED_SUBJECT_RELATION_INVALID,
  GOVERNED_SUBJECT_TOMBSTONED,
};

const INPUT_KEYS = [
  'workspaceId', 'authorityId', 'accountId', 'operationId',
  'operationGeneration', 'ackId', 'resultDigest', 'rootSubjectType',
  'rootSubjectId', 'rootDataClass', 'rootDsrSubjectType', 'rootDsrSubjectId',
  'parentGovernedSubjectId', 'childSubjectType', 'childSubjectId',
  'childDataClass', 'childDsrSubjectType', 'childDsrSubjectId', 'relationKey',
  'relationKind', 'sourceRef', 'contractSha256',
] as const;
const SOURCE_KEYS = ['namespace', 'uuid', 'sha256'] as const;
const RESULT_KEYS = [
  'operation_subject_id', 'parent_subject_id', 'child_subject_id', 'relation_id',
  'replay',
] as const;
const TOMBSTONE_INPUT_KEYS = [
  'workspaceId', 'governedSubjectId', 'deletionRequestId',
] as const;
const TOMBSTONE_RESULT_KEYS = [
  'governed_subject_id', 'tombstoned_at', 'audit_id', 'outcome',
] as const;
const TOMBSTONE_OUTCOMES = new Set<GovernedSubjectTombstoneOutcome>([
  'FENCE_CREATED', 'REPLAYED', 'AUDIT_APPENDED_WITH_EXISTING_FENCE',
]);
const DATE_GET_TIME = Function.prototype.call.bind(Date.prototype.getTime) as
  (value: Date) => number;
const DATE_TO_ISO = Function.prototype.call.bind(Date.prototype.toISOString) as
  (value: Date) => string;
const STABLE_ERRORS = new Set([
  GOVERNED_OPERATION_SUBJECT_INVALID,
  GOVERNED_SUBJECT_INVALID,
  GOVERNED_SUBJECT_RELATION_INVALID,
  GOVERNED_SUBJECT_RELATION_CONFLICT,
  GOVERNED_SUBJECT_TOMBSTONED,
  GOVERNED_SUBJECT_AUTHORITY_REVOKED,
  GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE,
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const SUBJECT_TYPE = /^[a-z][a-z0-9_.]{0,190}$/u;
const RELATION_KEY = /^[a-z][a-z0-9_.:-]{0,199}$/u;
const SOURCE_NAMESPACE = /^[a-z][a-z0-9_.]{0,63}$/u;

type Transaction = Readonly<{
  $queryRaw: (query: Prisma.Sql) => Promise<unknown>;
}>;

type RelationRow = Readonly<{
  operation_subject_id: unknown;
  parent_subject_id: unknown;
  child_subject_id: unknown;
  relation_id: unknown;
  replay: unknown;
}>;

type TombstoneRow = Readonly<{
  governed_subject_id: unknown;
  tombstoned_at: unknown;
  audit_id: unknown;
  outcome: unknown;
}>;

function invalid(): never {
  throw new Error(GOVERNED_SUBJECT_RELATION_INVALID);
}

function invalidOperation(): never {
  throw new Error(GOVERNED_OPERATION_SUBJECT_INVALID);
}

function invalidSubject(): never {
  throw new Error(GOVERNED_SUBJECT_INVALID);
}

function closedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (
      value === null || typeof value !== 'object' || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
    ) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
      keys.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor?.enumerable || !('value' in descriptor);
      })
    ) return invalid();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === GOVERNED_SUBJECT_RELATION_INVALID) throw error;
    return invalid();
  }
}

function uuid(value: unknown): string {
  return typeof value === 'string' && UUID.test(value) ? value : invalid();
}

function digest(value: unknown): string {
  return typeof value === 'string' && DIGEST.test(value) ? value : invalid();
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}

function nullableDigest(value: unknown): string | null {
  return value === null ? null : digest(value);
}

function boundedPattern(value: unknown, pattern: RegExp): string {
  return typeof value === 'string' && pattern.test(value) ? value : invalid();
}

function snapshotInput(value: unknown): GovernedSubjectRelationInput {
  const input = closedRecord(value, INPUT_KEYS);
  const source = closedRecord(input.sourceRef, SOURCE_KEYS);
  const workspaceId = uuid(input.workspaceId);
  const authorityId = uuid(input.authorityId);
  const accountId = uuid(input.accountId);
  const operationId = uuid(input.operationId);
  if (
    !Number.isSafeInteger(input.operationGeneration) ||
    Number(input.operationGeneration) < 1 || Number(input.operationGeneration) > 2_147_483_647
  ) {
    return invalid();
  }
  const operationGeneration = Number(input.operationGeneration);
  const ackId = digest(input.ackId);
  const resultDigest = digest(input.resultDigest);
  if (
    input.rootSubjectType !== 'tool_operation' || input.rootSubjectId !== operationId ||
    input.rootDataClass !== 'NON_PERSONAL' || input.rootDsrSubjectType !== null ||
    input.rootDsrSubjectId !== null
  ) return invalidOperation();
  const parentGovernedSubjectId = nullableUuid(input.parentGovernedSubjectId);
  const childSubjectType = boundedPattern(input.childSubjectType, SUBJECT_TYPE);
  const childSubjectId = uuid(input.childSubjectId);
  if (input.childDataClass !== 'PERSONAL' && input.childDataClass !== 'NON_PERSONAL') {
    return invalid();
  }
  const childDataClass = input.childDataClass;
  const childDsrSubjectType = input.childDsrSubjectType === null
    ? null : boundedPattern(input.childDsrSubjectType, SUBJECT_TYPE);
  const childDsrSubjectId = nullableUuid(input.childDsrSubjectId);
  if (
    (childDataClass === 'PERSONAL' && (!childDsrSubjectType || !childDsrSubjectId)) ||
    (childDataClass === 'NON_PERSONAL' && (childDsrSubjectType !== null || childDsrSubjectId !== null))
  ) return invalid();
  const relationKey = boundedPattern(input.relationKey, RELATION_KEY);
  if (input.relationKind !== 'MATERIALIZED_CHILD' && input.relationKind !== 'DERIVED_FROM') {
    return invalid();
  }
  const relationKind = input.relationKind;
  const namespace = boundedPattern(source.namespace, SOURCE_NAMESPACE);
  const sourceUuid = nullableUuid(source.uuid);
  const sourceSha256 = nullableDigest(source.sha256);
  if ((sourceUuid === null) === (sourceSha256 === null)) return invalid();
  const contractSha256 = digest(input.contractSha256);
  return Object.freeze({
    workspaceId, authorityId, accountId, operationId, operationGeneration,
    ackId, resultDigest, rootSubjectType: 'tool_operation', rootSubjectId: operationId,
    rootDataClass: 'NON_PERSONAL', rootDsrSubjectType: null, rootDsrSubjectId: null,
    parentGovernedSubjectId, childSubjectType, childSubjectId, childDataClass,
    childDsrSubjectType, childDsrSubjectId, relationKey, relationKind,
    sourceRef: Object.freeze({ namespace, uuid: sourceUuid, sha256: sourceSha256 }),
    contractSha256,
  });
}

function snapshotTombstoneInput(value: unknown): GovernedSubjectTombstoneInput {
  try {
    const input = closedRecord(value, TOMBSTONE_INPUT_KEYS);
    return Object.freeze({
      workspaceId: uuid(input.workspaceId),
      governedSubjectId: uuid(input.governedSubjectId),
      deletionRequestId: uuid(input.deletionRequestId),
    });
  } catch {
    return invalidSubject();
  }
}

function parseResult(
  value: unknown,
  expectedReplay: true | null,
): GovernedSubjectRelationResult {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
  }
  try {
    const row = closedRecord(value[0], RESULT_KEYS) as RelationRow;
    if (
      typeof row.replay !== 'boolean' ||
      (expectedReplay === true && row.replay !== true)
    ) throw new Error(GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
    return Object.freeze({
      operationSubjectId: uuid(row.operation_subject_id),
      parentSubjectId: uuid(row.parent_subject_id),
      childSubjectId: uuid(row.child_subject_id),
      relationId: uuid(row.relation_id),
      replay: row.replay,
    });
  } catch {
    throw new Error(GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
  }
}

function parseTombstoneResult(
  value: unknown,
  input: GovernedSubjectTombstoneInput,
): GovernedSubjectTombstoneResult {
  try {
    if (!Array.isArray(value) || value.length !== 1) throw new Error();
    const row = closedRecord(value[0], TOMBSTONE_RESULT_KEYS) as TombstoneRow;
    const governedSubjectId = uuid(row.governed_subject_id);
    const auditId = uuid(row.audit_id);
    if (
      governedSubjectId !== input.governedSubjectId ||
      auditId !== input.deletionRequestId ||
      typeof row.outcome !== 'string' ||
      !TOMBSTONE_OUTCOMES.has(row.outcome as GovernedSubjectTombstoneOutcome) ||
      row.tombstoned_at === null || typeof row.tombstoned_at !== 'object' ||
      nodeUtilTypes.isProxy(row.tombstoned_at) ||
      Object.getPrototypeOf(row.tombstoned_at) !== Date.prototype ||
      Reflect.ownKeys(row.tombstoned_at).length !== 0
    ) throw new Error();
    const milliseconds = DATE_GET_TIME(row.tombstoned_at as Date);
    if (!Number.isFinite(milliseconds)) throw new Error();
    const tombstonedAt = DATE_TO_ISO(row.tombstoned_at as Date);
    return Object.freeze({
      governedSubjectId, tombstonedAt, auditId,
      outcome: row.outcome as GovernedSubjectTombstoneOutcome,
    });
  } catch {
    throw new Error(GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
  }
}

function trustedDatabaseMarker(error: unknown, marker: string): boolean {
  try {
    if (
      nodeUtilTypes.isProxy(error) ||
      !(error instanceof Prisma.PrismaClientKnownRequestError)
    ) return false;
    const errorDescriptors = Object.getOwnPropertyDescriptors(error);
    const code = errorDescriptors.code;
    const meta = errorDescriptors.meta;
    if (
      !code || !('value' in code) || code.value !== 'P2010' ||
      !meta || !('value' in meta) || meta.value === null ||
      typeof meta.value !== 'object' || nodeUtilTypes.isProxy(meta.value)
    ) return false;
    const metaDescriptors = Object.getOwnPropertyDescriptors(meta.value);
    const sqlState = metaDescriptors.code;
    const message = metaDescriptors.message;
    return Boolean(
      sqlState && 'value' in sqlState && sqlState.value === 'P0001' &&
      message && 'value' in message && message.value === `ERROR: ${marker}`,
    );
  } catch {
    return false;
  }
}

function mappedDatabaseError(error: unknown): Error {
  for (const code of STABLE_ERRORS) {
    if (trustedDatabaseMarker(error, code)) return new Error(code);
  }
  return new Error(GOVERNED_SUBJECT_ATTESTATION_UNAVAILABLE);
}

function appendQuery(input: GovernedSubjectRelationInput): Prisma.Sql {
  return Prisma.sql`SELECT * FROM public.append_workspace_governed_child_relation_v1(${input.workspaceId}::uuid,${input.authorityId}::uuid,${input.accountId}::uuid,${input.operationId}::uuid,${input.operationGeneration}::integer,${input.ackId}::char(64),${input.resultDigest}::char(64),${input.rootSubjectType}::varchar(191),${input.rootSubjectId}::uuid,${input.rootDataClass}::varchar(16),${input.rootDsrSubjectType}::varchar(191),${input.rootDsrSubjectId}::uuid,${input.parentGovernedSubjectId}::uuid,${input.childSubjectType}::varchar(191),${input.childSubjectId}::uuid,${input.childDataClass}::varchar(16),${input.childDsrSubjectType}::varchar(191),${input.childDsrSubjectId}::uuid,${input.relationKey}::varchar(200),${input.relationKind}::varchar(32),${input.sourceRef.namespace}::varchar(64),${input.sourceRef.uuid}::uuid,${input.sourceRef.sha256}::char(64),${input.contractSha256}::char(64))`;
}

function attestQuery(input: GovernedSubjectRelationInput): Prisma.Sql {
  return Prisma.sql`SELECT * FROM public.attest_workspace_governed_child_relation_v1(${input.workspaceId}::uuid,${input.authorityId}::uuid,${input.accountId}::uuid,${input.operationId}::uuid,${input.operationGeneration}::integer,${input.ackId}::char(64),${input.resultDigest}::char(64),${input.rootSubjectType}::varchar(191),${input.rootSubjectId}::uuid,${input.rootDataClass}::varchar(16),${input.rootDsrSubjectType}::varchar(191),${input.rootDsrSubjectId}::uuid,${input.parentGovernedSubjectId}::uuid,${input.childSubjectType}::varchar(191),${input.childSubjectId}::uuid,${input.childDataClass}::varchar(16),${input.childDsrSubjectType}::varchar(191),${input.childDsrSubjectId}::uuid,${input.relationKey}::varchar(200),${input.relationKind}::varchar(32),${input.sourceRef.namespace}::varchar(64),${input.sourceRef.uuid}::uuid,${input.sourceRef.sha256}::char(64),${input.contractSha256}::char(64))`;
}

function tombstoneQuery(input: GovernedSubjectTombstoneInput): Prisma.Sql {
  return Prisma.sql`SELECT * FROM public.tombstone_workspace_governed_subject_v1(${input.workspaceId}::uuid,${input.governedSubjectId}::uuid,${input.deletionRequestId}::uuid)`;
}

export class GovernedSubjectRelationRepository {
  async appendChildRelationV1(
    transaction: Transaction,
    value: unknown,
  ): Promise<GovernedSubjectRelationResult> {
    const input = snapshotInput(value);
    try {
      const rows = await transaction.$queryRaw(
        appendQuery(input),
      );
      return parseResult(rows, null);
    } catch (error) {
      throw mappedDatabaseError(error);
    }
  }

  async attestChildRelationV1(
    transaction: Transaction,
    value: unknown,
  ): Promise<GovernedSubjectRelationResult> {
    const input = snapshotInput(value);
    try {
      const rows = await transaction.$queryRaw(
        attestQuery(input),
      );
      return parseResult(rows, true);
    } catch (error) {
      throw mappedDatabaseError(error);
    }
  }

  async tombstoneSubjectV1(
    transaction: Transaction,
    value: unknown,
  ): Promise<GovernedSubjectTombstoneResult> {
    const input = snapshotTombstoneInput(value);
    try {
      const rows = await transaction.$queryRaw(tombstoneQuery(input));
      return parseTombstoneResult(rows, input);
    } catch (error) {
      throw mappedDatabaseError(error);
    }
  }
}
