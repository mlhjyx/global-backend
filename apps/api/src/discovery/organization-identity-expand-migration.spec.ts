import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationName = "20260829090000_organization_identity_v2_expand_ddl";
const expandCommit = "3de138b66f9babb246173f1fcf04e94af49e632b";
const repositoryRoot = resolve(process.cwd(), "../..");
const migrationPath = resolve(
  repositoryRoot,
  `packages/db/prisma/migrations/${migrationName}/migration.sql`,
);
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8")
  : "";
const schema = execFileSync(
  "git",
  ["show", `${expandCommit}:packages/db/prisma/schema.prisma`],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
);

const tenantTables = [
  "organization_identifier",
  "organization_identity_conflict",
  "organization_identity_conflict_party",
  "organization_identity_decision",
  "organization_canonical_mapping",
  "organization_identity_replay",
] as const;

const enumValues = {
  organization_identifier_status: ["ACTIVE", "PENDING_CONFLICT", "REVOKED"],
  organization_identity_conflict_status: ["OPEN", "RESOLVING", "RESOLVED"],
  organization_identity_decision_action: ["MERGE", "KEEP_SEPARATE", "SPLIT"],
  organization_canonical_mapping_status: ["ACTIVE", "REVOKED"],
  organization_identity_replay_status: [
    "PENDING",
    "RUNNING",
    "SUCCEEDED",
    "FAILED",
  ],
  identity_link_status: ["ACTIVE", "PENDING_CONFLICT", "REVOKED"],
} as const;

function occurrences(haystack: string, expression: RegExp): number {
  return [...haystack.matchAll(expression)].length;
}

