import { describe, expect, it } from "vitest";
import {
  HISTORICAL_PR407_RAW_MIGRATIONS,
  assessRawSourceMigrationInventory,
  type ExpectedMigrationChecksum,
} from "./raw-source-migration-inventory";

const expected: ExpectedMigrationChecksum[] = [
  {
    migrationName: "20260826090000_raw_source_governance_schema",
    checksum: "a".repeat(64),
  },
  {
    migrationName: "20260826100000_raw_source_governance_backfill",
    checksum: "b".repeat(64),
  },
];

describe("PR #407 experiment _prisma_migrations bridge decision", () => {
  it("returns an explicit UNKNOWN/HOLD when no live experiment subject is supplied", () => {
    expect(assessRawSourceMigrationInventory(undefined, expected)).toEqual({
      schemaVersion: "pr407-raw-source-migration-decision/v1",
      subject: "UNKNOWN",
      decision: "HOLD",
      state: "LIVE_EXPERIMENT_DB_NOT_SUPPLIED",
      observations: [],
    });
  });

  it("accepts a clean inventory with both exact successor checksums", () => {
    expect(
      assessRawSourceMigrationInventory(
        expected.map((entry) => ({
          migration_name: entry.migrationName,
          checksum: entry.checksum,
          finished_at: new Date("2026-08-26T00:00:00.000Z"),
          rolled_back_at: null,
        })),
        expected,
      ),
    ).toMatchObject({
      subject: "SUPPLIED",
      decision: "GO",
      state: "CURRENT_SUCCESSOR_APPLIED",
      observations: [],
    });
  });

  it("holds when any historical PR #407 migration is present even with its exact old checksum", () => {
    const historical = HISTORICAL_PR407_RAW_MIGRATIONS[0]!;
    expect(
      assessRawSourceMigrationInventory(
        [
          {
            migration_name: historical.migrationName,
            checksum: historical.checksum,
            finished_at: new Date("2026-08-14T00:00:00.000Z"),
            rolled_back_at: null,
          },
        ],
        expected,
      ),
    ).toMatchObject({
      subject: "SUPPLIED",
      decision: "HOLD",
      state: "OLD_PR_MIGRATION_PRESENT",
      observations: [
        expect.objectContaining({ migrationName: historical.migrationName }),
      ],
    });
  });

  it("holds on a current successor checksum mismatch instead of resolving it automatically", () => {
    expect(
      assessRawSourceMigrationInventory(
        [
          {
            migration_name: expected[0]!.migrationName,
            checksum: "f".repeat(64),
            finished_at: new Date("2026-08-26T00:00:00.000Z"),
            rolled_back_at: null,
          },
          {
            migration_name: expected[1]!.migrationName,
            checksum: expected[1]!.checksum,
            finished_at: new Date("2026-08-26T00:00:00.000Z"),
            rolled_back_at: null,
          },
        ],
        expected,
      ),
    ).toMatchObject({
      subject: "SUPPLIED",
      decision: "HOLD",
      state: "SUCCESSOR_CHECKSUM_MISMATCH",
      observations: [
        expect.objectContaining({ migrationName: expected[0]!.migrationName }),
      ],
    });
  });
});
