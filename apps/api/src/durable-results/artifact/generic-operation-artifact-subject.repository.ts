import { types } from "node:util";
import { Prisma } from "@prisma/client";
import type { DeletionSubjectType } from "../../compliance/deletion.types";
import { isCanonicalArtifactUuid } from "./artifact.types";

export const GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID =
  "GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID" as const;

export interface GenericOperationArtifactSubjectRef {
  readonly subjectType: DeletionSubjectType;
  readonly subjectId: string;
}

export interface GenericOperationArtifactSubjectBinding extends GenericOperationArtifactSubjectRef {
  readonly artifactId: string;
  readonly workspaceId: string;
  readonly createdAt: string;
}

export interface GenericOperationArtifactSubjectBindingResult extends GenericOperationArtifactSubjectBinding {
  readonly replay: boolean;
}

export interface ResolvedGenericOperationArtifactSubject extends GenericOperationArtifactSubjectRef {
  readonly workspaceId: string;
}

export interface GenericOperationArtifactSubjectTombstone extends GenericOperationArtifactSubjectRef {
  readonly workspaceId: string;
  readonly deletionRequestId: string;
  readonly tombstonedAt: string;
  readonly artifactCount: number;
  readonly replay: boolean;
}

type SubjectRow = Readonly<{
  artifact_id: unknown;
  workspace_id: unknown;
  subject_type: unknown;
  subject_id: unknown;
  created_at: unknown;
}>;

type TombstoneRow = Readonly<{
  workspace_id: unknown;
  subject_type: unknown;
  subject_id: unknown;
  deletion_request_id: unknown;
  tombstoned_at: unknown;
  artifact_count: unknown;
  replay: unknown;
}>;

type SubjectBindingRow = SubjectRow & Readonly<{ replay: unknown }>;

type ResolvedSubjectRow = Readonly<{
  workspace_id: unknown;
  subject_type: unknown;
  subject_id: unknown;
}>;

function invalid(): never {
  throw new Error(GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID);
}

function closedRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return invalid();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key)) ||
      keys.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor?.enumerable || !("value" in descriptor);
      })
    ) {
      return invalid();
    }
    return value as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === GENERIC_OPERATION_ARTIFACT_SUBJECT_INVALID
    ) {
      throw error;
    }
    return invalid();
  }
}

function canonicalTimestamp(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== "string") return invalid();
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) return invalid();
  const canonical = date.toISOString();
  if (typeof value === "string" && value !== canonical) return invalid();
  return canonical;
}

function subjectType(value: unknown): DeletionSubjectType {
  return value === "contact" || value === "company" ? value : invalid();
}

function uuid(value: unknown): string {
  return isCanonicalArtifactUuid(value) ? value : invalid();
}

export function parseGenericOperationArtifactSubjectRef(
  value: unknown,
): GenericOperationArtifactSubjectRef {
  const source = closedRecord(value, ["subjectType", "subjectId"]);
  return Object.freeze({
    subjectType: subjectType(source.subjectType),
    subjectId: uuid(source.subjectId),
  });
}

function parseSubjectRow(
  value: unknown,
): GenericOperationArtifactSubjectBinding {
  const source = closedRecord(value, [
    "artifact_id",
    "workspace_id",
    "subject_type",
    "subject_id",
    "created_at",
  ]) as SubjectRow;
  return Object.freeze({
    artifactId: uuid(source.artifact_id),
    workspaceId: uuid(source.workspace_id),
    subjectType: subjectType(source.subject_type),
    subjectId: uuid(source.subject_id),
    createdAt: canonicalTimestamp(source.created_at),
  });
}

function parseSubjectBindingRow(
  value: unknown,
): GenericOperationArtifactSubjectBindingResult {
  const source = closedRecord(value, [
    "artifact_id",
    "workspace_id",
    "subject_type",
    "subject_id",
    "created_at",
    "replay",
  ]) as SubjectBindingRow;
  if (typeof source.replay !== "boolean") return invalid();
  return Object.freeze({
    artifactId: uuid(source.artifact_id),
    workspaceId: uuid(source.workspace_id),
    subjectType: subjectType(source.subject_type),
    subjectId: uuid(source.subject_id),
    createdAt: canonicalTimestamp(source.created_at),
    replay: source.replay,
  });
}

function parseResolvedSubjectRow(
  value: unknown,
): ResolvedGenericOperationArtifactSubject {
  const source = closedRecord(value, [
    "workspace_id",
    "subject_type",
    "subject_id",
  ]) as ResolvedSubjectRow;
  return Object.freeze({
    workspaceId: uuid(source.workspace_id),
    subjectType: subjectType(source.subject_type),
    subjectId: uuid(source.subject_id),
  });
}

function parseTombstoneRow(
  value: unknown,
): GenericOperationArtifactSubjectTombstone {
  const source = closedRecord(value, [
    "workspace_id",
    "subject_type",
    "subject_id",
    "deletion_request_id",
    "tombstoned_at",
    "artifact_count",
    "replay",
  ]) as TombstoneRow;
  if (
    typeof source.artifact_count !== "number" ||
    !Number.isSafeInteger(source.artifact_count) ||
    source.artifact_count < 0 ||
    typeof source.replay !== "boolean"
  ) {
    return invalid();
  }
  return Object.freeze({
    workspaceId: uuid(source.workspace_id),
    subjectType: subjectType(source.subject_type),
    subjectId: uuid(source.subject_id),
    deletionRequestId: uuid(source.deletion_request_id),
    tombstonedAt: canonicalTimestamp(source.tombstoned_at),
    artifactCount: source.artifact_count,
    replay: source.replay,
  });
}

