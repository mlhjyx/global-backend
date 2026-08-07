import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACQUISITION_COMPLIANCE_ISOLATED_DATABASE_AUTHORIZATION,
  ACQUISITION_COMPLIANCE_POSTGRES_NOT_RUN,
  SUPPRESSION_RELEASE_GOVERNANCE_MIGRATION,
  assertComplianceCatalogFacts,
  assertIsolatedDatabaseRoleFacts,
  resolveAcquisitionComplianceVerifierEnvironment,
  type ComplianceCatalogFacts,
  type DatabaseRoleFacts,
} from "../../scripts/verify-acquisition-compliance-postgres.mts";

const databaseName = "codex_acquisition_compliance_test_integrity";
const ownerUrl = `postgresql://compliance_owner:owner-secret@127.0.0.1:5432/${databaseName}`;
const appUrl = `postgresql://app_user:app-secret@127.0.0.1:5432/${databaseName}`;

function environment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    ACQUISITION_COMPLIANCE_TEST_DB_AUTHORIZATION:
      ACQUISITION_COMPLIANCE_ISOLATED_DATABASE_AUTHORIZATION,
    ACQUISITION_COMPLIANCE_TEST_OWNER_DATABASE_URL: ownerUrl,
    ACQUISITION_COMPLIANCE_TEST_APP_DATABASE_URL: appUrl,
    ...overrides,
  };
}

const ownerRole: DatabaseRoleFacts = {
  roleName: "compliance_owner",
  databaseName,
  superuser: false,
  bypassRls: false,
  databaseOwnerMember: true,
  ownsAnyRequiredRelation: true,
  ownsAllRequiredRelations: true,
};

const appRole: DatabaseRoleFacts = {
  roleName: "app_user",
  databaseName,
  superuser: false,
  bypassRls: false,
  databaseOwnerMember: false,
  ownsAnyRequiredRelation: false,
  ownsAllRequiredRelations: false,
};

const catalogFacts: ComplianceCatalogFacts = {
  migrationApplied: true,
  relations: [
    {
      tableName: "suppression_record",
      rowLevelSecurity: true,
      forceRowLevelSecurity: true,
    },
    {
      tableName: "suppression_release_decision",
      rowLevelSecurity: true,
      forceRowLevelSecurity: true,
    },
    {
      tableName: "policy_decision_log",
      rowLevelSecurity: true,
      forceRowLevelSecurity: true,
    },
  ],
  privileges: [
    {
      tableName: "suppression_record",
      select: true,
      insert: true,
      update: false,
      delete: false,
      truncate: false,
    },
    {
      tableName: "suppression_release_decision",
      select: true,
      insert: true,
      update: false,
      delete: false,
      truncate: false,
    },
    {
      tableName: "policy_decision_log",
      select: true,
      insert: true,
      update: false,
      delete: false,
      truncate: false,
    },
  ],
};

