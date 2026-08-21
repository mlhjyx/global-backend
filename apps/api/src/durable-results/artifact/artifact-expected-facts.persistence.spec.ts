import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../../prisma/prisma.service";
import type { BudgetReservation, BudgetStore } from "../../tools/budget-store";
import { contentAddressedObjectKey } from "./artifact-key";
import type { ArtifactExpectedFacts } from "./artifact-expected-facts";
import { GenericOperationArtifactRepository } from "./generic-operation-artifact.repository";
import { GenericOperationArtifactService } from "./generic-operation-artifact.service";
import type { GenericOperationArtifactStore } from "./generic-operation-artifact.store";
import {
  GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
  GENERIC_OPERATION_ARTIFACT_REFERENCE_SCHEMA,
  type GenericOperationArtifactManifest,
  type GenericOperationArtifactReference,
} from "./artifact.types";

const WORKSPACE_ID = "e03abddd-1307-47cb-a731-7e7a786615a0";
const AUTHORITY_ID = "42c863b9-7c7e-4d28-8678-60ef9a20219b";
const OPERATION_ID = "8cf66f2a-1780-453e-8d7d-f70e36cb22a6";
const ARTIFACT_ID = "9c621e96-9ec9-4712-aa51-cbb312d6a8f1";
const SHA256 = "ab".padEnd(64, "0");
const BODY = new TextEncoder().encode("ok");
const EXPECTED_FACTS = Object.freeze({
  status: 200,
  ok: true,
  sanitizedUrl: "https://example.com/final",
  blocked: null,
}) satisfies ArtifactExpectedFacts;

const manifest = Object.freeze({
  schemaVersion: GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
  artifactId: ARTIFACT_ID,
  scopeKind: "workspace",
  workspaceId: WORKSPACE_ID,
  authorityId: AUTHORITY_ID,
  operationId: OPERATION_ID,
  resultSchema: "http-get/v1",
  objectKey: contentAddressedObjectKey(SHA256),
  sha256: SHA256,
  sizeBytes: String(BODY.byteLength),
  mediaType: "text/plain",
  privacyClass: "CONFIDENTIAL_TENANT",
  sourceDigest: null,
  createdAt: "2036-08-21T01:02:03.004Z",
  expiresAt: "2036-08-22T01:02:03.004Z",
}) satisfies GenericOperationArtifactManifest;

const reference = Object.freeze({
  schemaVersion: GENERIC_OPERATION_ARTIFACT_REFERENCE_SCHEMA,
  artifactId: ARTIFACT_ID,
  operationId: OPERATION_ID,
  resultSchema: manifest.resultSchema,
  sha256: SHA256,
  sizeBytes: manifest.sizeBytes,
  mediaType: manifest.mediaType,
  expiresAt: manifest.expiresAt,
}) satisfies GenericOperationArtifactReference;

function row(
  facts: {
    expected_http_status?: number | null;
    expected_http_ok?: boolean | null;
    expected_sanitized_url?: string | null;
    expected_content_hash?: string | null;
    expected_blocked_code?: string | null;
    expected_robots_blocked?: boolean | null;
  } = {},
) {
  return {
    artifact_id: ARTIFACT_ID,
    scope_key: WORKSPACE_ID,
    workspace_id: WORKSPACE_ID,
    authority_id: AUTHORITY_ID,
    operation_id: OPERATION_ID,
    result_schema: manifest.resultSchema,
    object_key: manifest.objectKey,
    sha256: SHA256,
    size_bytes: BigInt(BODY.byteLength),
    media_type: manifest.mediaType,
    privacy_class: manifest.privacyClass,
    source_digest: null,
    created_at: new Date(manifest.createdAt),
    expires_at: new Date(manifest.expiresAt),
    expected_http_status: Object.hasOwn(facts, "expected_http_status")
      ? facts.expected_http_status
      : 200,
    expected_http_ok: Object.hasOwn(facts, "expected_http_ok")
      ? facts.expected_http_ok
      : true,
    expected_sanitized_url: Object.hasOwn(facts, "expected_sanitized_url")
      ? facts.expected_sanitized_url
      : "https://example.com/final",
    expected_content_hash: facts.expected_content_hash ?? null,
    expected_blocked_code: facts.expected_blocked_code ?? null,
    expected_robots_blocked: facts.expected_robots_blocked ?? null,
    replay: false,
  };
}

function repositoryWithRows(rows: readonly unknown[]) {
  const queryRaw = vi.fn(async () => rows);
  const prisma = {
    withWorkspace: vi.fn(async (_workspaceId, callback) =>
      callback({ $queryRaw: queryRaw }),
    ),
  } as unknown as PrismaService;
  return {
    repository: new GenericOperationArtifactRepository(prisma),
    queryRaw,
  };
}