describe("Organization Identity v2 expand migration", () => {
  it("uses the single authorized successor migration path", () => {
    expect(existsSync(migrationPath), `${migrationName} must exist`).toBe(true);
  });

  it("is DDL/ACL-only and leaves every current Raw surface untouched", () => {
    expect(migration).toMatch(/^BEGIN;/u);
    expect(migration).toMatch(/COMMIT;\s*$/u);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/iu);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/iu);
    expect(migration).not.toMatch(
      /\bUPDATE\s+(?:"[a-z_]+"\.)?"?[a-z_]+"?\s+SET\b/iu,
    );
    expect(migration).not.toMatch(
      /ALTER\s+TABLE\s+"(?:raw_source_record|field_evidence|source_entity)"/iu,
    );
    expect(migration).not.toMatch(
      /provider_quality|runtime_component_heartbeat/iu,
    );
    expect(migration).not.toMatch(
      /SECURITY\s+DEFINER|CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|CREATE\s+TRIGGER/iu,
    );
  });

  it("bounds existing-table lock acquisition and the complete transaction", () => {
    expect(migration).toMatch(
      /^BEGIN;\n\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '60s';/u,
    );
    expect(occurrences(migration, /SET LOCAL lock_timeout/gu)).toBe(1);
    expect(occurrences(migration, /SET LOCAL statement_timeout/gu)).toBe(1);
  });

  it("creates exactly the six required enums and six required tenant tables", () => {
    expect(occurrences(migration, /CREATE TYPE\s+"[a-z_]+"\s+AS ENUM/gu)).toBe(
      6,
    );
    expect(occurrences(migration, /CREATE TABLE\s+"[a-z_]+"/gu)).toBe(6);

    for (const [name, values] of Object.entries(enumValues)) {
      const sqlValues = values.map((value) => `'${value}'`).join(", ");
      expect(migration).toContain(
        `CREATE TYPE "${name}" AS ENUM (${sqlValues});`,
      );
    }
    for (const table of tenantTables) {
      expect(migration).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it("gives every new identity row a database UUID and database timestamps", () => {
    for (const table of tenantTables) {
      expect(migration).toMatch(
        new RegExp(
          `CREATE TABLE "${table}"[\\s\\S]+?"id" UUID NOT NULL DEFAULT gen_random_uuid\\(\\)`,
          "u",
        ),
      );
    }
    expect(migration).not.toMatch(/"created_at" TIMESTAMP\(3\) NOT NULL,/u);
    expect(migration).toMatch(
      /"updated_at" TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/u,
    );
  });

  it("enforces identifier ownership, lifecycle, provenance and lookup contracts", () => {
    for (const required of [
      '"authority_provider_key" VARCHAR(128) NOT NULL',
      '"raw_record_id" UUID NOT NULL',
      '"conflict_id" UUID',
      '"provenance" JSONB NOT NULL',
      'CONSTRAINT "organization_identifier_value_not_blank_check"',
      'CONSTRAINT "organization_identifier_confidence_check"',
      'CONSTRAINT "organization_identifier_revocation_check"',
      'CONSTRAINT "organization_identifier_pending_conflict_owner_check"',
      'CREATE UNIQUE INDEX "organization_identifier_workspace_id_id_key"',
      'CREATE UNIQUE INDEX "organization_identifier_active_authority_key"',
      'CREATE UNIQUE INDEX "organization_identifier_conflict_claim_key"',
      'CREATE INDEX "organization_identifier_workspace_id_company_id_status_idx"',
      'CREATE INDEX "org_identifier_lookup_idx"',
    ]) {
      expect(migration).toContain(required);
    }
  });

  it("enforces conflict, decision, mapping and replay state shapes", () => {
    for (const required of [
      'CONSTRAINT "organization_identity_conflict_revision_check"',
      'CONSTRAINT "organization_identity_conflict_resolution_check"',
      'CREATE UNIQUE INDEX "organization_identity_conflict_workspace_fingerprint_key"',
      'CREATE INDEX "organization_identity_conflict_workspace_status_created_idx"',
      'CREATE UNIQUE INDEX "organization_identity_conflict_party_key"',
      'CREATE INDEX "organization_identity_conflict_party_workspace_company_idx"',
      '"request_precondition_etag" VARCHAR(256) NOT NULL',
      'CONSTRAINT "organization_identity_decision_revision_check"',
      'CONSTRAINT "organization_identity_decision_action_target_check"',
      'CREATE UNIQUE INDEX "organization_identity_decision_workspace_request_key"',
      'CREATE UNIQUE INDEX "organization_identity_decision_workspace_id_id_key"',
      'CONSTRAINT "organization_canonical_mapping_not_self_check"',
      'CONSTRAINT "organization_canonical_mapping_revision_check"',
      'CONSTRAINT "organization_canonical_mapping_revocation_check"',
      'CREATE UNIQUE INDEX "organization_canonical_mapping_active_source_key"',
      'CREATE INDEX "organization_canonical_mapping_workspace_source_status_idx"',
      'CREATE INDEX "organization_canonical_mapping_workspace_canonical_status_idx"',
      'CONSTRAINT "organization_identity_replay_attempt_check"',
      'CONSTRAINT "organization_identity_replay_completion_check"',
      'CREATE UNIQUE INDEX "organization_identity_replay_workspace_decision_key"',
      'CREATE INDEX "organization_identity_replay_workspace_status_created_idx"',
    ]) {
      expect(migration).toContain(required);
    }

    expect(migration).toMatch(
      /"action" = 'MERGE'[\s\S]+"conflict_id" IS NOT NULL[\s\S]+"canonical_company_id" IS NOT NULL/u,
    );
    expect(migration).toMatch(
      /"action" = 'KEEP_SEPARATE'[\s\S]+"conflict_id" IS NOT NULL[\s\S]+"canonical_company_id" IS NULL/u,
    );
    expect(migration).toMatch(
      /"action" = 'SPLIT'[\s\S]+"conflict_id" IS NULL[\s\S]+"canonical_company_id" IS NULL/u,
    );
  });

  it("adds only the nullable IdentityLink expand columns and conflict queue contract", () => {
    expect(migration).toMatch(
      /ALTER TABLE "identity_link"[\s\S]+ADD COLUMN "status" "identity_link_status",[\s\S]+ADD COLUMN "resolver_version" VARCHAR\(64\),[\s\S]+ADD COLUMN "input_hash" VARCHAR\(64\),[\s\S]+ADD COLUMN "conflict_id" UUID;/u,
    );
    expect(migration).not.toMatch(
      /ADD COLUMN "(?:status|resolver_version|input_hash|conflict_id)"[^,;]*(?:NOT NULL|DEFAULT)/u,
    );
    expect(migration).toContain(
      'CREATE INDEX "identity_link_workspace_id_conflict_id_idx"',
    );
    expect(migration).toContain(
      'ADD CONSTRAINT "identity_link_conflict_scope_fkey"',
    );
    expect(migration).not.toMatch(
      /(?:DROP|ADD) CONSTRAINT "identity_link_workspace_raw_fkey"/u,
    );
    expect(migration).not.toContain(
      "identity_link_workspace_canonical_raw_key",
    );
  });

  it("uses only workspace-composite RESTRICT foreign keys", () => {
    const expectedForeignKeys = [
      "organization_identifier_company_scope_fkey",
      "organization_identifier_raw_scope_fkey",
      "organization_identifier_conflict_scope_fkey",
      "organization_identity_conflict_raw_scope_fkey",
      "organization_identity_conflict_party_conflict_scope_fkey",
      "organization_identity_conflict_party_company_scope_fkey",
      "organization_identity_decision_conflict_scope_fkey",
      "organization_identity_decision_company_scope_fkey",
      "organization_canonical_mapping_source_scope_fkey",
      "organization_canonical_mapping_canonical_scope_fkey",
      "organization_canonical_mapping_merge_decision_scope_fkey",
      "organization_canonical_mapping_split_decision_scope_fkey",
      "organization_identity_replay_decision_scope_fkey",
      "identity_link_conflict_scope_fkey",
    ] as const;

    for (const name of expectedForeignKeys) {
      expect(migration).toMatch(
        new RegExp(
          `ADD CONSTRAINT "${name}"[\\s\\S]+?FOREIGN KEY \\("workspace_id", [^)]+\\)[\\s\\S]+?ON DELETE RESTRICT ON UPDATE NO ACTION`,
          "u",
        ),
      );
    }
    expect(occurrences(migration, /\bFOREIGN KEY\b/gu)).toBe(
      expectedForeignKeys.length,
    );
    expect(migration).not.toMatch(/ON DELETE (?:CASCADE|SET NULL)/u);
  });

  it("adds the current-main CanonicalCompany tenant key without changing Raw keys", () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "canonical_company_workspace_id_id_key"',
    );
    expect(migration).not.toContain(
      'CREATE UNIQUE INDEX "raw_source_record_workspace_id_id_key"',
    );
  });

  it("forces symmetric tenant RLS and app_user SELECT-only access", () => {
    for (const table of tenantTables) {
      expect(migration).toContain(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
      );
      expect(migration).toContain(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
      );
      expect(migration).toMatch(
        new RegExp(
          `CREATE POLICY "${table}_tenant_isolation" ON "${table}"[\\s\\S]+?FOR ALL[\\s\\S]+?USING \\("workspace_id" = current_workspace_id\\(\\)\\)[\\s\\S]+?WITH CHECK \\("workspace_id" = current_workspace_id\\(\\)\\);`,
          "u",
        ),
      );
      expect(migration).toContain(
        `REVOKE ALL ON TABLE "${table}" FROM PUBLIC, app_user;`,
      );
      expect(migration).toContain(
        `GRANT SELECT ON TABLE "${table}" TO app_user;`,
      );
    }
  });

  it("narrows IdentityLink to SELECT plus exactly seven immutable INSERT columns", () => {
    expect(migration).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "identity_link" FROM app_user;',
    );
    expect(migration).toContain(
      'REVOKE INSERT ON TABLE "identity_link" FROM app_user;',
    );
    expect(migration).toContain(
      'GRANT INSERT ("id", "workspace_id", "canonical_type", "canonical_id", "raw_record_id", "match_rule", "confidence") ON TABLE "identity_link" TO app_user;',
    );
    expect(migration).toContain(
      'GRANT SELECT ON TABLE "identity_link" TO app_user;',
    );
    expect(migration).not.toMatch(/GRANT INSERT \([^)]*"created_at"/u);
    expect(migration).not.toMatch(
      /GRANT INSERT \([^)]*"(?:status|resolver_version|input_hash|conflict_id)"/u,
    );
  });

  it("increments the current Prisma schema without replacing Raw governance", () => {
    for (const model of [
      "OrganizationIdentifier",
      "OrganizationIdentityConflict",
      "OrganizationIdentityConflictParty",
      "OrganizationIdentityDecision",
      "OrganizationCanonicalMapping",
      "OrganizationIdentityReplay",
    ]) {
      expect(schema).toContain(`model ${model} {`);
      expect(schema).toMatch(
        new RegExp(
          `model ${model} \\{[\\s\\S]+?id\\s+String\\s+@id @default\\(dbgenerated\\("gen_random_uuid\\(\\)"\\)\\) @db.Uuid`,
          "u",
        ),
      );
    }
    for (const prismaEnum of [
      "OrganizationIdentifierStatus",
      "OrganizationIdentityConflictStatus",
      "OrganizationIdentityDecisionAction",
      "OrganizationCanonicalMappingStatus",
      "OrganizationIdentityReplayStatus",
      "IdentityLinkStatus",
    ]) {
      expect(schema).toContain(`enum ${prismaEnum} {`);
    }
    expect(schema).toMatch(
      /model IdentityLink \{[\s\S]+status\s+IdentityLinkStatus\?[\s\S]+resolverVersion\s+String\?[\s\S]+inputHash\s+String\?[\s\S]+conflictId\s+String\?/u,
    );
    expect(schema).toMatch(
      /model OrganizationIdentifier \{[\s\S]+provenance\s+Json\s/u,
    );
    expect(schema).toContain(
      '@map("request_precondition_etag") @db.VarChar(256)',
    );
    expect(schema).toMatch(
      /model RawSourceRecord \{[\s\S]+governanceDispositions\s+RawSourceGovernanceDisposition\[\][\s\S]+organizationIdentifiers\s+OrganizationIdentifier\[\][\s\S]+identityConflicts\s+OrganizationIdentityConflict\[\]/u,
    );
    expect(schema).not.toMatch(
      /model IdentityLink \{[\s\S]+@relation\([^\n]+identity_link_workspace_raw_fkey/u,
    );
    expect(schema).toMatch(
      /model RuntimeProcessLease \{[\s\S]+artifactDigest[\s\S]+migrationRevision[\s\S]+lastSeenAt/u,
    );
    expect(schema).toContain(
      '@@unique([workspaceId, id], map: "canonical_company_workspace_id_id_key")',
    );
  });
});