describe("acquisition compliance PostgreSQL verifier admission", () => {
  it("defaults to NOT_RUN and accepts only the exact isolated-database acknowledgment", () => {
    expect(() =>
      resolveAcquisitionComplianceVerifierEnvironment({}),
    ).toThrowError(ACQUISITION_COMPLIANCE_POSTGRES_NOT_RUN);

    for (const authorization of [
      "",
      "true",
      `${ACQUISITION_COMPLIANCE_ISOLATED_DATABASE_AUTHORIZATION} `,
      ACQUISITION_COMPLIANCE_ISOLATED_DATABASE_AUTHORIZATION.toLowerCase(),
    ]) {
      expect(() =>
        resolveAcquisitionComplianceVerifierEnvironment(
          environment({
            ACQUISITION_COMPLIANCE_TEST_DB_AUTHORIZATION: authorization,
          }),
        ),
      ).toThrowError(ACQUISITION_COMPLIANCE_POSTGRES_NOT_RUN);
    }
  });

  it("requires two explicit PostgreSQL URLs and never accepts a generic fallback", () => {
    for (const missing of [
      "ACQUISITION_COMPLIANCE_TEST_OWNER_DATABASE_URL",
      "ACQUISITION_COMPLIANCE_TEST_APP_DATABASE_URL",
    ]) {
      expect(() =>
        resolveAcquisitionComplianceVerifierEnvironment(
          environment({
            [missing]: undefined,
            DATABASE_URL:
              "postgresql://global:do-not-use@127.0.0.1:5432/global_dev",
            OWNER_DATABASE_URL:
              "postgresql://global:do-not-use@127.0.0.1:5432/global_dev",
            APP_DATABASE_URL:
              "postgresql://app_user:do-not-use@127.0.0.1:5432/global_dev",
          }),
        ),
      ).toThrowError(ACQUISITION_COMPLIANCE_POSTGRES_NOT_RUN);
    }
  });

  it("admits only the same strictly prefixed database on one endpoint with distinct URL roles", () => {
    expect(
      resolveAcquisitionComplianceVerifierEnvironment(environment()),
    ).toEqual({
      ownerUrl,
      appUrl,
      databaseName,
      ownerRoleName: "compliance_owner",
      appRoleName: "app_user",
    });

    for (const [key, value] of [
      [
        "ACQUISITION_COMPLIANCE_TEST_OWNER_DATABASE_URL",
        "postgresql://compliance_owner:secret@127.0.0.1:5432/global_dev",
      ],
      [
        "ACQUISITION_COMPLIANCE_TEST_OWNER_DATABASE_URL",
        "postgresql://compliance_owner:secret@127.0.0.1:5432/codex_acquisition_compliance_test_",
      ],
      [
        "ACQUISITION_COMPLIANCE_TEST_APP_DATABASE_URL",
        `postgresql://compliance_owner:other-secret@127.0.0.1:5432/${databaseName}`,
      ],
      [
        "ACQUISITION_COMPLIANCE_TEST_APP_DATABASE_URL",
        "postgresql://app_user:secret@127.0.0.1:5432/codex_acquisition_compliance_test_other",
      ],
      [
        "ACQUISITION_COMPLIANCE_TEST_APP_DATABASE_URL",
        `postgresql://app_user:secret@db.example.invalid:5432/${databaseName}`,
      ],
      [
        "ACQUISITION_COMPLIANCE_TEST_APP_DATABASE_URL",
        `mysql://app_user:secret@127.0.0.1:5432/${databaseName}`,
      ],
    ] as const) {
      expect(() =>
        resolveAcquisitionComplianceVerifierEnvironment(
          environment({ [key]: value }),
        ),
      ).toThrowError(/ACQUISITION_COMPLIANCE_TEST_DATABASE_REJECTED/);
    }
  });

  it("never includes credential-bearing URL values in admission errors", () => {
    const sensitiveMarker = "credential-that-must-not-appear";
    let rendered = "";
    try {
      resolveAcquisitionComplianceVerifierEnvironment(
        environment({
          ACQUISITION_COMPLIANCE_TEST_OWNER_DATABASE_URL: `not-a-url-${sensitiveMarker}`,
        }),
      );
    } catch (error) {
      rendered = String(error);
    }
    expect(rendered).not.toContain(sensitiveMarker);
  });
});

