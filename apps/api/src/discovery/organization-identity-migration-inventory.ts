import {
  assessRawSourceMigrationInventory,
  type ExpectedMigrationChecksum,
  type PrismaMigrationInventoryRow,
  type RawSourceMigrationDecision,
} from "./raw-source-migration-inventory";

export type CatalogObjectKind = "TABLE" | "TYPE" | "FUNCTION" | "TRIGGER";

/** A bounded catalog observation; SQL text and arbitrary catalog values are excluded. */
export type CatalogInventoryRecord = Readonly<{
  kind: CatalogObjectKind;
  name: string;
}>;

export const HISTORICAL_ORGANIZATION_IDENTITY_MIGRATIONS: readonly ExpectedMigrationChecksum[] =
  Object.freeze([
    Object.freeze({
      migrationName: "20260812090000_organization_identity_v2",
      checksum:
        "bedc5b97a8d20dbd2a8e108afc14a58270bd6e8319dc2174f7b9d4ae93314895",
    }),
    Object.freeze({
      migrationName: "20260812130000_runtime_component_heartbeat",
      checksum:
        "321b1f63bbfbd5b4ce3753f6dfa4866425f8cca3b432f7f4ecb1614ab34f4b46",
    }),
    Object.freeze({
      migrationName: "20260813010000_provider_quality_ledger",
      checksum:
        "fbc6c2babb86a30ba662422f226c6b145e1529e35c76312645236a6ade0c42ea",
    }),
    Object.freeze({
      migrationName: "20260813013000_provider_quality_ledger_v2_columns",
      checksum:
        "bd93fee18e970a46f2bba0c3e685bb8f31f4ea9bfe4e3b8ca46f370c33709256",
    }),
    Object.freeze({
      migrationName: "20260813050000_organization_identifier_provenance",
      checksum:
        "ba84fff0af91dcd6236074ae7e43b8facd0632daebf58c1a3cc879714b9345be",
    }),
    Object.freeze({
      migrationName: "20260813060000_canonical_company_normalized_domain_index",
      checksum:
        "fc51f0453a359bd2e0915fc2dae5bbc9591a9e190466d728ddd3c3b98e7e9f6b",
    }),
    Object.freeze({
      migrationName: "20260813070000_organization_identifier_conflict_claim",
      checksum:
        "dee1d8e93291f27238420e9e8ecfac8821f24a4f6bf3d15848302129a3278511",
    }),
  ]);

function catalogObjects(
  kind: CatalogObjectKind,
  names: readonly string[],
): readonly CatalogInventoryRecord[] {
  return Object.freeze(names.map((name) => Object.freeze({ kind, name })));
}

// This inventory preserves the names created by tugjvnh's historical PR #407
// implementation as residue sentinels; it does not claim that implementation
// is merged or that any retained environment has been inspected.
export const FORBIDDEN_HISTORICAL_IDENTITY_CATALOG_OBJECTS: readonly CatalogInventoryRecord[] =
  Object.freeze([
    ...catalogObjects("TABLE", [
      "organization_identifier",
      "organization_identity_conflict",
      "organization_identity_conflict_party",
      "organization_identity_decision",
      "organization_canonical_mapping",
      "organization_identity_replay",
      "provider_quality_run_contribution",
      "runtime_component_heartbeat",
    ]),
    ...catalogObjects("TYPE", [
      "organization_identifier_status",
      "organization_identity_conflict_status",
      "organization_identity_decision_action",
      "organization_canonical_mapping_status",
      "organization_identity_replay_status",
      "identity_link_status",
    ]),
    ...catalogObjects("FUNCTION", [
      "enforce_organization_mapping_root",
      "reject_organization_identity_decision_mutation",
      "reject_organization_identity_delete",
      "validate_provider_quality_contribution_insert",
      "reject_provider_quality_contribution_mutation",
    ]),
    ...catalogObjects("TRIGGER", [
      "organization_canonical_mapping_root_guard",
      "organization_identity_decision_append_only_guard",
      "organization_identifier_delete_guard",
      "organization_identity_conflict_delete_guard",
      "organization_identity_conflict_party_delete_guard",
      "organization_canonical_mapping_delete_guard",
      "organization_identity_replay_delete_guard",
      "provider_quality_contribution_insert_guard",
      "provider_quality_run_contribution_update_guard",
      "provider_quality_run_contribution_delete_guard",
    ]),
  ]);

