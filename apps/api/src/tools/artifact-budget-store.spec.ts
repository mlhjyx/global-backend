import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
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
const ARTIFACT_DOMAIN_ACK = Object.freeze({
  producerId: "http.get",
  domainAckKey: ARTIFACT_REFERENCE.artifactId,
  domainRevision: ARTIFACT_REFERENCE.sha256,
});

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonical(record[key])}`
  )).join(",")}}`;
}

function artifactAck(values: readonly unknown[]) {
  const domainAckKey = String(values[4]);
  const domainRevision = String(values[5]);
  const material = {
    operationId: ARTIFACT_REFERENCE.operationId,
    consumer: "GenericHttpArtifactConsumer",
    domainAggregateType: "ExternalArtifact",
    domainAckKey,
    domainRevision,
    resultDigest: ARTIFACT_REFERENCE.sha256,
  };
  return {
    schemaVersion: "domain-ack/v1",
    ackId: createHash("sha256").update(canonical(material)).digest("hex"),
    operationId: ARTIFACT_REFERENCE.operationId,
    operationKey: "artifact-operation",
    authorityId: ARTIFACT_MANIFEST.authorityId,
    accountId: "5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0",
    scopeKey: TEST_WORKSPACE_ID,
    consumer: material.consumer,
    domainAggregateType: material.domainAggregateType,
    domainAckKey,
    domainRevision,
    resultStrategy: "artifact_reference",
    resultSchema: ARTIFACT_REFERENCE.resultSchema,
    resultDigest: ARTIFACT_REFERENCE.sha256,
    artifactId: ARTIFACT_REFERENCE.artifactId,
    usage: ARTIFACT_RECEIPT_FACTS.usage,
    costBasis: ARTIFACT_RECEIPT_FACTS.costBasis,
  };
}

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
        $queryRaw: vi.fn(async (query: { strings?: readonly string[]; values?: readonly unknown[] }) =>
          query.strings?.join("").includes("apply_execution_domain_ack_v1")
            ? [{ status: "APPLIED", ack_json: artifactAck(query.values ?? []) }]
            : queue.shift() ?? []),
      } as never),
    ),
  } as unknown as PrismaService;
}

function rawQueryMarkerError(
  marker: string,
  options?: { prismaCode?: string; sqlState?: string; metaMessage?: string },
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("raw query failed", {
    code: options?.prismaCode ?? "P2010",
    clientVersion: "test",
    meta: {
      code: options?.sqlState ?? "P0001",
      message: options?.metaMessage ?? `ERROR: ${marker}`,
    },
  });
}