describe("artifact expected-facts persistence", () => {
  it("appends one exact workspace manifest and expected-facts snapshot atomically", async () => {
    const database = repositoryWithRows([row()]);

    await expect(
      database.repository.appendManifest(manifest, EXPECTED_FACTS),
    ).resolves.toEqual({ manifest, expectedFacts: EXPECTED_FACTS });

    const query = database.queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(query.strings.join("")).toContain(
      "append_workspace_generic_operation_artifact_v2",
    );
    expect(query.values.slice(-6)).toEqual([
      200,
      true,
      "https://example.com/final",
      null,
      null,
      null,
    ]);
    expect(query.values).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("authorization"),
        expect.stringContaining("prompt"),
        expect.stringContaining("token"),
        expect.stringContaining("email"),
      ]),
    );
  });

  it("returns expected facts with exact reads and fails closed on historical missing facts", async () => {
    const current = repositoryWithRows([row()]);
    await expect(
      current.repository.findExact({
        scopeKind: "workspace",
        workspaceId: WORKSPACE_ID,
        authorityId: AUTHORITY_ID,
        reference,
      }),
    ).resolves.toEqual({ manifest, expectedFacts: EXPECTED_FACTS });

    const historical = repositoryWithRows([
      row({
        expected_http_status: null,
        expected_http_ok: null,
        expected_sanitized_url: null,
      }),
    ]);
    await expect(
      historical.repository.findExact({
        scopeKind: "workspace",
        workspaceId: WORKSPACE_ID,
        authorityId: AUTHORITY_ID,
        reference,
      }),
    ).rejects.toMatchObject({ code: "GENERIC_OPERATION_ARTIFACT_INVALID" });
  });

  it("returns Task 4 verified bytes with only database-loaded expected facts", async () => {
    const repository = {
      findExact: vi.fn(async () => ({
        manifest,
        expectedFacts: EXPECTED_FACTS,
      })),
    } as unknown as GenericOperationArtifactRepository;
    const store = {
      inspect: vi.fn(async () => ({
        objectKey: manifest.objectKey,
        sha256: manifest.sha256,
        sizeBytes: manifest.sizeBytes,
        mediaType: manifest.mediaType,
        resultSchema: manifest.resultSchema,
        privacyClass: manifest.privacyClass,
      })),
      read: vi.fn(async () =>
        (async function* () {
          yield BODY;
        })(),
      ),
    } as unknown as GenericOperationArtifactStore;
    const service = new GenericOperationArtifactService(
      repository,
      store,
      {} as BudgetStore,
      { now: () => new Date("2036-08-21T02:00:00.000Z") },
    );

    const verified = await service.readVerified({
      scopeKind: "workspace",
      workspaceId: WORKSPACE_ID,
      authorityId: AUTHORITY_ID,
      reference,
    });

    expect(verified.manifest).toEqual(manifest);
    expect(verified.expectedFacts).toEqual(EXPECTED_FACTS);
    expect(Object.isFrozen(verified.expectedFacts)).toBe(true);
  });

  it("passes expected facts as typed scalar parameters through Task 4 settlement", async () => {
    const queries: Prisma.Sql[] = [];
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, callback) =>
        callback({
          $queryRaw: vi.fn(async (query: Prisma.Sql) => {
            queries.push(query);
            return [
              {
                charged_cents: 17n,
                observed_cents: 13n,
                cap_variance: false,
                status: "SETTLED",
                replay: false,
              },
            ];
          }),
        }),
      ),
    } as unknown as PrismaService;
    const { PostgresBudgetStore } = await import("../../tools/budget-store");
    const budgetStore = new PostgresBudgetStore(prisma);
    const reservation = {
      workspaceId: WORKSPACE_ID,
      accountKey: "artifact-account",
      operationId: OPERATION_ID,
      estimatedCents: 17,
      replay: false,
    } satisfies BudgetReservation;

    await budgetStore.settleArtifactManifest(reservation, 13, {
      manifest,
      expectedFacts: EXPECTED_FACTS,
    });

    expect(queries[0]?.strings.join("")).toContain(
      "settle_tool_budget_artifact_manifest_v3",
    );
    expect(queries[0]?.values.slice(-6)).toEqual([
      200,
      true,
      "https://example.com/final",
      null,
      null,
      null,
    ]);
    expect(queries[0]?.values[3]).toBe(JSON.stringify(manifest));
    expect(queries[0]?.values[3]).not.toContain("expectedFacts");
  });
});