type MigrationLifecycle = "APPLIED" | "UNFINISHED" | "ROLLED_BACK" | "CONFLICT";

export type OrganizationIdentityMigrationDecision = Readonly<{
  schemaVersion: "organization-identity-migration-decision/v1";
  subject: "UNKNOWN" | "SUPPLIED";
  decision: "GO" | "HOLD";
  state:
    | "INVENTORY_NOT_SUPPLIED"
    | "INVALID_INVENTORY_INPUT"
    | "OLD_IDENTITY_MIGRATION_PRESENT"
    | "OLD_IDENTITY_OBJECT_RESIDUE_PRESENT"
    | "RAW_SOURCE_LINEAGE_HOLD"
    | "MIGRATION_INVENTORY_CONFLICT"
    | "SUCCESSOR_CHECKSUM_MISMATCH"
    | "CURRENT_IDENTITY_SUCCESSOR_INCOMPLETE"
    | "CURRENT_MAIN_READY_FOR_IDENTITY_SUCCESSOR"
    | "CURRENT_IDENTITY_SUCCESSOR_APPLIED";
  observations: readonly OrganizationIdentityMigrationObservation[];
}>;

export type OrganizationIdentityMigrationObservation = Readonly<{
  kind: "MIGRATION" | CatalogObjectKind;
  name: string;
  expectedName?: string;
  observedChecksum?: string | null;
  observedChecksums?: readonly string[];
  expectedChecksum?: string | null;
  rowCount?: number;
  lifecycleState?: MigrationLifecycle;
  reasonCode: string;
}>;

function decision(
  input: Omit<OrganizationIdentityMigrationDecision, "schemaVersion">,
): OrganizationIdentityMigrationDecision {
  return Object.freeze({
    schemaVersion: "organization-identity-migration-decision/v1",
    ...input,
    observations: Object.freeze(
      input.observations.map((observation) =>
        Object.freeze({
          ...observation,
          ...(observation.observedChecksums
            ? {
                observedChecksums: Object.freeze([
                  ...observation.observedChecksums,
                ]),
              }
            : {}),
        }),
      ),
    ),
  });
}

const MAX_MIGRATION_INVENTORY_ROWS = 512;
const MAX_CATALOG_INVENTORY_ROWS = 128;
const MAX_EXPECTED_MIGRATIONS = 128;
const MAX_MACHINE_NAME_LENGTH = 128;
const CATALOG_OBJECT_KINDS = Object.freeze([
  "TABLE",
  "TYPE",
  "FUNCTION",
  "TRIGGER",
] as const);
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const CATALOG_NAME = /^[a-z][a-z0-9_]*$/;
const MIGRATION_NAME = /^\d{14}_[a-z][a-z0-9_]*$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type ValidatedInventoryInput = Readonly<{
  migrationInventory: readonly PrismaMigrationInventoryRow[];
  catalogInventory: readonly CatalogInventoryRecord[];
  expectedCurrentRaw: readonly ExpectedMigrationChecksum[];
  expectedIdentitySuccessor: readonly ExpectedMigrationChecksum[];
}>;

function readExactDataFields(
  value: unknown,
  expectedKeys: readonly string[],
): readonly unknown[] | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return undefined;
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some(
      (key) => typeof key !== "string" || !expectedKeys.includes(key),
    )
  ) {
    return undefined;
  }
  const fields: unknown[] = [];
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index]!;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      return undefined;
    }
    fields[index] = descriptor.value;
  }
  return Object.freeze(fields);
}

