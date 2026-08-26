export interface ExpectedMigrationChecksum {
  migrationName: string;
  checksum: string;
}

export interface PrismaMigrationInventoryRow {
  migration_name: string;
  checksum: string;
  finished_at: Date | string | null;
  rolled_back_at: Date | string | null;
}

export const HISTORICAL_PR407_RAW_MIGRATIONS: readonly ExpectedMigrationChecksum[] =
  Object.freeze([
    Object.freeze({
      migrationName: "20260812110000_raw_source_v2",
      checksum:
        "784aeb3e6a41753053a8e863720f20406778765b5fa3e2be282c79211565f78c",
    }),
    Object.freeze({
      migrationName: "20260813020000_monitored_source_raw_bridge",
      checksum:
        "2cd994373e0ef550ccb83048c695753351db12002035f8c1a361ac248c50d0b9",
    }),
    Object.freeze({
      migrationName: "20260813030000_monitored_source_raw_origin_immutable",
      checksum:
        "d4d305aabffbb6d16a6752dcdfa7385789b1fd14ed4921330394b5d080ba1c13",
    }),
    Object.freeze({
      migrationName: "20260813040000_source_entity_fetch_provenance",
      checksum:
        "f253d38359cf17e9e2bbe5097ea1d583d7ff344a1c9a8bf7d7ff6bc6311afd5b",
    }),
    Object.freeze({
      migrationName: "20260814120000_raw_source_governance_disposition",
      checksum:
        "59eed0a808b88f3e9f033b39019c2e3cbc4f5d12d67bae020632ad1e903555ef",
    }),
  ]);

export type RawSourceMigrationDecision = Readonly<{
  schemaVersion: "pr407-raw-source-migration-decision/v1";
  subject: "UNKNOWN" | "SUPPLIED";
  decision: "GO" | "HOLD";
  state:
    | "LIVE_EXPERIMENT_DB_NOT_SUPPLIED"
    | "OLD_PR_MIGRATION_PRESENT"
    | "SUCCESSOR_CHECKSUM_MISMATCH"
    | "CURRENT_SUCCESSOR_INCOMPLETE"
    | "CURRENT_SUCCESSOR_APPLIED";
  observations: readonly Readonly<{
    migrationName: string;
    observedChecksum: string | null;
    expectedChecksum: string | null;
  }>[];
}>;

function decision(
  input: Omit<RawSourceMigrationDecision, "schemaVersion">,
): RawSourceMigrationDecision {
  return Object.freeze({
    schemaVersion: "pr407-raw-source-migration-decision/v1",
    ...input,
    observations: Object.freeze(
      input.observations.map((row) => Object.freeze(row)),
    ),
  });
}

export function assessRawSourceMigrationInventory(
  inventory: readonly PrismaMigrationInventoryRow[] | undefined,
  expectedCurrent: readonly ExpectedMigrationChecksum[],
): RawSourceMigrationDecision {
  if (inventory === undefined) {
    return decision({
      subject: "UNKNOWN",
      decision: "HOLD",
      state: "LIVE_EXPERIMENT_DB_NOT_SUPPLIED",
      observations: [],
    });
  }
  const applied = new Map(
    inventory
      .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
      .map((row) => [row.migration_name, row.checksum]),
  );
  const historical = HISTORICAL_PR407_RAW_MIGRATIONS.filter((entry) =>
    applied.has(entry.migrationName),
  );
  if (historical.length) {
    return decision({
      subject: "SUPPLIED",
      decision: "HOLD",
      state: "OLD_PR_MIGRATION_PRESENT",
      observations: historical.map((entry) => ({
        migrationName: entry.migrationName,
        observedChecksum: applied.get(entry.migrationName) ?? null,
        expectedChecksum: entry.checksum,
      })),
    });
  }

  const mismatches = expectedCurrent.filter(
    (entry) =>
      applied.has(entry.migrationName) &&
      applied.get(entry.migrationName) !== entry.checksum,
  );
  if (mismatches.length) {
    return decision({
      subject: "SUPPLIED",
      decision: "HOLD",
      state: "SUCCESSOR_CHECKSUM_MISMATCH",
      observations: mismatches.map((entry) => ({
        migrationName: entry.migrationName,
        observedChecksum: applied.get(entry.migrationName) ?? null,
        expectedChecksum: entry.checksum,
      })),
    });
  }

  const missing = expectedCurrent.filter(
    (entry) => !applied.has(entry.migrationName),
  );
  if (missing.length) {
    return decision({
      subject: "SUPPLIED",
      decision: "HOLD",
      state: "CURRENT_SUCCESSOR_INCOMPLETE",
      observations: missing.map((entry) => ({
        migrationName: entry.migrationName,
        observedChecksum: null,
        expectedChecksum: entry.checksum,
      })),
    });
  }
  return decision({
    subject: "SUPPLIED",
    decision: "GO",
    state: "CURRENT_SUCCESSOR_APPLIED",
    observations: [],
  });
}
