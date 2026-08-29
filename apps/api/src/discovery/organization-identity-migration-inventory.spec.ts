import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_HISTORICAL_IDENTITY_CATALOG_OBJECTS,
  HISTORICAL_ORGANIZATION_IDENTITY_MIGRATIONS,
  assessOrganizationIdentityMigrationInventory,
  type CatalogInventoryRecord,
} from "./organization-identity-migration-inventory";

const completed = new Date("2026-08-29T00:00:00.000Z");

const expectedRaw = [
  {
    migrationName: "20260826250000_raw_source_ted_identifier_contact_gate",
    checksum: "0f".repeat(32),
  },
] as const;

const expectedIdentity = [
  {
    migrationName: "20260829090000_organization_identity_successor",
    checksum: "a".repeat(64),
  },
  {
    migrationName: "20260829100000_provider_quality_successor",
    checksum: "b".repeat(64),
  },
] as const;

function exactRawInventory() {
  return expectedRaw.map((entry) => ({
    migration_name: entry.migrationName,
    checksum: entry.checksum,
    finished_at: completed,
    rolled_back_at: null,
  }));
}

function exactIdentityInventory() {
  return expectedIdentity.map((entry) => ({
    migration_name: entry.migrationName,
    checksum: entry.checksum,
    finished_at: completed,
    rolled_back_at: null,
  }));
}

function assess(
  migrations = [...exactRawInventory(), ...exactIdentityInventory()],
  objects: readonly CatalogInventoryRecord[] = [],
  expected = expectedIdentity,
) {
  return assessOrganizationIdentityMigrationInventory(
    migrations,
    objects,
    expectedRaw,
    expected,
  );
}