function readDenseArray(
  value: unknown,
  maximumLength: number,
): readonly unknown[] | undefined {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return undefined;
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    typeof lengthDescriptor.value !== "number" ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > maximumLength
  ) {
    return undefined;
  }
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || !ownKeys.includes("length")) {
    return undefined;
  }
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!ownKeys.includes(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !descriptor.enumerable
    ) {
      return undefined;
    }
    copy[index] = descriptor.value;
  }
  return Object.freeze(copy);
}

function isCatalogObjectKind(value: unknown): value is CatalogObjectKind {
  return (
    typeof value === "string" &&
    (CATALOG_OBJECT_KINDS as readonly string[]).includes(value)
  );
}

function isMachineName(value: unknown, expression: RegExp): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_MACHINE_NAME_LENGTH &&
    expression.test(value)
  );
}

function isLowercaseSha256(value: unknown): value is string {
  return typeof value === "string" && LOWERCASE_SHA256.test(value);
}

function parseLifecycleTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") {
    if (!CANONICAL_UTC_TIMESTAMP.test(value)) return undefined;
    return new Date(value).toISOString() === value ? value : undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Date.prototype ||
    Reflect.ownKeys(value).length !== 0
  ) {
    return undefined;
  }
  const milliseconds = Date.prototype.getTime.call(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : undefined;
}

function parseMigrationRow(
  value: unknown,
): PrismaMigrationInventoryRow | undefined {
  const fields = readExactDataFields(value, [
    "migration_name",
    "checksum",
    "finished_at",
    "rolled_back_at",
  ]);
  const finishedAt = fields && parseLifecycleTimestamp(fields[2]);
  const rolledBackAt = fields && parseLifecycleTimestamp(fields[3]);
  if (
    fields === undefined ||
    !isMachineName(fields[0], MIGRATION_NAME) ||
    !isLowercaseSha256(fields[1]) ||
    finishedAt === undefined ||
    rolledBackAt === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    migration_name: fields[0],
    checksum: fields[1],
    finished_at: finishedAt,
    rolled_back_at: rolledBackAt,
  });
}

function parseCatalogRecord(
  value: unknown,
): CatalogInventoryRecord | undefined {
  const fields = readExactDataFields(value, ["kind", "name"]);
  if (
    fields === undefined ||
    !isCatalogObjectKind(fields[0]) ||
    !isMachineName(fields[1], CATALOG_NAME)
  ) {
    return undefined;
  }
  return Object.freeze({ kind: fields[0], name: fields[1] });
}

function parseExpectedMigration(
  value: unknown,
): ExpectedMigrationChecksum | undefined {
  const fields = readExactDataFields(value, ["migrationName", "checksum"]);
  if (
    fields === undefined ||
    !isMachineName(fields[0], MIGRATION_NAME) ||
    !isLowercaseSha256(fields[1])
  ) {
    return undefined;
  }
  return Object.freeze({
    migrationName: fields[0],
    checksum: fields[1],
  });
}

function parseDenseRecords<T>(
  values: readonly unknown[],
  parser: (value: unknown) => T | undefined,
): readonly T[] | undefined {
  const records: T[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const record = parser(values[index]);
    if (record === undefined) return undefined;
    records[index] = record;
  }
  return Object.freeze(records);
}

