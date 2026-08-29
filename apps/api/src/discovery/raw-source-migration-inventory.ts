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

export const PRE_RELEASE_REISSUED_PR407_RAW_MIGRATIONS: readonly ExpectedMigrationChecksum[] =
  Object.freeze([
    Object.freeze({
      migrationName: "20260826160000_raw_source_governance_final_correction",
      checksum:
        "d8783aa0b513679d8944841c7e55b03812cc9709cc6d6c39005a9caadeaeea11",
    }),
    Object.freeze({
      migrationName: "20260826160000_raw_source_governance_final_correction",
      checksum:
        "c8e6e5520747ada0d0f70104a7dd0f8ece2edcc7ccdcc7237cacbfd7566c24d0",
    }),
    Object.freeze({
      migrationName: "20260826150000_raw_source_governance_status_hardening",
      checksum:
        "952a96461ac38028e758a89c93bf320a4122f3a4db6273ce9355bdfd9262196c",
    }),
    Object.freeze({
      migrationName: "20260826220000_raw_source_stored_field_cleanup",
      checksum:
        "2f05e19488c57004bab2061026eace24a1f6650107c9a42b94070a94541b9d22",
    }),
  ]);

export type RawSourceMigrationDecision = Readonly<{
  schemaVersion: "pr407-raw-source-migration-decision/v1";
  subject: "UNKNOWN" | "SUPPLIED";
  decision: "GO" | "HOLD";
  state:
    | "LIVE_EXPERIMENT_DB_NOT_SUPPLIED"
    | "OLD_PR_MIGRATION_PRESENT"
    | "PRE_RELEASE_REISSUED_CHECKSUM_PRESENT"
    | "MIGRATION_INVENTORY_CONFLICT"
    | "SUCCESSOR_CHECKSUM_MISMATCH"
    | "CURRENT_SUCCESSOR_INCOMPLETE"
    | "CURRENT_SUCCESSOR_APPLIED";
  observations: readonly Readonly<{
    migrationName: string;
    expectedMigrationName?: string;
    observedChecksum: string | null;
    observedChecksums?: readonly string[];
    expectedChecksum: string | null;
    rowCount?: number;
    lifecycleState?: "APPLIED" | "UNFINISHED" | "ROLLED_BACK" | "CONFLICT";
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
  const rowsByName = new Map<string, PrismaMigrationInventoryRow[]>();
  for (const row of inventory) {
    const rows = rowsByName.get(row.migration_name) ?? [];
    rows.push(row);
    rowsByName.set(row.migration_name, rows);
  }
  const lifecycle = (
    rows: readonly PrismaMigrationInventoryRow[],
  ): "APPLIED" | "UNFINISHED" | "ROLLED_BACK" | "CONFLICT" => {
    if (rows.length !== 1) return "CONFLICT";
    if (rows[0]!.rolled_back_at !== null) return "ROLLED_BACK";
    return rows[0]!.finished_at === null ? "UNFINISHED" : "APPLIED";
  };
  const observedChecksum = (
    rows: readonly PrismaMigrationInventoryRow[],
  ): string | null => {
    const checksums = [...new Set(rows.map((row) => row.checksum))];
    return checksums.length === 1 ? checksums[0]! : null;
  };
  const observedChecksums = (
    rows: readonly PrismaMigrationInventoryRow[],
  ): readonly string[] => [...new Set(rows.map((row) => row.checksum))].sort();
  const observation = (
    entry: ExpectedMigrationChecksum,
    rows: readonly PrismaMigrationInventoryRow[],
    actualMigrationName = entry.migrationName,
  ) => ({
    migrationName: actualMigrationName,
    ...(actualMigrationName === entry.migrationName
      ? {}
      : { expectedMigrationName: entry.migrationName }),
    observedChecksum: observedChecksum(rows),
    ...(observedChecksums(rows).length > 1
      ? { observedChecksums: Object.freeze(observedChecksums(rows)) }
      : {}),
    expectedChecksum: entry.checksum,
    rowCount: rows.length,
    lifecycleState: lifecycle(rows),
  });

  // Content provenance is authoritative. Scan every supplied row for every
  // forbidden historical/pre-release digest before any name-based current
  // successor decision. Rows sharing the observed name are kept together so
  // duplicate and conflicting lifecycle/checksum forms cannot be hidden by a
  // rename.
  const forbiddenByChecksum = [
    ...HISTORICAL_PR407_RAW_MIGRATIONS.map((entry) => ({
      entry,
      state: "OLD_PR_MIGRATION_PRESENT" as const,
    })),
    ...PRE_RELEASE_REISSUED_PR407_RAW_MIGRATIONS.map((entry) => ({
      entry,
      state: "PRE_RELEASE_REISSUED_CHECKSUM_PRESENT" as const,
    })),
  ];
  const forbiddenMatches = forbiddenByChecksum.flatMap(({ entry, state }) => {
    const actualNames = [
      ...new Set(
        inventory
          .filter((row) => row.checksum === entry.checksum)
          .map((row) => row.migration_name),
      ),
    ];
    return actualNames.map((actualMigrationName) => {
      const rows = rowsByName.get(actualMigrationName) ?? [];
      const canonicalCurrent = expectedCurrent.find(
        (candidate) => candidate.migrationName === entry.migrationName,
      );
      const expectedEntry =
        actualMigrationName === entry.migrationName && canonicalCurrent
          ? canonicalCurrent
          : entry;
      return { actualMigrationName, expectedEntry, rows, state };
    });
  });
  if (forbiddenMatches.length) {
    return decision({
      subject: "SUPPLIED",
      decision: "HOLD",
      state: forbiddenMatches.some(
        (match) => match.state === "OLD_PR_MIGRATION_PRESENT",
      )
        ? "OLD_PR_MIGRATION_PRESENT"
        : "PRE_RELEASE_REISSUED_CHECKSUM_PRESENT",
      observations: forbiddenMatches.map(
        ({ actualMigrationName, expectedEntry, rows }) =>
          observation(expectedEntry, rows, actualMigrationName),
      ),
    });
  }

  // Historical names are a HOLD regardless of their lifecycle or checksum.
  const historical = HISTORICAL_PR407_RAW_MIGRATIONS.flatMap((entry) => {
    const rows = rowsByName.get(entry.migrationName) ?? [];
    return rows.length ? [{ entry, rows }] : [];
  });
  if (historical.length) {
    return decision({
      subject: "SUPPLIED",
      decision: "HOLD",
      state: "OLD_PR_MIGRATION_PRESENT",
      observations: historical.map(({ entry, rows }) =>
        observation(entry, rows),
      ),
    });
  }

  const currentConflicts = expectedCurrent.flatMap((entry) => {
    const rows = rowsByName.get(entry.migrationName) ?? [];
    return rows.length > 1 ? [{ entry, rows }] : [];
  });
  if (currentConflicts.length) {
    return decision({
      subject: "SUPPLIED",
      decision: "HOLD",
      state: "MIGRATION_INVENTORY_CONFLICT",
      observations: currentConflicts.map(({ entry, rows }) =>
        observation(entry, rows),
      ),
    });
  }

  const mismatches = expectedCurrent.filter((entry) => {
    const rows = rowsByName.get(entry.migrationName) ?? [];
    return rows.length === 1 && rows[0]!.checksum !== entry.checksum;
  });
  if (mismatches.length) {
    return decision({
      subject: "SUPPLIED",
      decision: "HOLD",
      state: "SUCCESSOR_CHECKSUM_MISMATCH",
      observations: mismatches.map((entry) =>
        observation(entry, rowsByName.get(entry.migrationName) ?? []),
      ),
    });
  }

  const missing = expectedCurrent.filter((entry) => {
    const rows = rowsByName.get(entry.migrationName) ?? [];
    return rows.length !== 1 || lifecycle(rows) !== "APPLIED";
  });
  if (missing.length) {
    return decision({
      subject: "SUPPLIED",
      decision: "HOLD",
      state: "CURRENT_SUCCESSOR_INCOMPLETE",
      observations: missing.map((entry) => {
        const rows = rowsByName.get(entry.migrationName) ?? [];
        return rows.length
          ? observation(entry, rows)
          : {
              migrationName: entry.migrationName,
              observedChecksum: null,
              expectedChecksum: entry.checksum,
              rowCount: 0,
            };
      }),
    });
  }
  return decision({
    subject: "SUPPLIED",
    decision: "GO",
    state: "CURRENT_SUCCESSOR_APPLIED",
    observations: [],
  });
}