describe("Organization Identity/Provider migration provenance Gate 0", () => {
  it("returns UNKNOWN/HOLD when either required inventory is absent", () => {
    expect(
      assessOrganizationIdentityMigrationInventory(
        undefined,
        undefined,
        expectedRaw,
        expectedIdentity,
      ),
    ).toEqual({
      schemaVersion: "organization-identity-migration-decision/v1",
      subject: "UNKNOWN",
      decision: "HOLD",
      state: "INVENTORY_NOT_SUPPLIED",
      observations: [],
    });

    expect(
      assessOrganizationIdentityMigrationInventory(
        exactRawInventory(),
        undefined,
        expectedRaw,
        expectedIdentity,
      ),
    ).toMatchObject({ subject: "UNKNOWN", decision: "HOLD" });
  });

  it.each(HISTORICAL_ORGANIZATION_IDENTITY_MIGRATIONS)(
    "holds each historical migration name regardless of checksum or lifecycle: $migrationName",
    (entry) => {
      expect(
        assess([
          ...exactRawInventory(),
          ...exactIdentityInventory(),
          {
            migration_name: entry.migrationName,
            checksum: "f".repeat(64),
            finished_at: null,
            rolled_back_at: completed,
          },
        ]),
      ).toMatchObject({
        subject: "SUPPLIED",
        decision: "HOLD",
        state: "OLD_IDENTITY_MIGRATION_PRESENT",
        observations: [
          expect.objectContaining({
            kind: "MIGRATION",
            name: entry.migrationName,
            expectedChecksum: entry.checksum,
            lifecycleState: "ROLLED_BACK",
            reasonCode: "HISTORICAL_MIGRATION_NAME_PRESENT",
          }),
        ],
      });
    },
  );

  it.each(HISTORICAL_ORGANIZATION_IDENTITY_MIGRATIONS)(
    "holds each historical checksum under a renamed migration: $migrationName",
    (entry) => {
      const renamed = `20260829999999_renamed_${entry.migrationName}`;
      expect(
        assess([
          ...exactRawInventory(),
          ...exactIdentityInventory(),
          {
            migration_name: renamed,
            checksum: entry.checksum,
            finished_at: completed,
            rolled_back_at: null,
          },
        ]),
      ).toMatchObject({
        decision: "HOLD",
        state: "OLD_IDENTITY_MIGRATION_PRESENT",
        observations: [
          expect.objectContaining({
            kind: "MIGRATION",
            name: renamed,
            expectedName: entry.migrationName,
            observedChecksum: entry.checksum,
            expectedChecksum: entry.checksum,
            reasonCode: "HISTORICAL_MIGRATION_CHECKSUM_PRESENT",
          }),
        ],
      });
    },
  );

  it.each(FORBIDDEN_HISTORICAL_IDENTITY_CATALOG_OBJECTS)(
    "holds each forbidden historical catalog object: $kind $name",
    (object) => {
      expect(assess(undefined, [object])).toMatchObject({
        subject: "SUPPLIED",
        decision: "HOLD",
        state: "OLD_IDENTITY_OBJECT_RESIDUE_PRESENT",
        observations: [
          {
            kind: object.kind,
            name: object.name,
            reasonCode: "HISTORICAL_CATALOG_OBJECT_PRESENT",
          },
        ],
      });
    },
  );

  it("holds duplicate and checksum-conflicting expected successor rows", () => {
    const duplicated = expectedIdentity[0]!;
    expect(
      assess([
        ...exactRawInventory(),
        ...exactIdentityInventory(),
        {
          migration_name: duplicated.migrationName,
          checksum: "c".repeat(64),
          finished_at: completed,
          rolled_back_at: null,
        },
      ]),
    ).toMatchObject({
      decision: "HOLD",
      state: "MIGRATION_INVENTORY_CONFLICT",
      observations: [
        expect.objectContaining({
          kind: "MIGRATION",
          name: duplicated.migrationName,
          rowCount: 2,
          lifecycleState: "CONFLICT",
          observedChecksum: null,
          observedChecksums: ["a".repeat(64), "c".repeat(64)],
          reasonCode: "EXPECTED_SUCCESSOR_DUPLICATE_OR_CONFLICTING",
        }),
      ],
    });
  });

  it.each([
    ["unfinished", null, null, "UNFINISHED"],
    ["rolled back", completed, completed, "ROLLED_BACK"],
  ] as const)(
    "holds an expected successor row that is %s",
    (_label, finishedAt, rolledBackAt, lifecycleState) => {
      const incomplete = expectedIdentity[0]!;
      expect(
        assess([
          ...exactRawInventory(),
          {
            migration_name: incomplete.migrationName,
            checksum: incomplete.checksum,
            finished_at: finishedAt,
            rolled_back_at: rolledBackAt,
          },
          ...exactIdentityInventory().slice(1),
        ]),
      ).toMatchObject({
        decision: "HOLD",
        state: "CURRENT_IDENTITY_SUCCESSOR_INCOMPLETE",
        observations: [
          expect.objectContaining({
            name: incomplete.migrationName,
            lifecycleState,
            reasonCode: "EXPECTED_SUCCESSOR_NOT_APPLIED",
          }),
        ],
      });
    },
  );

  it("propagates a current Raw lineage HOLD before assessing the successor", () => {
    expect(
      assess(
        [
          ...exactIdentityInventory(),
          {
            migration_name: expectedRaw[0]!.migrationName,
            checksum: "d".repeat(64),
            finished_at: completed,
            rolled_back_at: null,
          },
        ],
        [],
      ),
    ).toMatchObject({
      subject: "SUPPLIED",
      decision: "HOLD",
      state: "RAW_SOURCE_LINEAGE_HOLD",
      observations: [
        expect.objectContaining({
          kind: "MIGRATION",
          name: expectedRaw[0]!.migrationName,
          reasonCode: "RAW_SUCCESSOR_CHECKSUM_MISMATCH",
        }),
      ],
    });
  });

  it("returns current-main readiness when Raw is exact and no Identity successor is expected", () => {
    expect(assess(exactRawInventory(), [], [])).toEqual({
      schemaVersion: "organization-identity-migration-decision/v1",
      subject: "SUPPLIED",
      decision: "GO",
      state: "CURRENT_MAIN_READY_FOR_IDENTITY_SUCCESSOR",
      observations: [],
    });
  });

  it("returns applied readiness only for every exact future Identity successor", () => {
    expect(assess()).toEqual({
      schemaVersion: "organization-identity-migration-decision/v1",
      subject: "SUPPLIED",
      decision: "GO",
      state: "CURRENT_IDENTITY_SUCCESSOR_APPLIED",
      observations: [],
    });
  });

  it("holds a checksum mismatch and a missing expected Identity successor", () => {
    const mismatch = expectedIdentity[0]!;
    expect(
      assess([
        ...exactRawInventory(),
        {
          migration_name: mismatch.migrationName,
          checksum: "d".repeat(64),
          finished_at: completed,
          rolled_back_at: null,
        },
        ...exactIdentityInventory().slice(1),
      ]),
    ).toMatchObject({
      decision: "HOLD",
      state: "SUCCESSOR_CHECKSUM_MISMATCH",
      observations: [
        expect.objectContaining({
          name: mismatch.migrationName,
          expectedChecksum: mismatch.checksum,
          reasonCode: "EXPECTED_SUCCESSOR_CHECKSUM_MISMATCH",
        }),
      ],
    });

    expect(
      assess([
        ...exactRawInventory(),
        {
          migration_name: expectedIdentity[0]!.migrationName,
          checksum: expectedIdentity[0]!.checksum,
          finished_at: completed,
          rolled_back_at: null,
        },
      ]),
    ).toMatchObject({
      decision: "HOLD",
      state: "CURRENT_IDENTITY_SUCCESSOR_INCOMPLETE",
      observations: [
        expect.objectContaining({
          name: expectedIdentity[1]!.migrationName,
          rowCount: 0,
          reasonCode: "EXPECTED_SUCCESSOR_NOT_APPLIED",
        }),
      ],
    });
  });

  it.each([
    [
      "an oversized migration inventory",
      Array.from({ length: 513 }, () => exactRawInventory()[0]!),
      [] as const,
      expectedRaw,
      [] as const,
    ],
    [
      "a catalog record with an extra field",
      exactRawInventory(),
      [{ kind: "TABLE", name: "organization_identifier", sql: "SELECT 1" }],
      expectedRaw,
      [] as const,
    ],
    [
      "a catalog record with a non-catalog kind",
      exactRawInventory(),
      [{ kind: "SQL", name: "drop_table" }],
      expectedRaw,
      [] as const,
    ],
    [
      "a SQL-shaped catalog name",
      exactRawInventory(),
      [{ kind: "TABLE", name: "DROP TABLE organization_identifier" }],
      expectedRaw,
      [] as const,
    ],
    [
      "a URL-shaped migration name",
      [
        {
          migration_name:
            "postgresql://example-user:example-password@example.invalid/example-db",
          checksum: HISTORICAL_ORGANIZATION_IDENTITY_MIGRATIONS[0]!.checksum,
          finished_at: completed,
          rolled_back_at: null,
        },
      ],
      [] as const,
      expectedRaw,
      [] as const,
    ],
    [
      "a secret-shaped checksum",
      [
        {
          migration_name:
            HISTORICAL_ORGANIZATION_IDENTITY_MIGRATIONS[0]!.migrationName,
          checksum: "fake-secret-free-text-not-a-sha256",
          finished_at: completed,
          rolled_back_at: null,
        },
      ],
      [] as const,
      expectedRaw,
      [] as const,
    ],
    [
      "a non-canonical lifecycle timestamp",
      [
        {
          ...exactRawInventory()[0]!,
          finished_at: "2026-08-29 00:00:00",
        },
      ],
      [] as const,
      expectedRaw,
      [] as const,
    ],
    [
      "an invalid expected Raw checksum",
      exactRawInventory(),
      [] as const,
      [
        {
          migrationName: expectedRaw[0]!.migrationName,
          checksum: "A".repeat(64),
        },
      ],
      [] as const,
    ],
    [
      "an invalid expected Identity migration name",
      exactRawInventory(),
      [] as const,
      expectedRaw,
      [
        {
          migrationName: "not a migration name",
          checksum: "a".repeat(64),
        },
      ],
    ],
  ] as const)(
    "returns one redacted INVALID_INVENTORY_INPUT HOLD for %s",
    (_label, migrations, objects, raw, identity) => {
      const rejectedValues = JSON.stringify([
        migrations,
        objects,
        raw,
        identity,
      ]);
      const result = assessOrganizationIdentityMigrationInventory(
        migrations as never,
        objects as never,
        raw as never,
        identity as never,
      );

      expect(result).toEqual({
        schemaVersion: "organization-identity-migration-decision/v1",
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
      expect(JSON.stringify(result)).not.toContain(rejectedValues);
    },
  );

  it("holds an empty expected Raw lineage without weakening the existing Raw checker", () => {
    expect(
      assessOrganizationIdentityMigrationInventory(
        exactRawInventory(),
        [],
        [],
        [],
      ),
    ).toEqual({
      schemaVersion: "organization-identity-migration-decision/v1",
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
  });

  it.each([
    ["migration inventory", Array(1), [], expectedRaw, []],
    ["catalog inventory", exactRawInventory(), Array(1), expectedRaw, []],
    ["expected Raw lineage", exactRawInventory(), [], Array(1), []],
    [
      "expected Identity successor",
      exactRawInventory(),
      [],
      expectedRaw,
      Array(1),
    ],
  ] as const)(
    "rejects a sparse %s without throwing or reaching a GO decision",
    (_label, migrations, objects, raw, identity) => {
      let result: ReturnType<
        typeof assessOrganizationIdentityMigrationInventory
      >;
      expect(() => {
        result = assessOrganizationIdentityMigrationInventory(
          migrations as never,
          objects as never,
          raw as never,
          identity as never,
        );
      }).not.toThrow();
      expect(result!).toEqual({
        schemaVersion: "organization-identity-migration-decision/v1",
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
    },
  );

  it.each([
    ["an own map method", Object.assign([], { map: () => [] })],
    ["an own some method", Object.assign([], { some: () => false })],
    ["an extra string key", Object.assign([], { extra: "ignored" })],
    ["a symbol key", Object.assign([], { [Symbol("extra")]: "ignored" })],
    ["an array subclass", new (class extends Array<unknown> {})()],
    [
      "a throwing proxy",
      new Proxy([], {
        getOwnPropertyDescriptor() {
          throw new Error("untrusted reflection");
        },
      }),
    ],
  ] as const)(
    "rejects catalog inventory with %s using the fixed redacted HOLD",
    (_label, objects) => {
      let result: ReturnType<
        typeof assessOrganizationIdentityMigrationInventory
      >;
      expect(() => {
        result = assessOrganizationIdentityMigrationInventory(
          exactRawInventory(),
          objects as never,
          expectedRaw,
          [],
        );
      }).not.toThrow();
      expect(result!).toEqual({
        schemaVersion: "organization-identity-migration-decision/v1",
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
    },
  );

  it("rejects a revoked expected Raw proxy without throwing", () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    let result: ReturnType<typeof assessOrganizationIdentityMigrationInventory>;
    expect(() => {
      result = assessOrganizationIdentityMigrationInventory(
        exactRawInventory(),
        [],
        proxy as never,
        [],
      );
    }).not.toThrow();
    expect(result!).toMatchObject({
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
  });

  it.each([
    [
      "an invalid Date subclass that overrides getTime",
      new (class extends Date {
        override getTime() {
          return 0;
        }
      })("invalid"),
    ],
    [
      "an invalid Date with an own getTime method",
      Object.assign(new Date("invalid"), { getTime: () => 0 }),
    ],
    [
      "a valid Date with an own valueOf method",
      Object.assign(new Date("2026-08-29T00:00:00.000Z"), {
        valueOf: () => 0,
      }),
    ],
    [
      "a Date with an own throwing getTime accessor",
      Object.defineProperty(new Date("2026-08-29T00:00:00.000Z"), "getTime", {
        get() {
          throw new Error("untrusted Date method");
        },
      }),
    ],
    ["a Date proxy", new Proxy(new Date("2026-08-29T00:00:00.000Z"), {})],
  ] as const)(
    "rejects %s as a redacted invalid lifecycle without throwing",
    (_label, lifecycleValue) => {
      let result: ReturnType<
        typeof assessOrganizationIdentityMigrationInventory
      >;
      expect(() => {
        result = assessOrganizationIdentityMigrationInventory(
          [
            {
              ...exactRawInventory()[0]!,
              finished_at: lifecycleValue,
            },
          ] as never,
          [],
          expectedRaw,
          [],
        );
      }).not.toThrow();
      expect(result!).toEqual({
        schemaVersion: "organization-identity-migration-decision/v1",
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
    },
  );

  it("preserves a plain valid Date lifecycle as current-main readiness", () => {
    expect(assess(exactRawInventory(), [], [])).toEqual({
      schemaVersion: "organization-identity-migration-decision/v1",
      subject: "SUPPLIED",
      decision: "GO",
      state: "CURRENT_MAIN_READY_FOR_IDENTITY_SUCCESSOR",
      observations: [],
    });
  });

  it("rejects a revoked Date proxy without throwing", () => {
    const { proxy, revoke } = Proxy.revocable(
      new Date("2026-08-29T00:00:00.000Z"),
      {},
    );
    revoke();
    let result: ReturnType<typeof assessOrganizationIdentityMigrationInventory>;
    expect(() => {
      result = assessOrganizationIdentityMigrationInventory(
        [
          {
            ...exactRawInventory()[0]!,
            finished_at: proxy,
          },
        ] as never,
        [],
        expectedRaw,
        [],
      );
    }).not.toThrow();
    expect(result!).toMatchObject({
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
  });
});