function parseInventoryInput(
  migrationInventory: unknown,
  catalogInventory: unknown,
  expectedCurrentRaw: unknown,
  expectedIdentitySuccessor: unknown,
): ValidatedInventoryInput | undefined {
  try {
    const migrationRows = readDenseArray(
      migrationInventory,
      MAX_MIGRATION_INVENTORY_ROWS,
    );
    const catalogRows = readDenseArray(
      catalogInventory,
      MAX_CATALOG_INVENTORY_ROWS,
    );
    const expectedRawRows = readDenseArray(
      expectedCurrentRaw,
      MAX_EXPECTED_MIGRATIONS,
    );
    const expectedIdentityRows = readDenseArray(
      expectedIdentitySuccessor,
      MAX_EXPECTED_MIGRATIONS,
    );
    if (
      migrationRows === undefined ||
      catalogRows === undefined ||
      expectedRawRows === undefined ||
      expectedIdentityRows === undefined
    ) {
      return undefined;
    }
    const parsedMigrationInventory = parseDenseRecords(
      migrationRows,
      parseMigrationRow,
    );
    const parsedCatalogInventory = parseDenseRecords(
      catalogRows,
      parseCatalogRecord,
    );
    const parsedExpectedCurrentRaw = parseDenseRecords(
      expectedRawRows,
      parseExpectedMigration,
    );
    const parsedExpectedIdentitySuccessor = parseDenseRecords(
      expectedIdentityRows,
      parseExpectedMigration,
    );
    if (
      parsedMigrationInventory === undefined ||
      parsedCatalogInventory === undefined ||
      parsedExpectedCurrentRaw === undefined ||
      parsedExpectedIdentitySuccessor === undefined
    ) {
      return undefined;
    }
    return Object.freeze({
      migrationInventory: parsedMigrationInventory,
      catalogInventory: parsedCatalogInventory,
      expectedCurrentRaw: parsedExpectedCurrentRaw,
      expectedIdentitySuccessor: parsedExpectedIdentitySuccessor,
    });
  } catch {
    return undefined;
  }
}

function invalidInventoryInputDecision(): OrganizationIdentityMigrationDecision {
  return decision({
    subject: "UNKNOWN",
    decision: "HOLD",
    state: "INVALID_INVENTORY_INPUT",
    observations: [
      {
        kind: "MIGRATION",
        name: "inventory-input",
        reasonCode: "INVALID_INVENTORY_INPUT",
      },
    ],
  });
}

function groupRowsByName(
  inventory: readonly PrismaMigrationInventoryRow[],
): ReadonlyMap<string, readonly PrismaMigrationInventoryRow[]> {
  const rowsByName = new Map<string, PrismaMigrationInventoryRow[]>();
  for (const row of inventory) {
    const rows = rowsByName.get(row.migration_name) ?? [];
    rows.push(row);
    rowsByName.set(row.migration_name, rows);
  }
  return rowsByName;
}

function lifecycle(
  rows: readonly PrismaMigrationInventoryRow[],
): MigrationLifecycle {
  if (rows.length !== 1) return "CONFLICT";
  if (rows[0]!.rolled_back_at !== null) return "ROLLED_BACK";
  return rows[0]!.finished_at === null ? "UNFINISHED" : "APPLIED";
}

function checksums(
  rows: readonly PrismaMigrationInventoryRow[],
): readonly string[] {
  return [...new Set(rows.map((row) => row.checksum))].sort();
}

function migrationObservation(
  expected: ExpectedMigrationChecksum,
  rows: readonly PrismaMigrationInventoryRow[],
  reasonCode: string,
  actualName = expected.migrationName,
): OrganizationIdentityMigrationObservation {
  const observedChecksums = checksums(rows);
  return {
    kind: "MIGRATION",
    name: actualName,
    ...(actualName === expected.migrationName
      ? {}
      : { expectedName: expected.migrationName }),
    observedChecksum:
      observedChecksums.length === 1 ? observedChecksums[0]! : null,
    ...(observedChecksums.length > 1 ? { observedChecksums } : {}),
    expectedChecksum: expected.checksum,
    rowCount: rows.length,
    lifecycleState: lifecycle(rows),
    reasonCode,
  };
}

