import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../prisma/prisma.service";
import { PostgresBudgetStore } from "./budget-store";
import {
  GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
  type GenericOperationArtifactManifest,
  type GenericOperationArtifactReference,
} from "../durable-results/artifact/artifact.types";

const TEST_WORKSPACE_ID = "e03abddd-1307-47cb-a731-7e7a786615a0";
const ARTIFACT_REFERENCE: GenericOperationArtifactReference = Object.freeze({
  schemaVersion: "generic-operation-artifact-ref/v1",
  artifactId: "1b3d6096-b924-4bc8-bb4f-8436efb37b07",
  operationId: "42c863b9-7c7e-4d28-8678-60ef9a20219b",
  resultSchema: "http-get/v1",
  sha256: "ab".padEnd(64, "0"),
  sizeBytes: "123",
  mediaType: "text/html",
  expiresAt: "2036-08-22T12:00:00.000Z",
});
const ARTIFACT_MANIFEST: GenericOperationArtifactManifest = Object.freeze({
  schemaVersion: GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA,
  artifactId: ARTIFACT_REFERENCE.artifactId,
  scopeKind: "workspace",
  workspaceId: TEST_WORKSPACE_ID,
  authorityId: "89528818-13ab-4a46-9dfd-6fbcdba6943e",
  operationId: ARTIFACT_REFERENCE.operationId,
  resultSchema: ARTIFACT_REFERENCE.resultSchema,
  objectKey: `generic-operation-results/v1/sha256/${ARTIFACT_REFERENCE.sha256.slice(0, 2)}/${ARTIFACT_REFERENCE.sha256}`,
  sha256: ARTIFACT_REFERENCE.sha256,
  sizeBytes: ARTIFACT_REFERENCE.sizeBytes,
  mediaType: ARTIFACT_REFERENCE.mediaType,
  privacyClass: "CONFIDENTIAL_TENANT",
  sourceDigest: null,
  createdAt: "2036-08-21T12:00:00.000Z",
  expiresAt: ARTIFACT_REFERENCE.expiresAt,
});
const EXPECTED_FACTS = Object.freeze({
  status: 200,
  ok: true,
  sanitizedUrl: "https://example.com/final",
  blocked: null,
});
const ARTIFACT_SNAPSHOT = Object.freeze({
  manifest: ARTIFACT_MANIFEST,
  expectedFacts: EXPECTED_FACTS,
});
const ARTIFACT_RECEIPT_FACTS = Object.freeze({
  usage: Object.freeze({
    currency: "USD" as const,
    unit: "microusd" as const,
    callCount: 1,
    upperBoundMicrousd: "170000",
  }),
  costBasis: "estimated_upper_bound" as const,
});

function unknownRow(manifest = ARTIFACT_MANIFEST) {
  return {
    expected_manifest: manifest,
    expected_http_status: 200,
    expected_http_ok: true,
    expected_sanitized_url: "https://example.com/final",
    expected_content_hash: null,
    expected_blocked_code: null,
    expected_robots_blocked: null,
  };
}

function fakePrisma(rows: unknown[][]): PrismaService {
  const queue = [...rows];
  return {
    withWorkspace: vi.fn(async (_workspaceId, fn) =>
      fn({
        $queryRaw: vi.fn(async () => queue.shift() ?? []),
      } as never),
    ),
  } as unknown as PrismaService;
}

function rawQueryMarkerError(
  marker: string,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("raw query failed", {
    code: "P2010",
    clientVersion: "test",
    meta: { code: "P0001", message: `ERROR: ${marker}` },
  });
}