describe("acquisition compliance PostgreSQL verifier role and catalog facts", () => {
  it("requires the app role to be non-superuser, non-BYPASSRLS, non-owner and distinct", () => {
    const config =
      resolveAcquisitionComplianceVerifierEnvironment(environment());
    expect(assertIsolatedDatabaseRoleFacts(config, ownerRole, appRole)).toEqual(
      {
        owner: ownerRole,
        app: appRole,
      },
    );

    for (const unsafe of [
      { ...appRole, superuser: true },
      { ...appRole, bypassRls: true },
      { ...appRole, databaseOwnerMember: true },
      { ...appRole, ownsAnyRequiredRelation: true },
      { ...appRole, roleName: ownerRole.roleName },
    ]) {
      expect(() =>
        assertIsolatedDatabaseRoleFacts(config, ownerRole, unsafe),
      ).toThrowError(/ACQUISITION_COMPLIANCE_APP_ROLE_UNSAFE/);
    }
  });

  it("requires the owner connection to own the database and every protected relation", () => {
    const config =
      resolveAcquisitionComplianceVerifierEnvironment(environment());
    for (const unsafe of [
      { ...ownerRole, databaseOwnerMember: false },
      { ...ownerRole, ownsAllRequiredRelations: false },
      { ...ownerRole, roleName: appRole.roleName },
      { ...ownerRole, databaseName: "codex_acquisition_compliance_test_other" },
    ]) {
      expect(() =>
        assertIsolatedDatabaseRoleFacts(config, unsafe, appRole),
      ).toThrowError(/ACQUISITION_COMPLIANCE_OWNER_ROLE_UNSAFE/);
    }
  });

  it("requires the target migration, RLS/FORCE and SELECT+INSERT-only app grants", () => {
    expect(assertComplianceCatalogFacts(catalogFacts)).toEqual(catalogFacts);

    expect(() =>
      assertComplianceCatalogFacts({
        ...catalogFacts,
        migrationApplied: false,
      }),
    ).toThrowError(/ACQUISITION_COMPLIANCE_MIGRATION_MISSING/);

    for (const relationKey of [
      "rowLevelSecurity",
      "forceRowLevelSecurity",
    ] as const) {
      expect(() =>
        assertComplianceCatalogFacts({
          ...catalogFacts,
          relations: catalogFacts.relations.map((relation) =>
            relation.tableName === "suppression_release_decision"
              ? { ...relation, [relationKey]: false }
              : relation,
          ),
        }),
      ).toThrowError(/ACQUISITION_COMPLIANCE_RLS_UNSAFE/);
    }

    for (const privilegeKey of ["update", "delete", "truncate"] as const) {
      expect(() =>
        assertComplianceCatalogFacts({
          ...catalogFacts,
          privileges: catalogFacts.privileges.map((privilege) =>
            privilege.tableName === "policy_decision_log"
              ? { ...privilege, [privilegeKey]: true }
              : privilege,
          ),
        }),
      ).toThrowError(/ACQUISITION_COMPLIANCE_APPEND_ONLY_UNSAFE/);
    }
  });
});

describe("acquisition compliance PostgreSQL verifier implementation integrity", () => {
  const apiRoot = resolve(__dirname, "../..");
  const scriptPath = resolve(
    apiRoot,
    "scripts/verify-acquisition-compliance-postgres.mts",
  );

  it("does not load dotenv, read .env, or consult ordinary database URL names", () => {
    const script = readFileSync(scriptPath, "utf8");
    expect(script).not.toMatch(/dotenv/i);
    expect(script).not.toMatch(/(?:readFile|readFileSync)[^\n]*\.env/i);
    expect(script).not.toMatch(
      /process\.env\.(?:DATABASE_URL|OWNER_DATABASE_URL|APP_DATABASE_URL)\b/,
    );
    expect(script).not.toContain("global_dev");
  });

  it("probes PostgreSQL facts and exercises RLS plus denied mutations for all protected tables", () => {
    const script = readFileSync(scriptPath, "utf8");
    for (const token of [
      "rolsuper",
      "rolbypassrls",
      "datdba",
      "relowner",
      "_prisma_migrations",
      "relrowsecurity",
      "relforcerowsecurity",
      "has_table_privilege",
      "set_config('app.current_workspace_id'",
    ]) {
      expect(script).toContain(token);
    }
    for (const table of [
      "suppression_record",
      "suppression_release_decision",
      "policy_decision_log",
    ]) {
      expect(script).toContain(`\"${table}\"`);
      expect(script).toMatch(new RegExp(`UPDATE \\"${table}\\"`, "i"));
      expect(script).toMatch(new RegExp(`DELETE FROM \\"${table}\\"`, "i"));
    }
    expect(script).toContain("verifyWorkspaceIsolation");
    expect(script).toContain("otherWorkspaceId");
  });

  it("uses random non-personal fixtures, guarded owner cleanup and import-safe direct execution", () => {
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("randomUUID");
    expect(script).toContain(".invalid");
    expect(script).not.toMatch(/[A-Z0-9._%+-]+@(?:example|test)\.[A-Z]{2,}/i);
    expect(script).toContain("cleanupVerifiedIsolatedDatabaseFixtures");
    expect(script).toMatch(/fileURLToPath\(import\.meta\.url\)/);
    expect(script).toMatch(/if\s*\(\s*isDirectExecution\(\)\s*\)/);
  });

  it("exposes a package command without an environment-file loader", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(apiRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["verify:acquisition-compliance:postgres"]).toBe(
      "node --import tsx scripts/verify-acquisition-compliance-postgres.mts",
    );
  });
});

expect(SUPPRESSION_RELEASE_GOVERNANCE_MIGRATION).toBe(
  "20260807234500_suppression_release_governance",
);