function assertWorkspace(value: unknown): string {
  return uuid(value);
}

export class GenericOperationArtifactSubjectRepository {
  async resolveExistingSubject(
    tx: Prisma.TransactionClient,
    input: Readonly<{
      workspaceId: string;
      subjectRef: GenericOperationArtifactSubjectRef;
    }>,
  ): Promise<ResolvedGenericOperationArtifactSubject | null> {
    const workspaceId = assertWorkspace(input.workspaceId);
    const subjectRef = parseGenericOperationArtifactSubjectRef(
      input.subjectRef,
    );
    const rows = await tx.$queryRaw<ResolvedSubjectRow[]>(Prisma.sql`
      SELECT candidate.workspace_id, candidate.subject_type,
        candidate.subject_id
      FROM (
        SELECT company.workspace_id, 'company'::text AS subject_type,
          company.id AS subject_id
        FROM public.canonical_company company
        WHERE company.workspace_id = ${workspaceId}::uuid
          AND ${subjectRef.subjectType} = 'company'
          AND company.id = ${subjectRef.subjectId}::uuid
        UNION ALL
        SELECT contact.workspace_id, 'contact'::text AS subject_type,
          contact.id AS subject_id
        FROM public.canonical_contact contact
        WHERE contact.workspace_id = ${workspaceId}::uuid
          AND ${subjectRef.subjectType} = 'contact'
          AND contact.id = ${subjectRef.subjectId}::uuid
      ) candidate
      WHERE session_user = 'app_user'
        AND current_setting('role', true) IS NOT DISTINCT FROM 'none'
        AND candidate.workspace_id IS NOT DISTINCT FROM current_workspace_id()
      LIMIT 1
    `);
    if (rows.length === 0) return null;
    if (rows.length !== 1) return invalid();
    const resolved = parseResolvedSubjectRow(rows[0]);
    if (
      resolved.workspaceId !== workspaceId ||
      resolved.subjectType !== subjectRef.subjectType ||
      resolved.subjectId !== subjectRef.subjectId
    ) {
      return invalid();
    }
    return resolved;
  }

  async bindArtifact(
    tx: Prisma.TransactionClient,
    input: Readonly<{
      workspaceId: string;
      artifactId: string;
      subjectRef: GenericOperationArtifactSubjectRef;
    }>,
  ): Promise<GenericOperationArtifactSubjectBindingResult> {
    const workspaceId = assertWorkspace(input.workspaceId);
    const artifactId = uuid(input.artifactId);
    const subjectRef = parseGenericOperationArtifactSubjectRef(
      input.subjectRef,
    );
    const rows = await tx.$queryRaw<SubjectBindingRow[]>(Prisma.sql`
      SELECT * FROM bind_workspace_generic_operation_artifact_subject_v1(
        ${workspaceId}::uuid,
        ${artifactId}::uuid,
        ${subjectRef.subjectType},
        ${subjectRef.subjectId}::uuid
      )
    `);
    if (rows.length !== 1) return invalid();
    const binding = parseSubjectBindingRow(rows[0]);
    if (
      binding.workspaceId !== workspaceId ||
      binding.artifactId !== artifactId ||
      binding.subjectType !== subjectRef.subjectType ||
      binding.subjectId !== subjectRef.subjectId
    ) {
      return invalid();
    }
    return binding;
  }

  async findBySubject(
    tx: Prisma.TransactionClient,
    input: Readonly<{
      workspaceId: string;
      subjectRef: GenericOperationArtifactSubjectRef;
    }>,
  ): Promise<readonly GenericOperationArtifactSubjectBinding[]> {
    const workspaceId = assertWorkspace(input.workspaceId);
    const subjectRef = parseGenericOperationArtifactSubjectRef(
      input.subjectRef,
    );
    const rows = await tx.$queryRaw<SubjectRow[]>(Prisma.sql`
      SELECT * FROM find_workspace_generic_operation_artifacts_by_subject_v1(
        ${workspaceId}::uuid,
        ${subjectRef.subjectType},
        ${subjectRef.subjectId}::uuid
      )
    `);
    return Object.freeze(rows.map(parseSubjectRow));
  }

  async tombstoneSubject(
    tx: Prisma.TransactionClient,
    input: Readonly<{
      workspaceId: string;
      deletionRequestId: string;
      subjectRef: GenericOperationArtifactSubjectRef;
    }>,
  ): Promise<GenericOperationArtifactSubjectTombstone> {
    const workspaceId = assertWorkspace(input.workspaceId);
    const deletionRequestId = uuid(input.deletionRequestId);
    const subjectRef = parseGenericOperationArtifactSubjectRef(
      input.subjectRef,
    );
    const rows = await tx.$queryRaw<TombstoneRow[]>(Prisma.sql`
      SELECT * FROM tombstone_workspace_generic_operation_artifact_subject_v1(
        ${workspaceId}::uuid,
        ${subjectRef.subjectType},
        ${subjectRef.subjectId}::uuid,
        ${deletionRequestId}::uuid
      )
    `);
    if (rows.length !== 1) return invalid();
    const tombstone = parseTombstoneRow(rows[0]);
    if (
      tombstone.workspaceId !== workspaceId ||
      tombstone.subjectType !== subjectRef.subjectType ||
      tombstone.subjectId !== subjectRef.subjectId ||
      tombstone.deletionRequestId !== deletionRequestId
    ) {
      return invalid();
    }
    return tombstone;
  }
}
