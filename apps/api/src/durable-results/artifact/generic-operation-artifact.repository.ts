import { Inject, Injectable, Optional } from "@nestjs/common";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  attestExecutionBudgetPlatformWriterTransaction,
  EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE,
} from "../../execution-budget/execution-budget-authority.repository";
import { PrismaService } from "../../prisma/prisma.service";
import { contentAddressedObjectKey } from "./artifact-key";
import { parseArtifactReference } from "./artifact-reference.schema";
import {
  GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
  GenericOperationArtifactError,
  invalidGenericOperationArtifact,
  isCanonicalArtifactSha256,
  isCanonicalArtifactSizeBytes,
  isCanonicalArtifactUuid,
  type ArtifactPrivacyClass,
  type ArtifactScopeKind,
  type GenericOperationArtifactManifest,
  type GenericOperationArtifactReference,
} from "./artifact.types";

const RESULT_SCHEMA_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,78}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,78}$/;
const PRIVACY_CLASSES = new Set<ArtifactPrivacyClass>([
  "PUBLIC_ORGANIZATION",
  "CONFIDENTIAL_TENANT",
  "PERSONAL_DATA",
]);
const MANIFEST_KEYS = [
  "schemaVersion",
  "artifactId",
  "scopeKind",
  "workspaceId",
  "authorityId",
  "operationId",
  "resultSchema",
  "objectKey",
  "sha256",
  "sizeBytes",
  "mediaType",
  "privacyClass",
  "sourceDigest",
  "createdAt",
  "expiresAt",
] as const satisfies readonly (keyof GenericOperationArtifactManifest)[];
const MANIFEST_KEY_SET = new Set<string>(MANIFEST_KEYS);
const ROW_KEYS = new Set([
  "artifact_id",
  "scope_key",
  "workspace_id",
  "authority_id",
  "operation_id",
  "result_schema",
  "object_key",
  "sha256",
  "size_bytes",
  "media_type",
  "privacy_class",
  "source_digest",
  "created_at",
  "expires_at",
  "replay",
]);

type ArtifactRow = Readonly<{
  artifact_id: unknown;
  scope_key: unknown;
  workspace_id: unknown;
  authority_id: unknown;
  operation_id: unknown;
  result_schema: unknown;
  object_key: unknown;
  sha256: unknown;
  size_bytes: unknown;
  media_type: unknown;
  privacy_class: unknown;
  source_digest: unknown;
  created_at: unknown;
  expires_at: unknown;
  replay?: unknown;
}>;

export interface GenericOperationArtifactBinding {
  readonly scopeKind: ArtifactScopeKind;
  readonly workspaceId: string | null;
  readonly authorityId: string;
  readonly operationId: string;
  readonly resultSchema: string;
}

export interface FindExactGenericOperationArtifactInput {
  readonly scopeKind: ArtifactScopeKind;
  readonly workspaceId: string | null;
  readonly authorityId: string;
  readonly reference: GenericOperationArtifactReference;
}

function isPlainClosedObject(
  value: unknown,
  keys: ReadonlySet<string>,
  requiredSize: number,
): value is Record<string, unknown> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const ownKeys = Reflect.ownKeys(value);
    return (
      (ownKeys.length === requiredSize ||
        (keys === ROW_KEYS && ownKeys.length === requiredSize - 1)) &&
      ownKeys.every((key) => typeof key === "string" && keys.has(key)) &&
      ownKeys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return Boolean(
          descriptor &&
          descriptor.enumerable &&
          Object.hasOwn(descriptor, "value"),
        );
      })
    );
  } catch {
    return false;
  }
}

function canonicalTimestamp(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const canonical = date.toISOString();
  if (typeof value === "string" && value !== canonical) return null;
  return canonical;
}

function assertResultSchema(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 100 ||
    !RESULT_SCHEMA_PATTERN.test(value)
  ) {
    invalidGenericOperationArtifact();
  }
}

