import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../prisma/prisma.service";
import { contentAddressedObjectKey } from "./artifact-key";
import {
  GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
  GENERIC_OPERATION_ARTIFACT_REFERENCE_SCHEMA,
  GenericOperationArtifactError,
  type GenericOperationArtifactManifest,
  type GenericOperationArtifactReference,
} from "./artifact.types";
import { GenericOperationArtifactRepository } from "./generic-operation-artifact.repository";

const WORKSPACE_ID = "e03abddd-1307-47cb-a731-7e7a786615a0";
const AUTHORITY_ID = "42c863b9-7c7e-4d28-8678-60ef9a20219b";
const OPERATION_ID = "8cf66f2a-1780-453e-8d7d-f70e36cb22a6";
const ARTIFACT_ID = "9c621e96-9ec9-4712-aa51-cbb312d6a8f1";
const SHA256 = "ab".padEnd(64, "0");

function manifest(
  overrides: Partial<GenericOperationArtifactManifest> = {},
): GenericOperationArtifactManifest {
  return {
    schemaVersion: GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
    artifactId: ARTIFACT_ID,
    scopeKind: "workspace",
    workspaceId: WORKSPACE_ID,
    authorityId: AUTHORITY_ID,
    operationId: OPERATION_ID,
    resultSchema: "http-get/v1",
    objectKey: contentAddressedObjectKey(SHA256),
    sha256: SHA256,
    sizeBytes: "1048576",
    mediaType: "text/html",
    privacyClass: "CONFIDENTIAL_TENANT",
    sourceDigest: "cd".padEnd(64, "0"),
    createdAt: "2026-08-21T01:02:03.004Z",
    expiresAt: "2026-08-22T01:02:03.004Z",
    ...overrides,
  };
}

function reference(
  overrides: Partial<GenericOperationArtifactReference> = {},
): GenericOperationArtifactReference {
  const value = manifest();
  return {
    schemaVersion: GENERIC_OPERATION_ARTIFACT_REFERENCE_SCHEMA,
    artifactId: value.artifactId,
    operationId: value.operationId,
    resultSchema: value.resultSchema,
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
    mediaType: value.mediaType,
    expiresAt: value.expiresAt,
    ...overrides,
  };
}

function row(value = manifest()) {
  return {
    artifact_id: value.artifactId,
    scope_key: value.scopeKind === "platform" ? "platform" : value.workspaceId,
    workspace_id: value.workspaceId,
    authority_id: value.authorityId,
    operation_id: value.operationId,
    result_schema: value.resultSchema,
    object_key: value.objectKey,
    sha256: value.sha256,
    size_bytes: BigInt(value.sizeBytes),
    media_type: value.mediaType,
    privacy_class: value.privacyClass,
    source_digest: value.sourceDigest,
    created_at: new Date(value.createdAt),
    expires_at: new Date(value.expiresAt),
    replay: false,
  };
}

function workspaceDatabase(handler: (query: Prisma.Sql) => Promise<unknown>): {
  readonly prisma: PrismaService;
  readonly withWorkspace: ReturnType<typeof vi.fn>;
  readonly queryRaw: ReturnType<typeof vi.fn>;
} {
  const queryRaw = vi.fn(handler);
  const transaction = { $queryRaw: queryRaw };
  const withWorkspace = vi.fn(async (_workspaceId, callback) =>
    callback(transaction),
  );
  return {
    prisma: { withWorkspace } as unknown as PrismaService,
    withWorkspace,
    queryRaw,
  };
}

function platformDatabase(handler: (query: Prisma.Sql) => Promise<unknown>): {
  readonly database: PrismaClient;
  readonly queryRaw: ReturnType<typeof vi.fn>;
} {
  const queryRaw = vi.fn(handler);
  const transaction = {
    $executeRawUnsafe: vi.fn(async () => 0),
    $queryRaw: queryRaw,
  };
  return {
    database: {
      $transaction: vi.fn(async (callback) => callback(transaction)),
    } as unknown as PrismaClient,
    queryRaw,
  };
}

function expectStableInvalid(error: unknown): boolean {
  expect(error).toBeInstanceOf(GenericOperationArtifactError);
  expect(error).toMatchObject({
    name: "GenericOperationArtifactError",
    code: "GENERIC_OPERATION_ARTIFACT_INVALID",
    message: "GENERIC_OPERATION_ARTIFACT_INVALID",
  });
  return true;
}