function rawHoldObservations(
  rawDecision: RawSourceMigrationDecision,
): readonly OrganizationIdentityMigrationObservation[] {
  return rawDecision.observations.map((observation) =>
    Object.freeze({
      kind: "MIGRATION" as const,
      name: observation.migrationName,
      ...(observation.expectedMigrationName
        ? { expectedName: observation.expectedMigrationName }
        : {}),
      ...(observation.observedChecksum !== undefined
        ? { observedChecksum: observation.observedChecksum }
        : {}),
      ...(observation.observedChecksums
        ? { observedChecksums: observation.observedChecksums }
        : {}),
      ...(observation.expectedChecksum !== undefined
        ? { expectedChecksum: observation.expectedChecksum }
        : {}),
      ...(observation.rowCount !== undefined
        ? { rowCount: observation.rowCount }
        : {}),
      ...(observation.lifecycleState
        ? { lifecycleState: observation.lifecycleState }
        : {}),
      reasonCode: `RAW_${rawDecision.state}`,
    }),
  );
}

/**
 * Pure Gate 0 inventory decision. It never opens a database connection or
 * accepts SQL; callers supply only sanitized migration and catalog records.
 */
export function assessOrganizationIdentityMigrationInventory(
  migrationInventory: readonly PrismaMigrationInventoryRow[] | undefined,
  catalogInventory: readonly CatalogInventoryRecord[] | undefined,
  expectedCurrentRaw: readonly ExpectedMigrationChecksum[],
  expectedIdentitySuccessor: readonly ExpectedMigrationChecksum[],
): OrganizationIdentityMigrationDecision {
  if (migrationInventory === undefined || catalogInventory === undefined) {
    return decision({
      subject: "UNKNOWN",
      decision: "HOLD",
      state: "INVENTORY_NOT_SUPPLIED",
      observations: [],
    });
  }

  try {
    const parsedInput = parseInventoryInput(
      migrationInventory,
      catalogInventory,
      expectedCurrentRaw,
      expectedIdentitySuccessor,
    );
    if (parsedInput === undefined) return invalidInventoryInputDecision();
    if (parsedInput.expectedCurrentRaw.length === 0) {
      return decision({
        subject: "SUPPLIED",
        decision: "HOLD",
        state: "RAW_SOURCE_LINEAGE_HOLD",
        observations: [
          {
            kind: "MIGRATION",
            name: "raw-source-current-successor",
            reasonCode: "RAW_CURRENT_SUCCESSOR_REQUIRED",
          },
        ],
      });
    }

    const {
      migrationInventory: validatedMigrationInventory,
      catalogInventory: validatedCatalogInventory,
      expectedCurrentRaw: validatedExpectedCurrentRaw,
      expectedIdentitySuccessor: validatedExpectedIdentitySuccessor,
    } = parsedInput;

    const rowsByName = groupRowsByName(validatedMigrationInventory);
    const historicalChecksumMatches =
      HISTORICAL_ORGANIZATION_IDENTITY_MIGRATIONS.flatMap((historical) => {
        const actualNames = [
          ...new Set(
            validatedMigrationInventory
              .filter((row) => row.checksum === historical.checksum)
              .map((row) => row.migration_name),
          ),
        ];
        return actualNames.map((actualName) =>
          migrationObservation(
            historical,
            rowsByName.get(actualName) ?? [],
            "HISTORICAL_MIGRATION_CHECKSUM_PRESENT",
            actualName,
          ),
        );
      });
    if (historicalChecksumMatches.length) {
      return decision({
        subject: "SUPPLIED",
        decision: "HOLD",
        state: "OLD_IDENTITY_MIGRATION_PRESENT",
        observations: historicalChecksumMatches,
      });
    }

    const historicalNameMatches =
      HISTORICAL_ORGANIZATION_IDENTITY_MIGRATIONS.flatMap((historical) => {
        const rows = rowsByName.get(historical.migrationName) ?? [];
        return rows.length
          ? [
              migrationObservation(
                historical,
                rows,
                "HISTORICAL_MIGRATION_NAME_PRESENT",
              ),
            ]
          : [];
      });
    if (historicalNameMatches.length) {
      return decision({
        subject: "SUPPLIED",
        decision: "HOLD",
        state: "OLD_IDENTITY_MIGRATION_PRESENT",
        observations: historicalNameMatches,
      });
    }

    const historicalObjects = validatedCatalogInventory.filter((observed) =>
      FORBIDDEN_HISTORICAL_IDENTITY_CATALOG_OBJECTS.some(
        (forbidden) =>
          forbidden.kind === observed.kind && forbidden.name === observed.name,
      ),
    );
    if (historicalObjects.length) {
      return decision({
        subject: "SUPPLIED",
        decision: "HOLD",
        state: "OLD_IDENTITY_OBJECT_RESIDUE_PRESENT",
        observations: historicalObjects.map((object) => ({
          kind: object.kind,
          name: object.name,
          reasonCode: "HISTORICAL_CATALOG_OBJECT_PRESENT",
        })),
      });
    }

    const rawDecision = assessRawSourceMigrationInventory(
      validatedMigrationInventory,
      validatedExpectedCurrentRaw,
    );
    if (rawDecision.decision === "HOLD") {
      return decision({
        subject: "SUPPLIED",
        decision: "HOLD",
        state: "RAW_SOURCE_LINEAGE_HOLD",
        observations: rawHoldObservations(rawDecision),
      });
    }

    const conflicts = validatedExpectedIdentitySuccessor.flatMap((expected) => {
      const rows = rowsByName.get(expected.migrationName) ?? [];
      return rows.length > 1
        ? [
            migrationObservation(
              expected,
              rows,
              "EXPECTED_SUCCESSOR_DUPLICATE_OR_CONFLICTING",
            ),
          ]
        : [];
    });
    if (conflicts.length) {
      return decision({
        subject: "SUPPLIED",
        decision: "HOLD",
        state: "MIGRATION_INVENTORY_CONFLICT",
        observations: conflicts,
      });
    }

    const mismatches = validatedExpectedIdentitySuccessor.flatMap(
      (expected) => {
        const rows = rowsByName.get(expected.migrationName) ?? [];
        return rows.length === 1 && rows[0]!.checksum !== expected.checksum
          ? [
              migrationObservation(
                expected,
                rows,
                "EXPECTED_SUCCESSOR_CHECKSUM_MISMATCH",
              ),
            ]
          : [];
      },
    );
    if (mismatches.length) {
      return decision({
        subject: "SUPPLIED",
        decision: "HOLD",
        state: "SUCCESSOR_CHECKSUM_MISMATCH",
        observations: mismatches,
      });
    }

    const incomplete = validatedExpectedIdentitySuccessor.flatMap(
      (expected) => {
        const rows = rowsByName.get(expected.migrationName) ?? [];
        if (rows.length === 1 && lifecycle(rows) === "APPLIED") return [];
        if (!rows.length) {
          return [
            {
              kind: "MIGRATION" as const,
              name: expected.migrationName,
              observedChecksum: null,
              expectedChecksum: expected.checksum,
              rowCount: 0,
              reasonCode: "EXPECTED_SUCCESSOR_NOT_APPLIED",
            },
          ];
        }
        return [
          migrationObservation(
            expected,
            rows,
            "EXPECTED_SUCCESSOR_NOT_APPLIED",
          ),
        ];
      },
    );
    if (incomplete.length) {
      return decision({
        subject: "SUPPLIED",
        decision: "HOLD",
        state: "CURRENT_IDENTITY_SUCCESSOR_INCOMPLETE",
        observations: incomplete,
      });
    }

    return decision({
      subject: "SUPPLIED",
      decision: "GO",
      state:
        validatedExpectedIdentitySuccessor.length === 0
          ? "CURRENT_MAIN_READY_FOR_IDENTITY_SUCCESSOR"
          : "CURRENT_IDENTITY_SUCCESSOR_APPLIED",
      observations: [],
    });
  } catch {
    return invalidInventoryInputDecision();
  }
}
