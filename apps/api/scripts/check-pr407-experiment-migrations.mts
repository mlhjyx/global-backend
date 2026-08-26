import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  assessRawSourceMigrationInventory,
  type ExpectedMigrationChecksum,
  type PrismaMigrationInventoryRow,
} from "../src/discovery/raw-source-migration-inventory";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const migrationNames = Object.freeze([
  "20260826090000_raw_source_governance_schema",
  "20260826100000_raw_source_governance_backfill",
  "20260826110000_raw_source_governance_constraints",
  "20260826120000_raw_source_governance_writer",
  "20260826130000_raw_source_governance_writer_hardening",
  "20260826140000_raw_source_governance_historical_cleanup",
  "20260826150000_raw_source_governance_status_hardening",
  "20260826160000_raw_source_governance_final_correction",
  "20260826170000_raw_source_governance_writer_parity",
  "20260826180000_raw_source_evidence_chain_correction",
  "20260826190000_raw_source_governance_path_sanitizer",
  "20260826200000_raw_source_path_evidence_cleanup",
  "20260826210000_raw_source_stored_field_path_adapter",
  "20260826220000_raw_source_stored_field_cleanup",
  "20260826230000_raw_source_site_section_key_contract",
  "20260826240000_raw_source_site_section_cleanup",
]);

async function expectedChecksums(): Promise<ExpectedMigrationChecksum[]> {
  return Promise.all(
    migrationNames.map(async (migrationName) => {
      const bytes = await readFile(
        resolve(
          repositoryRoot,
          "packages/db/prisma/migrations",
          migrationName,
          "migration.sql",
        ),
      );
      return {
        migrationName,
        checksum: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
}

async function main(): Promise<void> {
  const expected = await expectedChecksums();
  const subjectUrl = process.env.PR407_EXPERIMENT_DATABASE_URL?.trim();
  if (!subjectUrl) {
    console.log(
      JSON.stringify(
        assessRawSourceMigrationInventory(undefined, expected),
        null,
        2,
      ),
    );
    process.exitCode = 2;
    return;
  }
  const parsed = new URL(subjectUrl);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("PR407_EXPERIMENT_DATABASE_URL must be a PostgreSQL URL");
  }
  const database = new PrismaClient({ datasourceUrl: subjectUrl });
  try {
    const inventory = await database.$queryRaw<PrismaMigrationInventoryRow[]>(
      Prisma.sql`SELECT migration_name, checksum, finished_at, rolled_back_at
        FROM "_prisma_migrations" ORDER BY started_at, migration_name`,
    );
    const result = assessRawSourceMigrationInventory(inventory, expected);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.decision === "GO" ? 0 : 2;
  } finally {
    await database.$disconnect();
  }
}

await main();