function assertMediaType(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 160 ||
    !MEDIA_TYPE_PATTERN.test(value)
  ) {
    invalidGenericOperationArtifact();
  }
}

function assertScope(
  scopeKind: unknown,
  workspaceId: unknown,
): asserts scopeKind is ArtifactScopeKind {
  if (
    (scopeKind === "workspace" && !isCanonicalArtifactUuid(workspaceId)) ||
    (scopeKind === "platform" && workspaceId !== null) ||
    (scopeKind !== "workspace" && scopeKind !== "platform")
  ) {
    invalidGenericOperationArtifact();
  }
}

export function parseGenericOperationArtifactManifest(
  value: unknown,
): GenericOperationArtifactManifest {
  if (!isPlainClosedObject(value, MANIFEST_KEY_SET, MANIFEST_KEYS.length)) {
    return invalidGenericOperationArtifact();
  }

  const createdAt = canonicalTimestamp(value.createdAt);
  const expiresAt = canonicalTimestamp(value.expiresAt);
  assertScope(value.scopeKind, value.workspaceId);
  assertResultSchema(value.resultSchema);
  assertMediaType(value.mediaType);
  if (
    value.schemaVersion !== GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA ||
    !isCanonicalArtifactUuid(value.artifactId) ||
    !isCanonicalArtifactUuid(value.authorityId) ||
    !isCanonicalArtifactUuid(value.operationId) ||
    !isCanonicalArtifactSha256(value.sha256) ||
    !isCanonicalArtifactSizeBytes(value.sizeBytes) ||
    value.objectKey !== contentAddressedObjectKey(value.sha256) ||
    !PRIVACY_CLASSES.has(value.privacyClass as ArtifactPrivacyClass) ||
    (value.sourceDigest !== null &&
      !isCanonicalArtifactSha256(value.sourceDigest)) ||
    createdAt === null ||
    expiresAt === null ||
    Date.parse(expiresAt) <= Date.parse(createdAt)
  ) {
    return invalidGenericOperationArtifact();
  }

  return Object.freeze({
    schemaVersion: GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
    artifactId: value.artifactId,
    scopeKind: value.scopeKind,
    workspaceId: value.workspaceId as string | null,
    authorityId: value.authorityId,
    operationId: value.operationId,
    resultSchema: value.resultSchema,
    objectKey: value.objectKey,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
    mediaType: value.mediaType,
    privacyClass: value.privacyClass as ArtifactPrivacyClass,
    sourceDigest: value.sourceDigest,
    createdAt,
    expiresAt,
  });
}

function parseRow(row: unknown): GenericOperationArtifactManifest {
  if (!isPlainClosedObject(row, ROW_KEYS, ROW_KEYS.size)) {
    return invalidGenericOperationArtifact();
  }
  const typed = row as ArtifactRow;
  if (typeof typed.scope_key !== "string") {
    return invalidGenericOperationArtifact();
  }
  const scopeKind: ArtifactScopeKind =
    typed.scope_key === "platform" ? "platform" : "workspace";
  if (typeof typed.size_bytes !== "bigint" || typed.size_bytes < 0n) {
    return invalidGenericOperationArtifact();
  }
  return parseGenericOperationArtifactManifest({
    schemaVersion: GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
    artifactId: typed.artifact_id,
    scopeKind,
    workspaceId: typed.workspace_id,
    authorityId: typed.authority_id,
    operationId: typed.operation_id,
    resultSchema: typed.result_schema,
    objectKey: typed.object_key,
    sha256: typed.sha256,
    sizeBytes: typed.size_bytes.toString(),
    mediaType: typed.media_type,
    privacyClass: typed.privacy_class,
    sourceDigest: typed.source_digest,
    createdAt: canonicalTimestamp(typed.created_at),
    expiresAt: canonicalTimestamp(typed.expires_at),
  });
}

