import { describe, expect, it, vi } from "vitest";
import {
  resolveRawSourceBatchByIndex,
  type PreparedRawSourceRow,
} from "./raw-source-ingestion";
import { persistPreparedRawSourceRecord } from "./raw-source-writer";

const DB_HASH = "b".repeat(64);

function preparedRow(): PreparedRawSourceRow {
  return {
    externalId: "public.example",
    payload: {
      externalId: "public.example",
      name: "General Dynamics",
      domain: "public.example",
      attributes: {
        products: ["industrial pump"],
        keywords: ["industrial"],
        extraction_evidence_digest: "a".repeat(64),
        extraction_confidence: 1e-7,
        source_class: "public_intelligence",
      },
      provenance: {
        sourceUrl: "https://public.example/company",
        fetchedAt: "2026-08-26T00:00:00.000Z",
        contentHash: "c".repeat(64),
        parserVersion: "public-web/v1",
      },
    },
    sourceUrl: "https://public.example/company",
    fetchedAt: new Date("2026-08-26T00:00:00.000Z"),
    contentHash: "c".repeat(64),
    parserVersion: "public-web/v1",
    ingestKey: `external:${"d".repeat(64)}`,
    payloadHash: "e".repeat(64),
    payloadBytes: 512,
    ingestVersion: "raw-source/v2",
    ingestStatus: "ACCEPTED",
    dispositionCode: null,
    retentionDays: 30,
    expiresAt: new Date("2026-09-25T00:00:00.000Z"),
    sourcePolicySnapshot: {
      kind: "source_policy",
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      domain: "public.example",
      retentionDays: 30,
      reviewStatus: "APPROVED",
      allowedPurpose: ["discovery"],
      updatedAt: "2026-08-25T00:00:00.000Z",
      minimizedFields: [],
    },
  };
}

describe("Raw Source controlled writer receipt authority", () => {
  it("uses the PostgreSQL-returned canonical digest and bytes for exponent-form numbers", async () => {
    const queryRaw = vi.fn(async () => [
      {
        raw_record_id: "83000000-0000-4000-8000-000000000001",
        payload_hash: DB_HASH,
        payload_bytes: 529,
        ingest_status: "ACCEPTED",
        inserted: true,
      },
    ]);
    const resolution = resolveRawSourceBatchByIndex([preparedRow()], [])[0]!;
    if (resolution.kind !== "WRITE") throw new Error("expected WRITE");
    const row = resolution.row;

    await expect(
      persistPreparedRawSourceRecord({ $queryRaw: queryRaw } as never, {
        workspaceId: "10000000-0000-4000-8000-000000000001",
        runId: "20000000-0000-4000-8000-000000000001",
        sourceEntityId: null,
        providerKey: "public_web",
        sourceClass: "public_intelligence",
        row,
      }),
    ).resolves.toMatchObject({
      payloadHash: DB_HASH,
      payloadBytes: 529,
      inserted: true,
    });

    const statement = queryRaw.mock.calls[0]![0] as {
      values: readonly unknown[];
    };
    const command = JSON.parse(String(statement.values[0])) as Record<
      string,
      unknown
    >;
    expect(command).toMatchObject({ schemaVersion: "raw-source-writer/v2" });
    expect(command).toMatchObject({
      fetchedAt: "2026-08-26T00:00:00.000Z",
    });
    expect(command).not.toHaveProperty("expectedPayloadHash");
    expect(command).not.toHaveProperty("expectedPayloadBytes");
  });

  it("keeps captured Date behavior and writer serialization stable after prototype mutation", async () => {
    const queryRaw = vi.fn(async () => [
      {
        raw_record_id: "83000000-0000-4000-8000-000000000001",
        payload_hash: DB_HASH,
        payload_bytes: 529,
        ingest_status: "ACCEPTED",
        inserted: true,
      },
    ]);
    const resolution = resolveRawSourceBatchByIndex([preparedRow()], [])[0]!;
    if (resolution.kind !== "WRITE") throw new Error("expected WRITE");
    const originalToISOString = Date.prototype.toISOString;
    const originalValueOf = Date.prototype.valueOf;

    try {
      Date.prototype.toISOString = () => "PROTOTYPE_MUTATED_SECRET";
      Date.prototype.valueOf = () => 0;

      expect(resolution.row.fetchedAt?.toISOString()).toBe(
        "2026-08-26T00:00:00.000Z",
      );
      expect(resolution.row.fetchedAt?.valueOf()).toBe(
        Date.parse("2026-08-26T00:00:00.000Z"),
      );
      await persistPreparedRawSourceRecord({ $queryRaw: queryRaw } as never, {
        workspaceId: "10000000-0000-4000-8000-000000000001",
        runId: "20000000-0000-4000-8000-000000000001",
        sourceEntityId: null,
        providerKey: "public_web",
        sourceClass: "public_intelligence",
        row: resolution.row,
      });
    } finally {
      Date.prototype.toISOString = originalToISOString;
      Date.prototype.valueOf = originalValueOf;
    }

    const statement = queryRaw.mock.calls[0]![0] as {
      values: readonly unknown[];
    };
    const command = JSON.parse(String(statement.values[0])) as Record<
      string,
      unknown
    >;
    expect(command.fetchedAt).toBe("2026-08-26T00:00:00.000Z");
    expect(JSON.stringify(command)).not.toContain("PROTOTYPE_MUTATED_SECRET");
  });
});
