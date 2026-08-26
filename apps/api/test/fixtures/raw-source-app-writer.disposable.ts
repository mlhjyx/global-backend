import { PrismaClient, type Prisma } from "@prisma/client";
import {
  prepareRawSourceBatch,
  reconcileRawSourceBatch,
  type RawSourcePolicySnapshot,
} from "../../src/discovery/raw-source-ingestion";
import { persistPreparedRawSourceRecord } from "../../src/discovery/raw-source-writer";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const APPROVED_POLICY_ID = "a0000000-0000-4000-8000-000000000001";
const SUSPENDED_POLICY_ID = "a0000000-0000-4000-8000-000000000003";
const OBSERVED_AT = "2026-08-26T00:00:00.000Z";
const NOW = new Date("2026-08-26T00:00:00.000Z");

const approvedPolicy: RawSourcePolicySnapshot = {
  id: APPROVED_POLICY_ID,
  domain: "registry.example",
  retentionDays: 30,
  reviewStatus: "APPROVED",
  allowedPurpose: ["discovery"],
  updatedAt: new Date("2026-08-25T00:00:00.000Z"),
};
const suspendedPolicy: RawSourcePolicySnapshot = {
  id: SUSPENDED_POLICY_ID,
  domain: "suspended.example",
  retentionDays: 30,
  reviewStatus: "SUSPENDED",
  allowedPurpose: ["discovery"],
  updatedAt: new Date("2026-08-25T00:00:00.000Z"),
};

function registryRecord(
  externalId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    externalId,
    name: "Parker Hannifin",
    domain: "parker.example",
    country: "US",
    attributes: { products: ["pump"] },
    provenance: {
      sourceUrl: "https://registry.example/company/app-flow",
      fetchedAt: OBSERVED_AT,
      contentHash: "a".repeat(64),
      parserVersion: "registry/v2",
    },
    ...overrides,
  };
}

async function withWorkspace<T>(
  database: PrismaClient,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return database.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${WORKSPACE_ID}, true)`;
    return callback(tx);
  });
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.includes("task6a_raw_")) {
    throw new Error("disposable task6a database URL required");
  }
  const database = new PrismaClient();
  try {
    const rejected = prepareRawSourceBatch({
      providerKey: "registry",
      records: [registryRecord("app-flow-rejected", { unknown: "drop" })],
      policies: [approvedPolicy],
      now: NOW,
    }).rows[0]!;
    const quarantined = prepareRawSourceBatch({
      providerKey: "registry",
      records: [
        registryRecord("app-flow-quarantined", {
          provenance: {
            ...(registryRecord("unused").provenance as Record<string, unknown>),
            sourceUrl: "https://suspended.example/company/app-flow",
          },
        }),
      ],
      policies: [suspendedPolicy],
      now: NOW,
    }).rows[0]!;
    const oversized = prepareRawSourceBatch({
      providerKey: "registry",
      records: [registryRecord("app-flow-oversized")],
      policies: [approvedPolicy],
      limits: {
        maxRecordBytes: 32,
        maxBatchBytes: 1_024,
        defaultRetentionDays: 30,
      },
      now: NOW,
    }).rows[0]!;
    const original = prepareRawSourceBatch({
      providerKey: "registry",
      records: [registryRecord("app-flow-drift")],
      policies: [approvedPolicy],
      now: NOW,
    }).rows[0]!;

    const persisted = await withWorkspace(database, async (tx) => {
      const receipts = [];
      for (const row of [rejected, quarantined, oversized]) {
        receipts.push(
          await persistPreparedRawSourceRecord(tx, {
            workspaceId: WORKSPACE_ID,
            runId: RUN_ID,
            sourceEntityId: null,
            providerKey: "registry",
            sourceClass: "company_registry",
            row,
          }),
        );
      }
      const originalReceipt = await persistPreparedRawSourceRecord(tx, {
        workspaceId: WORKSPACE_ID,
        runId: RUN_ID,
        sourceEntityId: null,
        providerKey: "registry",
        sourceClass: "company_registry",
        row: original,
      });
      const changed = prepareRawSourceBatch({
        providerKey: "registry",
        records: [registryRecord("app-flow-drift", { name: "Changed GmbH" })],
        policies: [approvedPolicy],
        now: NOW,
      }).rows[0]!;
      const drift = reconcileRawSourceBatch([changed], [
        {
          id: originalReceipt.id,
          externalId: original.externalId,
          ingestKey: original.ingestKey,
          payloadHash: originalReceipt.payloadHash,
          payload: original.payload,
        },
      ]).rows[0]!;
      receipts.push(
        await persistPreparedRawSourceRecord(tx, {
          workspaceId: WORKSPACE_ID,
          runId: RUN_ID,
          sourceEntityId: null,
          providerKey: "registry",
          sourceClass: "company_registry",
          row: drift,
        }),
      );
      const rows = await tx.rawSourceRecord.findMany({
        where: { id: { in: receipts.map((receipt) => receipt.id) } },
        select: {
          ingestKey: true,
          payloadHash: true,
          ingestStatus: true,
          dispositionCode: true,
          payload: true,
        },
        orderBy: { dispositionCode: "asc" },
      });
      return { receipts, rows };
    });

    console.log(JSON.stringify(persisted));
  } finally {
    await database.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