function parseOptionalSingleRow(
  rows: readonly unknown[],
): GenericOperationArtifactManifest | null {
  if (rows.length === 0) return null;
  if (rows.length !== 1) return invalidGenericOperationArtifact();
  return parseRow(rows[0]);
}

function sameManifest(
  left: GenericOperationArtifactManifest,
  right: GenericOperationArtifactManifest,
): boolean {
  return MANIFEST_KEYS.every((key) => left[key] === right[key]);
}

function matchesExactLookup(
  manifest: GenericOperationArtifactManifest,
  input: FindExactGenericOperationArtifactInput,
  reference: GenericOperationArtifactReference,
): boolean {
  return (
    manifest.scopeKind === input.scopeKind &&
    manifest.workspaceId === input.workspaceId &&
    manifest.authorityId === input.authorityId &&
    manifest.artifactId === reference.artifactId &&
    manifest.operationId === reference.operationId &&
    manifest.resultSchema === reference.resultSchema &&
    manifest.sha256 === reference.sha256 &&
    manifest.sizeBytes === reference.sizeBytes &&
    manifest.mediaType === reference.mediaType &&
    manifest.expiresAt === reference.expiresAt
  );
}

function matchesBinding(
  manifest: GenericOperationArtifactManifest,
  binding: GenericOperationArtifactBinding,
): boolean {
  return (
    manifest.scopeKind === binding.scopeKind &&
    manifest.workspaceId === binding.workspaceId &&
    manifest.authorityId === binding.authorityId &&
    manifest.operationId === binding.operationId &&
    manifest.resultSchema === binding.resultSchema
  );
}

function assertBinding(
  input: GenericOperationArtifactBinding,
): GenericOperationArtifactBinding {
  assertScope(input.scopeKind, input.workspaceId);
  if (
    !isCanonicalArtifactUuid(input.authorityId) ||
    !isCanonicalArtifactUuid(input.operationId)
  ) {
    return invalidGenericOperationArtifact();
  }
  assertResultSchema(input.resultSchema);
  return Object.freeze({ ...input });
}

function mapArtifactPersistenceError(error: unknown): never {
  if (error instanceof GenericOperationArtifactError) throw error;
  return invalidGenericOperationArtifact();
}