describe("PostgresBudgetStore artifact recovery", () => {
  it("returns the closed artifact-reference replay union with the exact ledger receipt", async () => {
    const store = new PostgresBudgetStore(fakePrisma([[
      {
        kind: "REPLAY",
        operation_id: ARTIFACT_REFERENCE.operationId,
        operation_key: "artifact-operation",
        reserved_microusd: 170_000n,
        remaining_microusd: 830_000n,
        charged_microusd: 170_000n,
        observed_microusd: 130_000n,
        status: "SETTLED",
        account_id: "5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0",
        authority_id: ARTIFACT_MANIFEST.authorityId,
        result_schema_version: ARTIFACT_REFERENCE.schemaVersion,
        result_schema: ARTIFACT_REFERENCE.resultSchema,
        result_digest: ARTIFACT_REFERENCE.sha256,
        result_json: ARTIFACT_REFERENCE,
        receipt_usage: ARTIFACT_RECEIPT_FACTS.usage,
        receipt_cost_basis: ARTIFACT_RECEIPT_FACTS.costBasis,
      },
    ]]));

    await expect(store.reserve({
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: "artifact-account",
      operationKey: "artifact-operation",
      estimatedMicrousd: 170_000n,
    })).resolves.toMatchObject({
      replay: true,
      replayResult: {
        resultStrategy: "artifact_reference",
        reference: ARTIFACT_REFERENCE,
      },
      receipt: {
        resultStrategy: "artifact_reference",
        artifactId: ARTIFACT_REFERENCE.artifactId,
        resultDigest: ARTIFACT_REFERENCE.sha256,
      },
    });
  });

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
                reserved_microusd: 170_000n,
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
      estimatedMicrousd: 170_000n,
      replay: false,
    };

    await expect(
      store.markResultUnknown(reservation, ARTIFACT_SNAPSHOT),
    ).resolves.toEqual({
      reservedMicrousd: 170_000n,
      replay: false,
    });
    expect(queries[0]?.strings?.join("")).toContain(
      "mark_tool_budget_result_unknown_v5",
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
                reserved_microusd: 170_000n,
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
      estimatedMicrousd: 170_000n,
      replay: false,
    };

    await expect(store.markResultUnknown(reservation)).resolves.toEqual({
      reservedMicrousd: 170_000n,
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
          estimatedMicrousd: 170_000n,
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
      estimatedMicrousd: 170_000n,
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
          estimatedMicrousd: 170_000n,
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
            if (queries.length === 3) {
              return [{ status: "APPLIED", ack_json: artifactAck(query.values ?? []) }];
            }
            return [
              {
                charged_microusd: 170_000n,
                observed_microusd: 130_000n,
                cap_variance: false,
                status: "SETTLED",
                replay: false,
                reserved_microusd: 170_000n,
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
          estimatedMicrousd: 170_000n,
          replay: false,
        },
        130_000n,
        ARTIFACT_SNAPSHOT,
        ARTIFACT_RECEIPT_FACTS,
        ARTIFACT_DOMAIN_ACK,
      ),
    ).resolves.toMatchObject({
      chargedMicrousd: 170_000n,
      observedMicrousd: 130_000n,
      capVariance: false,
      replay: false,
      receipt: {
        resultStrategy: "artifact_reference",
        resultSchema: "http-get/v1",
        artifactId: ARTIFACT_REFERENCE.artifactId,
      },
    });
    expect(queries[0]?.strings?.join("")).toContain(
      "settle_tool_budget_artifact_manifest_with_receipt_v2",
    );
    expect(queries[0]?.values).toEqual([
      TEST_WORKSPACE_ID,
      ARTIFACT_REFERENCE.operationId,
      130_000n,
      JSON.stringify(ARTIFACT_MANIFEST),
      200,
      true,
      "https://example.com/final",
      null,
      null,
      null,
      JSON.stringify(ARTIFACT_RECEIPT_FACTS.usage),
      ARTIFACT_RECEIPT_FACTS.costBasis,
      null,
      null,
    ]);
    expect(queries[1]?.strings?.join("")).toContain(
      "lock_execution_domain_ack_authority_first_v1",
    );
    expect(queries[2]?.strings?.join("")).toContain(
      "apply_execution_domain_ack_v1",
    );
  });

  it("rejects artifact receipts when the locked row omits or drifts from the submitted manifest reference", async () => {
    const common = {
      charged_microusd: 170_000n,
      observed_microusd: 130_000n,
      cap_variance: false,
      status: "SETTLED",
      replay: false,
      reserved_microusd: 170_000n,
      operation_id: ARTIFACT_REFERENCE.operationId,
      operation_key: "artifact-operation",
      account_id: "5c83a0c6-47af-48d3-a663-7cb4bb8ef9d0",
      authority_id: ARTIFACT_MANIFEST.authorityId,
      receipt_usage: ARTIFACT_RECEIPT_FACTS.usage,
      receipt_cost_basis: ARTIFACT_RECEIPT_FACTS.costBasis,
    };
    const reservation = {
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: "artifact-account",
      operationId: ARTIFACT_REFERENCE.operationId,
      estimatedMicrousd: 170_000n,
      replay: false,
    };

    await expect(new PostgresBudgetStore(fakePrisma([[
      common,
    ]])).settleArtifactManifest(
      reservation,
       130_000n,
      ARTIFACT_SNAPSHOT,
      ARTIFACT_RECEIPT_FACTS,
      ARTIFACT_DOMAIN_ACK,
    )).rejects.toThrow("DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH");

    await expect(new PostgresBudgetStore(fakePrisma([[
      {
        ...common,
        result_schema_version: ARTIFACT_REFERENCE.schemaVersion,
        result_schema: ARTIFACT_REFERENCE.resultSchema,
        result_digest: "cd".padEnd(64, "0"),
        result_json: ARTIFACT_REFERENCE,
      },
    ]])).settleArtifactManifest(
      reservation,
       130_000n,
      ARTIFACT_SNAPSHOT,
      ARTIFACT_RECEIPT_FACTS,
      ARTIFACT_DOMAIN_ACK,
    )).rejects.toThrow("DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH");
  });

  it("fails closed for locked artifact-reference bytes, receipt metadata, and parser drift", async () => {
    const common = {
      charged_microusd: 170_000n,
      observed_microusd: 130_000n,
      cap_variance: false,
      status: "SETTLED",
      replay: false,
      reserved_microusd: 170_000n,
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
    };
    const reservation = {
      workspaceId: TEST_WORKSPACE_ID,
      accountKey: "artifact-account",
      operationId: ARTIFACT_REFERENCE.operationId,
      estimatedMicrousd: 170_000n,
      replay: false,
    };
    const settle = (row: Record<string, unknown>) => new PostgresBudgetStore(
      fakePrisma([[row]]),
    ).settleArtifactManifest(
      reservation,
       130_000n,
      ARTIFACT_SNAPSHOT,
      ARTIFACT_RECEIPT_FACTS,
      ARTIFACT_DOMAIN_ACK,
    );

    await expect(settle({
      ...common,
      result_json: { ...ARTIFACT_REFERENCE, mediaType: "application/json" },
    })).rejects.toThrow("DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH");
    await expect(settle({
      ...common,
      receipt_usage: undefined,
    })).rejects.toThrow("DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH");
    await expect(settle({
      ...common,
      result_json: { malformed: true },
    })).rejects.toThrow("DURABLE_EXECUTION_RECEIPT_LEDGER_MISMATCH");
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
          estimatedMicrousd: 170_000n,
          replay: false,
        },
         130_000n,
        {
          manifest: {
            ...ARTIFACT_MANIFEST,
            body: "caller-controlled",
          } as unknown as GenericOperationArtifactManifest,
          expectedFacts: EXPECTED_FACTS,
        },
        ARTIFACT_RECEIPT_FACTS,
        ARTIFACT_DOMAIN_ACK,
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
      estimatedMicrousd: 170_000n,
      replay: false,
    };

    await expect(
      store.markResultUnknown(reservation, ARTIFACT_SNAPSHOT),
    ).rejects.toMatchObject({
      code: "GENERIC_OPERATION_ARTIFACT_INVALID",
    });
    await expect(
      store.settleArtifactManifest(
        reservation, 130_000n, ARTIFACT_SNAPSHOT, ARTIFACT_RECEIPT_FACTS,
        ARTIFACT_DOMAIN_ACK,
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

  it("never invokes accessors while deciding whether a Prisma rejection is trusted", async () => {
    let metaGetterCalls = 0;
    const hostile = rawQueryMarkerError("GENERIC_OPERATION_ARTIFACT_INVALID");
    Object.defineProperty(hostile, "meta", {
      configurable: true,
      enumerable: true,
      get: () => {
        metaGetterCalls += 1;
        return {
          code: "P0001",
          message: "ERROR: GENERIC_OPERATION_ARTIFACT_INVALID",
        };
      },
    });
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) =>
        fn({
          $queryRaw: vi.fn(async () => {
            throw hostile;
          }),
        } as never),
      ),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);

    await expect(store.settleArtifactManifest(
      {
        workspaceId: TEST_WORKSPACE_ID,
        accountKey: "artifact-account",
        operationId: ARTIFACT_REFERENCE.operationId,
        estimatedMicrousd: 170_000n,
        replay: false,
      },
      130_000n,
      ARTIFACT_SNAPSHOT,
      ARTIFACT_RECEIPT_FACTS,
      ARTIFACT_DOMAIN_ACK,
    )).rejects.toMatchObject({ code: "BUDGET_STORE_UNAVAILABLE" });
    expect(metaGetterCalls).toBe(0);
  });

  it.each([
    rawQueryMarkerError("GENERIC_OPERATION_ARTIFACT_INVALID", {
      metaMessage: "ERROR: GENERIC_OPERATION_ARTIFACT_INVALID; raw SQL detail",
    }),
    rawQueryMarkerError("GENERIC_OPERATION_ARTIFACT_INVALID", {
      prismaCode: "P2000",
    }),
    rawQueryMarkerError("SOME_OTHER_DATABASE_MARKER"),
  ])("redacts non-whitelisted Prisma artifact failures", async (failure) => {
    const prisma = {
      withWorkspace: vi.fn(async (_workspaceId, fn) =>
        fn({
          $queryRaw: vi.fn(async () => {
            throw failure;
          }),
        } as never),
      ),
    } as unknown as PrismaService;
    const store = new PostgresBudgetStore(prisma);

    const result = store.settleArtifactManifest(
      {
        workspaceId: TEST_WORKSPACE_ID,
        accountKey: "artifact-account",
        operationId: ARTIFACT_REFERENCE.operationId,
        estimatedMicrousd: 170_000n,
        replay: false,
      },
      130_000n,
      ARTIFACT_SNAPSHOT,
      ARTIFACT_RECEIPT_FACTS,
      ARTIFACT_DOMAIN_ACK,
    );
    await expect(result).rejects.toMatchObject({
      code: "BUDGET_STORE_UNAVAILABLE",
    });
    await expect(result).rejects.not.toBe(failure);
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
      estimatedMicrousd: 170_000n,
      replay: false,
    };

    const results = await Promise.allSettled([
      store.markResultUnknown(reservation, ARTIFACT_SNAPSHOT),
      store.settleArtifactManifest(
        reservation, 130_000n, ARTIFACT_SNAPSHOT, ARTIFACT_RECEIPT_FACTS,
        ARTIFACT_DOMAIN_ACK,
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
