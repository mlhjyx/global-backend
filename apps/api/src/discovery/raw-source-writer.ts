import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PreparedRawSourceRow } from "./raw-source-ingestion";

interface WriterReceiptRow {
  raw_record_id: string;
  payload_hash: string;
  payload_bytes: number;
  ingest_status: string;
  inserted: boolean;
}

export interface RawSourceWriterResult {
  id: string;
  payloadHash: string;
  payloadBytes: number;
  ingestStatus: string;
  inserted: boolean;
}

function sourcePolicyId(snapshot: Record<string, unknown>): string | null {
  return snapshot.kind === "source_policy" && typeof snapshot.id === "string"
    ? snapshot.id
    : null;
}

/**
 * The app supplies one bound command as a single SQL parameter. PostgreSQL
 * independently derives the canonical payload digest/bytes and every policy,
 * provider, workspace, run, or monitored-source binding before insertion.
 */
export async function persistPreparedRawSourceRecord(
  tx: Prisma.TransactionClient,
  args: {
    workspaceId: string;
    runId: string | null;
    sourceEntityId: string | null;
    providerKey: string;
    sourceClass: string;
    row: PreparedRawSourceRow;
    costCents?: number;
  },
): Promise<RawSourceWriterResult> {
  const command = {
    schemaVersion: "raw-source-writer/v1",
    recordId: randomUUID(),
    workspaceId: args.workspaceId,
    runId: args.runId,
    sourceEntityId: args.sourceEntityId,
    providerKey: args.providerKey,
    sourceClass: args.sourceClass,
    externalId: args.row.externalId,
    payload: args.row.payload,
    sourceUrl: args.row.sourceUrl,
    fetchedAt: args.row.fetchedAt?.toISOString() ?? null,
    contentHash: args.row.contentHash,
    parserVersion: args.row.parserVersion,
    ingestKey: args.row.ingestKey,
    expectedPayloadHash: args.row.payloadHash,
    expectedPayloadBytes: args.row.payloadBytes,
    ingestStatus: args.row.ingestStatus,
    dispositionCode: args.row.dispositionCode,
    sourcePolicyId: sourcePolicyId(args.row.sourcePolicySnapshot),
    retentionDays: args.row.retentionDays,
    costCents: args.costCents ?? 0,
  };
  const rows = await tx.$queryRaw<WriterReceiptRow[]>(
    Prisma.sql`SELECT raw_record_id::text, payload_hash, payload_bytes,
      ingest_status, inserted
      FROM write_raw_source_record_v2(${JSON.stringify(command)}::jsonb)`,
  );
  const receipt = rows[0];
  if (
    !receipt ||
    typeof receipt.raw_record_id !== "string" ||
    receipt.payload_hash !== args.row.payloadHash ||
    receipt.payload_bytes !== args.row.payloadBytes ||
    receipt.ingest_status !== args.row.ingestStatus ||
    typeof receipt.inserted !== "boolean"
  ) {
    throw new Error("RAW_SOURCE_WRITER_RECEIPT_INVALID");
  }
  return {
    id: receipt.raw_record_id,
    payloadHash: receipt.payload_hash,
    payloadBytes: receipt.payload_bytes,
    ingestStatus: receipt.ingest_status,
    inserted: receipt.inserted,
  };
}
