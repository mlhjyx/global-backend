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