@Injectable()
export class GenericOperationArtifactRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE)
    private readonly platformWriter?: PrismaClient,
  ) {}

  async appendManifest(
    input: GenericOperationArtifactManifest,
  ): Promise<GenericOperationArtifactManifest> {
    try {
      const value = parseGenericOperationArtifactManifest(input);
      const rows =
        value.scopeKind === "workspace"
          ? await this.runWorkspace(value.workspaceId as string, (tx) =>
              tx.$queryRaw<ArtifactRow[]>(Prisma.sql`
                SELECT * FROM append_workspace_generic_operation_artifact_v1(
                  ${value.workspaceId}::uuid, ${value.artifactId}::uuid,
                  ${value.authorityId}::uuid, ${value.operationId}::uuid,
                  ${value.resultSchema}, ${value.objectKey}, ${value.sha256},
                  ${BigInt(value.sizeBytes)}, ${value.mediaType},
                  ${value.privacyClass}, ${value.sourceDigest},
                  ${new Date(value.createdAt)}, ${new Date(value.expiresAt)}
                )
              `),
            )
          : await this.runPlatform((tx) =>
              tx.$queryRaw<ArtifactRow[]>(Prisma.sql`
                SELECT * FROM append_platform_generic_operation_artifact_v1(
                  ${value.artifactId}::uuid, ${value.authorityId}::uuid,
                  ${value.operationId}::uuid, ${value.resultSchema},
                  ${value.objectKey}, ${value.sha256}, ${BigInt(value.sizeBytes)},
                  ${value.mediaType}, ${value.privacyClass},
                  ${value.sourceDigest}, ${new Date(value.createdAt)},
                  ${new Date(value.expiresAt)}
                )
              `),
            );
      const stored = parseOptionalSingleRow(rows);
      return stored && sameManifest(stored, value)
        ? stored
        : invalidGenericOperationArtifact();
    } catch (error) {
      return mapArtifactPersistenceError(error);
    }
  }

  async findExact(
    input: FindExactGenericOperationArtifactInput,
  ): Promise<GenericOperationArtifactManifest | null> {
    try {
      assertScope(input.scopeKind, input.workspaceId);
      if (!isCanonicalArtifactUuid(input.authorityId)) {
        return invalidGenericOperationArtifact();
      }
      const reference = parseArtifactReference(input.reference);
      const rows =
        input.scopeKind === "workspace"
          ? await this.runWorkspace(input.workspaceId as string, (tx) =>
              tx.$queryRaw<ArtifactRow[]>(Prisma.sql`
                SELECT * FROM find_exact_workspace_generic_operation_artifact_v1(
                  ${input.workspaceId}::uuid, ${reference.artifactId}::uuid,
                  ${input.authorityId}::uuid, ${reference.operationId}::uuid,
                  ${reference.resultSchema}, ${reference.sha256},
                  ${BigInt(reference.sizeBytes)}, ${reference.mediaType},
                  ${new Date(reference.expiresAt)}
                )
              `),
            )
          : await this.runPlatform((tx) =>
              tx.$queryRaw<ArtifactRow[]>(Prisma.sql`
                SELECT * FROM find_exact_platform_generic_operation_artifact_v1(
                  ${reference.artifactId}::uuid, ${input.authorityId}::uuid,
                  ${reference.operationId}::uuid, ${reference.resultSchema},
                  ${reference.sha256}, ${BigInt(reference.sizeBytes)},
                  ${reference.mediaType}, ${new Date(reference.expiresAt)}
                )
              `),
            );
      const stored = parseOptionalSingleRow(rows);
      return stored === null || matchesExactLookup(stored, input, reference)
        ? stored
        : invalidGenericOperationArtifact();
    } catch (error) {
      return mapArtifactPersistenceError(error);
    }
  }

  async findByOperation(
    input: GenericOperationArtifactBinding,
  ): Promise<GenericOperationArtifactManifest | null> {
    try {
      const binding = assertBinding(input);
      const rows =
        binding.scopeKind === "workspace"
          ? await this.runWorkspace(binding.workspaceId as string, (tx) =>
              tx.$queryRaw<ArtifactRow[]>(Prisma.sql`
                SELECT * FROM find_workspace_generic_operation_artifact_by_operation_v1(
                  ${binding.workspaceId}::uuid, ${binding.authorityId}::uuid,
                  ${binding.operationId}::uuid, ${binding.resultSchema}
                )
              `),
            )
          : await this.runPlatform((tx) =>
              tx.$queryRaw<ArtifactRow[]>(Prisma.sql`
                SELECT * FROM find_platform_generic_operation_artifact_by_operation_v1(
                  ${binding.authorityId}::uuid, ${binding.operationId}::uuid,
                  ${binding.resultSchema}
                )
              `),
            );
      const stored = parseOptionalSingleRow(rows);
      return stored === null || matchesBinding(stored, binding)
        ? stored
        : invalidGenericOperationArtifact();
    } catch (error) {
      return mapArtifactPersistenceError(error);
    }
  }

  private runWorkspace<T>(
    workspaceId: string,
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.withWorkspace(workspaceId, operation, {
      maxWait: 1_000,
      timeout: 2_500,
    });
  }

  private async runPlatform<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!this.platformWriter) return invalidGenericOperationArtifact();
    return this.platformWriter.$transaction(
      async (transaction) => {
        await transaction.$executeRawUnsafe(
          "SET LOCAL statement_timeout = 2000",
        );
        await attestExecutionBudgetPlatformWriterTransaction(transaction);
        return operation(transaction);
      },
      { maxWait: 1_000, timeout: 2_500 },
    );
  }
}
