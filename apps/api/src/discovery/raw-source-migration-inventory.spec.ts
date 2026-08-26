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
  {
    migrationName: "20260826110000_raw_source_governance_constraints",
    checksum: "c".repeat(64),
  },
  {
    migrationName: "20260826120000_raw_source_governance_writer",
    checksum: "d".repeat(64),
  },
  {
    migrationName: "20260826130000_raw_source_governance_writer_hardening",
    checksum: "e".repeat(64),
  },
  {
    migrationName: "20260826140000_raw_source_governance_historical_cleanup",
    checksum: "f".repeat(64),
  },
  {
    migrationName: "20260826150000_raw_source_governance_status_hardening",
    checksum: "0".repeat(64),
  },
  {
    migrationName: "20260826160000_raw_source_governance_final_correction",
    checksum: "1".repeat(64),
  },
];

const REISSUED_1600_MIGRATION =
  "20260826160000_raw_source_governance_final_correction";
const OLD_REVIEWED_1600_CHECKSUM =
  "d8783aa0b513679d8944841c7e55b03812cc9709cc6d6c39005a9caadeaeea11";

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

  it("accepts a clean inventory with every exact successor checksum", () => {
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

  it.each([
    ["unfinished", null, null, "UNFINISHED"],
    [
      "rolled back",
      new Date("2026-08-14T00:00:00.000Z"),
      new Date("2026-08-14T00:01:00.000Z"),
      "ROLLED_BACK",
    ],
  ])(
    "holds an old PR row when its lifecycle is %s",
    (_label, finishedAt, rolledBackAt, lifecycleState) => {
      const historical = HISTORICAL_PR407_RAW_MIGRATIONS[0]!;
      const result = assessRawSourceMigrationInventory(
        [
          ...expected.map((entry) => ({
            migration_name: entry.migrationName,
            checksum: entry.checksum,
            finished_at: new Date("2026-08-26T00:00:00.000Z"),
            rolled_back_at: null,
          })),
          {
            migration_name: historical.migrationName,
            checksum: historical.checksum,
            finished_at: finishedAt,
            rolled_back_at: rolledBackAt,
          },
        ],
        expected,
      );
      expect(result).toMatchObject({
        decision: "HOLD",
        state: "OLD_PR_MIGRATION_PRESENT",
        observations: [
          expect.objectContaining({
            migrationName: historical.migrationName,
            lifecycleState,
          }),
        ],
      });
    },
  );

  it("holds duplicate historical and current names, including conflicting checksums", () => {
    const historical = HISTORICAL_PR407_RAW_MIGRATIONS[0]!;
    const completed = new Date("2026-08-26T00:00:00.000Z");
    const oldResult = assessRawSourceMigrationInventory(
      [
        {
          migration_name: historical.migrationName,
          checksum: historical.checksum,
          finished_at: completed,
          rolled_back_at: null,
        },
        {
          migration_name: historical.migrationName,
          checksum: "f".repeat(64),
          finished_at: null,
          rolled_back_at: null,
        },
        ...expected.map((entry) => ({
          migration_name: entry.migrationName,
          checksum: entry.checksum,
          finished_at: completed,
          rolled_back_at: null,
        })),
      ],
      expected,
    );
    expect(oldResult).toMatchObject({
      decision: "HOLD",
      state: "OLD_PR_MIGRATION_PRESENT",
      observations: [
        expect.objectContaining({ rowCount: 2, lifecycleState: "CONFLICT" }),
      ],
    });

    const currentResult = assessRawSourceMigrationInventory(
      [
        ...expected.map((entry) => ({
          migration_name: entry.migrationName,
          checksum: entry.checksum,
          finished_at: completed,
          rolled_back_at: null,
        })),
        {
          migration_name: expected[0]!.migrationName,
          checksum: "e".repeat(64),
          finished_at: null,
          rolled_back_at: null,
        },
      ],
      expected,
    );
    expect(currentResult).toMatchObject({
      decision: "HOLD",
      state: "MIGRATION_INVENTORY_CONFLICT",
      observations: [
        expect.objectContaining({
          migrationName: expected[0]!.migrationName,
          rowCount: 2,
          lifecycleState: "CONFLICT",
        }),
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

  it("returns an explicit provenance HOLD for the pre-release 1600 checksum that was reissued", () => {
    const completed = new Date("2026-08-26T00:00:00.000Z");
    const inventory = expected.map((entry) => ({
      migration_name: entry.migrationName,
      checksum:
        entry.migrationName === REISSUED_1600_MIGRATION
          ? OLD_REVIEWED_1600_CHECKSUM
          : entry.checksum,
      finished_at: completed,
      rolled_back_at: null,
    }));

    expect(assessRawSourceMigrationInventory(inventory, expected)).toEqual({
      schemaVersion: "pr407-raw-source-migration-decision/v1",
      subject: "SUPPLIED",
      decision: "HOLD",
      state: "PRE_RELEASE_REISSUED_CHECKSUM_PRESENT",
      observations: [
        {
          migrationName: REISSUED_1600_MIGRATION,
          observedChecksum: OLD_REVIEWED_1600_CHECKSUM,
          expectedChecksum: "1".repeat(64),
          rowCount: 1,
          lifecycleState: "APPLIED",
        },
      ],
    });
  });
});