describe("GenericOperationArtifactRepository", () => {
  it("appends a closed workspace manifest with parameterized SQL and returns an immutable snapshot", async () => {
    const database = workspaceDatabase(async () => [row()]);
    const repository = new GenericOperationArtifactRepository(database.prisma);
    const input = manifest();

    const stored = await repository.appendManifest(input);

    expect(stored).toEqual(manifest());
    expect(Object.isFrozen(stored)).toBe(true);
    expect(database.withWorkspace).toHaveBeenCalledWith(
      WORKSPACE_ID,
      expect.any(Function),
      { maxWait: 1_000, timeout: 2_500 },
    );
    const query = database.queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(query.strings.join("")).toContain(
      "append_workspace_generic_operation_artifact_v1",
    );
    expect(query.values).toEqual([
      WORKSPACE_ID,
      ARTIFACT_ID,
      AUTHORITY_ID,
      OPERATION_ID,
      "http-get/v1",
      contentAddressedObjectKey(SHA256),
      SHA256,
      1048576n,
      "text/html",
      "CONFIDENTIAL_TENANT",
      "cd".padEnd(64, "0"),
      new Date("2026-08-21T01:02:03.004Z"),
      new Date("2026-08-22T01:02:03.004Z"),
    ]);
    expect(query.values).not.toEqual(
      expect.arrayContaining([
        "body",
        "authorization",
        "prompt",
        "token",
        "email",
      ]),
    );
  });

  it("finds an exact workspace reference only with the supplied authority binding", async () => {
    const database = workspaceDatabase(async () => [row()]);
    const repository = new GenericOperationArtifactRepository(database.prisma);

    await expect(
      repository.findExact({
        scopeKind: "workspace",
        workspaceId: WORKSPACE_ID,
        authorityId: AUTHORITY_ID,
        reference: reference(),
      }),
    ).resolves.toEqual(manifest());

    const query = database.queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(query.strings.join("")).toContain(
      "find_exact_workspace_generic_operation_artifact_v1",
    );
    expect(query.values).toEqual([
      WORKSPACE_ID,
      ARTIFACT_ID,
      AUTHORITY_ID,
      OPERATION_ID,
      "http-get/v1",
      SHA256,
      1048576n,
      "text/html",
      new Date("2026-08-22T01:02:03.004Z"),
    ]);
  });

  it("returns the same indistinguishable null for an absent or cross-workspace operation", async () => {
    const database = workspaceDatabase(async () => []);
    const repository = new GenericOperationArtifactRepository(database.prisma);

    await expect(
      repository.findByOperation({
        scopeKind: "workspace",
        workspaceId: WORKSPACE_ID,
        authorityId: AUTHORITY_ID,
        operationId: OPERATION_ID,
        resultSchema: "http-get/v1",
      }),
    ).resolves.toBeNull();

    const query = database.queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(query.strings.join("")).toContain(
      "find_workspace_generic_operation_artifact_by_operation_v1",
    );
    expect(query.values).toEqual([
      WORKSPACE_ID,
      AUTHORITY_ID,
      OPERATION_ID,
      "http-get/v1",
    ]);
  });

  it("uses only the fixed platform writer connection for platform append/read", async () => {
    const workspace = workspaceDatabase(async () => {
      throw new Error("workspace database must not be used");
    });
    const value = manifest({ scopeKind: "platform", workspaceId: null });
    const platform = platformDatabase(async (query) => {
      if (query.strings.join("").includes("session_user")) {
        return [
          {
            sessionUser: "artifact_platform_test",
            currentUser: "artifact_platform_test",
            canLogin: true,
            superuser: false,
            bypassRls: false,
            createDb: false,
            createRole: false,
            replication: false,
            inherit: true,
            memberships: ["execution_budget_platform_writer"],
          },
        ];
      }
      return [row(value)];
    });
    const repository = new GenericOperationArtifactRepository(
      workspace.prisma,
      platform.database,
    );

    await expect(repository.appendManifest(value)).resolves.toEqual(value);
    await expect(
      repository.findByOperation({
        scopeKind: "platform",
        workspaceId: null,
        authorityId: AUTHORITY_ID,
        operationId: OPERATION_ID,
        resultSchema: "http-get/v1",
      }),
    ).resolves.toEqual(value);

    expect(workspace.withWorkspace).not.toHaveBeenCalled();
    expect(
      platform.queryRaw.mock.calls.some(([query]) =>
        (query as Prisma.Sql).strings
          .join("")
          .includes("append_platform_generic_operation_artifact_v1"),
      ),
    ).toBe(true);
    expect(
      platform.queryRaw.mock.calls.some(([query]) =>
        (query as Prisma.Sql).strings
          .join("")
          .includes("find_platform_generic_operation_artifact_by_operation_v1"),
      ),
    ).toBe(true);
  });

  it("fails closed when platform scope has no fixed-role database", async () => {
    const database = workspaceDatabase(async () => [row()]);
    const repository = new GenericOperationArtifactRepository(database.prisma);

    await expect(
      repository.appendManifest(
        manifest({ scopeKind: "platform", workspaceId: null }),
      ),
    ).rejects.toSatisfy(expectStableInvalid);
    expect(database.withWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    ["extra body field", { body: "must-not-enter-manifest" }],
    ["caller-controlled object key", { objectKey: "caller-controlled" }],
    ["non-canonical size", { sizeBytes: "01" }],
    ["negative size", { sizeBytes: "-1" }],
    ["invalid media type", { mediaType: "text/html; charset=utf-8" }],
    ["invalid privacy class", { privacyClass: "PRIVATE" as never }],
    ["invalid source digest", { sourceDigest: "secret-body" }],
    ["workspace without workspace id", { workspaceId: null }],
    [
      "platform with workspace id",
      { scopeKind: "platform" as const, workspaceId: WORKSPACE_ID },
    ],
    ["non-canonical timestamp", { createdAt: "2026-08-21T01:02:03Z" }],
    ["non-positive lifetime", { expiresAt: "2026-08-21T01:02:03.004Z" }],
  ])("rejects %s before a database call", async (_name, overrides) => {
    const database = workspaceDatabase(async () => [row()]);
    const repository = new GenericOperationArtifactRepository(database.prisma);

    await expect(
      repository.appendManifest(manifest(overrides)),
    ).rejects.toSatisfy(expectStableInvalid);
    expect(database.withWorkspace).not.toHaveBeenCalled();
  });

  it("maps database diagnostics to one bounded error without leaking raw details", async () => {
    const database = workspaceDatabase(async () => {
      throw new Error(
        "duplicate digest for https://private.example Authorization bearer-secret",
      );
    });
    const repository = new GenericOperationArtifactRepository(database.prisma);

    await expect(repository.appendManifest(manifest())).rejects.toSatisfy(
      expectStableInvalid,
    );
  });

  it("rejects malformed or extra database rows instead of returning partial metadata", async () => {
    const database = workspaceDatabase(async () => [
      { ...row(), body: "forbidden" },
    ]);
    const repository = new GenericOperationArtifactRepository(database.prisma);

    await expect(repository.appendManifest(manifest())).rejects.toSatisfy(
      expectStableInvalid,
    );
  });

  it("rejects a well-formed row outside the requested authority binding", async () => {
    const database = workspaceDatabase(async () => [
      row(manifest({ authorityId: "04599a0f-fd8b-49cf-8eaf-fdfcccbdd518" })),
    ]);
    const repository = new GenericOperationArtifactRepository(database.prisma);

    await expect(
      repository.findByOperation({
        scopeKind: "workspace",
        workspaceId: WORKSPACE_ID,
        authorityId: AUTHORITY_ID,
        operationId: OPERATION_ID,
        resultSchema: "http-get/v1",
      }),
    ).rejects.toSatisfy(expectStableInvalid);
  });

  it("rejects a well-formed append row that differs from the submitted manifest", async () => {
    const database = workspaceDatabase(async () => [
      row(manifest({ privacyClass: "PERSONAL_DATA" })),
    ]);
    const repository = new GenericOperationArtifactRepository(database.prisma);

    await expect(repository.appendManifest(manifest())).rejects.toSatisfy(
      expectStableInvalid,
    );
  });
});