describe("PostgresBudgetStore artifact recovery", () => {
  it("marks an executed artifact write RESULT_UNKNOWN without releasing its reservation", async () => {
    const queries: Array<{
      strings?: readonly string[];
      values?: readonly unknown[];
    }> = [];
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) =>
        fn({
          $queryRaw: vi.fn(async (query) => {
            queries.push(query);
            return [
              {
                reserved_cents: 17n,
                status: "RESULT_UNKNOWN",
                replay: false,
                recoverable: true,
              },
            ];
          }),
        } as never),
      ),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);
    const reservation = {
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: "artifact-account",
      operationId: ARTIFACT_REFERENCE.operationId,
      estimatedCents: 17,
      replay: false,
    };

    await expect(
      store.markResultUnknown(reservation, ARTIFACT_SNAPSHOT),
    ).resolves.toEqual({
      reservedCents: 17,
      replay: false,
    });
    expect(queries[0]?.strings?.join("")).toContain(
      "mark_tool_budget_result_unknown_v3",
    );
    expect(queries[0]?.values).toEqual([
      TEST_WORKSPACE_ID,
      ARTIFACT_REFERENCE.operationId,
      JSON.stringify(ARTIFACT_MANIFEST),
      200,
      true,
      "https://example.com/final",
      null,
      null,
      null,
    ]);
  });

  it("marks a stage ACK unknown as unrecoverable without fabricating expected facts", async () => {
    const queries: Array<{ values?: readonly unknown[] }> = [];
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) =>
        fn({
          $queryRaw: vi.fn(async (query) => {
            queries.push(query);
            return [
              {
                reserved_cents: 17n,
                status: "RESULT_UNKNOWN",
                replay: false,
                recoverable: false,
              },
            ];
          }),
        } as never),
      ),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);
    const reservation = {
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: "artifact-account",
      operationId: ARTIFACT_REFERENCE.operationId,
      estimatedCents: 17,
      replay: false,
    };

    await expect(store.markResultUnknown(reservation)).resolves.toEqual({
      reservedCents: 17,
      replay: false,
    });
    expect(queries[0]?.values?.at(-1)).toBeNull();
  });

  it("loads only the original database-bound expectation for recovery", async () => {
    const store = new PostgresBudgetStore(fakePrisma([[unknownRow()]]));
    await expect(
      store.loadResultUnknownArtifact(
        {
          workspaceId: TEST_WORKSPACE_ID,
          accountKey: "artifact-account",
          operationId: ARTIFACT_REFERENCE.operationId,
          estimatedCents: 17,
          replay: false,
        },
        ARTIFACT_MANIFEST.authorityId,
      ),
    ).resolves.toEqual(ARTIFACT_SNAPSHOT);
  });

  it("rejects malformed recovery identity and mismatched durable bindings", async () => {
    const invalidPrisma = fakePrisma([]);
    const invalidStore = new PostgresBudgetStore(invalidPrisma);
    const reservation = {
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: "artifact-account",
      operationId: ARTIFACT_REFERENCE.operationId,
      estimatedCents: 17,
      replay: true,
    };
    await expect(
      invalidStore.loadResultUnknownArtifact(reservation, "not-a-uuid"),
    ).rejects.toMatchObject({ code: "GENERIC_OPERATION_ARTIFACT_INVALID" });
    expect(invalidPrisma.withWorkspace).not.toHaveBeenCalled();

    const mismatchStore = new PostgresBudgetStore(fakePrisma([[unknownRow()]]));
    await expect(
      mismatchStore.loadResultUnknownArtifact(
        reservation,
        "42c863b9-7c7e-4d28-8678-60ef9a20219b",
      ),
    ).rejects.toMatchObject({ code: "GENERIC_OPERATION_ARTIFACT_INVALID" });
  });

  it("fails closed when unknown recovery returns no exact database row", async () => {
    const store = new PostgresBudgetStore(fakePrisma([[]]));
    await expect(
      store.loadResultUnknownArtifact(
        {
          workspaceId: TEST_WORKSPACE_ID,
          accountKey: "artifact-account",
          operationId: ARTIFACT_REFERENCE.operationId,
          estimatedCents: 17,
          replay: true,
        },
        ARTIFACT_MANIFEST.authorityId,
      ),
    ).rejects.toMatchObject({
      code: "BUDGET_STORE_UNAVAILABLE",
    });
  });

  it("atomically appends a manifest and settles only its exact closed reference", async () => {
    const queries: Array<{
      strings?: readonly string[];
      values?: readonly unknown[];
    }> = [];
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) =>
        fn({
          $queryRaw: vi.fn(async (query) => {
            queries.push(query);
            return [
              {
                charged_cents: 17n,
                observed_cents: 13n,
                cap_variance: false,
                status: "SETTLED",
                replay: false,
                reserved_cents: 17n,
                operation_id: ARTIFACT_REFERENCE.operationId,
                operation_key: "artifact-operation",
                account_id: "5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0",
                authority_id: ARTIFACT_MANIFEST.authorityId,
                result_schema_version: ARTIFACT_REFERENCE.schemaVersion,
                result_schema: ARTIFACT_REFERENCE.resultSchema,
                result_digest: ARTIFACT_REFERENCE.sha256,
                result_json: ARTIFACT_REFERENCE,
                receipt_usage: ARTIFACT_RECEIPT_FACTS.usage,
                receipt_cost_basis: ARTIFACT_RECEIPT_FACTS.costBasis,
              },
            ];
          }),
        } as never),
      ),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);

    await expect(
      store.settleArtifactManifest(
        {
          workspaceId: TEST_WORKSPACE_ID,
          accountKey: "artifact-account",
          operationId: ARTIFACT_REFERENCE.operationId,
          estimatedCents: 17,
          replay: false,
        },
        13,
        ARTIFACT_SNAPSHOT,
        ARTIFACT_RECEIPT_FACTS,
      ),
    ).resolves.toMatchObject({
      chargedCents: 17,
      observedCents: 13,
      capVariance: false,
      replay: false,
      receipt: {
        resultStrategy: "artifact_reference",
        resultSchema: "http-get/v1",
        artifactId: ARTIFACT_REFERENCE.artifactId,
      },
    });
    expect(queries[0]?.strings?.join("")).toContain(
      "settle_tool_budget_artifact_manifest_with_receipt_v1",
    );
    expect(queries[0]?.values).toEqual([
      TEST_WORKSPACE_ID,
      ARTIFACT_REFERENCE.operationId,
      13n,
      JSON.stringify(ARTIFACT_MANIFEST),
      200,
      true,
      "https://example.com/final",
      null,
      null,
      null,
      JSON.stringify(ARTIFACT_RECEIPT_FACTS.usage),
      ARTIFACT_RECEIPT_FACTS.costBasis,
    ]);
  });

  it("rejects an open or caller-extended artifact reference before persistence", async () => {
    const prisma = fakePrisma([]);
    const store = new PostgresBudgetStore(prisma);

    await expect(
      store.settleArtifactManifest(
        {
          workspaceId: TEST_WORKSPACE_ID,
          accountKey: "artifact-account",
          operationId: ARTIFACT_REFERENCE.operationId,
          estimatedCents: 17,
          replay: false,
        },
        13,
        {
          manifest: {
            ...ARTIFACT_MANIFEST,
            body: "caller-controlled",
          } as unknown as GenericOperationArtifactManifest,
          expectedFacts: EXPECTED_FACTS,
        },
        ARTIFACT_RECEIPT_FACTS,
      ),
    ).rejects.toMatchObject({
      code: "GENERIC_OPERATION_ARTIFACT_INVALID",
    });
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
  });

  it("maps trusted database artifact rejections to the one bounded artifact error", async () => {
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) =>
        fn({
          $queryRaw: vi.fn(async () => {
            throw rawQueryMarkerError("GENERIC_OPERATION_ARTIFACT_INVALID");
          }),
        } as never),
      ),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);
    const reservation = {
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: "artifact-account",
      operationId: ARTIFACT_REFERENCE.operationId,
      estimatedCents: 17,
      replay: false,
    };

    await expect(
      store.markResultUnknown(reservation, ARTIFACT_SNAPSHOT),
    ).rejects.toMatchObject({
      code: "GENERIC_OPERATION_ARTIFACT_INVALID",
    });
    await expect(
      store.settleArtifactManifest(
        reservation, 13, ARTIFACT_SNAPSHOT, ARTIFACT_RECEIPT_FACTS,
      ),
    ).rejects.toMatchObject({
      code: "GENERIC_OPERATION_ARTIFACT_INVALID",
    });
    await expect(
      store.loadResultUnknownArtifact(
        reservation,
        ARTIFACT_MANIFEST.authorityId,
      ),
    ).rejects.toMatchObject({
      code: "GENERIC_OPERATION_ARTIFACT_INVALID",
    });
  });

  it("redacts untrusted database details from artifact transitions", async () => {
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) =>
        fn({
          $queryRaw: vi.fn(async () => {
            throw new Error("host password and raw SQL detail");
          }),
        } as never),
      ),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);
    const reservation = {
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: "artifact-account",
      operationId: ARTIFACT_REFERENCE.operationId,
      estimatedCents: 17,
      replay: false,
    };

    const results = await Promise.allSettled([
      store.markResultUnknown(reservation, ARTIFACT_SNAPSHOT),
      store.settleArtifactManifest(
        reservation, 13, ARTIFACT_SNAPSHOT, ARTIFACT_RECEIPT_FACTS,
      ),
      store.loadResultUnknownArtifact(
        reservation,
        ARTIFACT_MANIFEST.authorityId,
      ),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({
          code: "BUDGET_STORE_UNAVAILABLE",
        });
        expect(JSON.stringify(result.reason)).not.toContain("password");
      }
    }
  });
});
