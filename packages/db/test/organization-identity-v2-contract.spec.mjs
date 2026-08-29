import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const migrationRoot = resolve(repositoryRoot, "packages/db/prisma/migrations");
const schemaPath = resolve(repositoryRoot, "packages/db/prisma/schema.prisma");
const expandMigrationPath = resolve(
  migrationRoot,
  "20260829090000_organization_identity_v2_expand_ddl/migration.sql",
);
const backfillMigrationPath = resolve(
  migrationRoot,
  "20260829091000_organization_identity_v2_legacy_link_backfill_dml/migration.sql",
);
const contractMigrationPath = resolve(
  migrationRoot,
  "20260829092000_organization_identity_v2_contract_ddl/migration.sql",
);
const expectedExpandChecksum =
  "2f6bab93bd253dd7ec80d2c94c45f91e2c6bb1fae51127b94e15b0e11b85a119";
const expectedBackfillChecksum =
  "d897ab5c50dd038e2f4bb04b7d1b37bd404ce7f9c68ac7dc5a45a47272fc9426";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readContractMigration() {
  assert.ok(
    existsSync(contractMigrationPath),
    "exact Organization Identity contract DDL migration is absent",
  );
  return readFileSync(contractMigrationPath, "utf8");
}

function occurrences(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

describe("Organization Identity v2 contract DDL", () => {
  it("preserves reviewed expand/DML bytes and requires the exact contract successor", () => {
    assert.equal(
      sha256(readFileSync(expandMigrationPath)),
      expectedExpandChecksum,
    );
    assert.equal(
      sha256(readFileSync(backfillMigrationPath)),
      expectedBackfillChecksum,
    );
    assert.ok(
      existsSync(contractMigrationPath),
      "exact Organization Identity contract DDL migration is absent",
    );
  });

  it("is one bounded DDL/ACL transaction with no business DML", () => {
    const sql = readContractMigration();

    assert.equal(occurrences(sql, /^BEGIN;\s*$/gmu), 1);
    assert.equal(occurrences(sql, /^COMMIT;\s*$/gmu), 1);
    assert.match(sql, /SET LOCAL lock_timeout = '5s';/u);
    assert.match(sql, /SET LOCAL statement_timeout = '60s';/u);
    assert.match(sql, /SET LOCAL row_security = off;/u);
    assert.equal(occurrences(sql, /^SET LOCAL /gmu), 3);
    assert.doesNotMatch(
      sql,
      /^\s*(?:INSERT|UPDATE|DELETE|TRUNCATE|MERGE|COPY|CALL|VACUUM|ANALYZE|REFRESH|REINDEX|CLUSTER)\b/gimu,
    );
    assert.doesNotMatch(
      sql,
      /^\s*(?:ALTER|DROP|CREATE|GRANT|REVOKE)[^;]*(?:provider|field_evidence|source_entity|runtime_process_lease|runtime_component|heartbeat)/gimu,
    );
  });

  it("locks every existing table once in the frozen order and bounded mode", () => {
    const sql = readContractMigration();
    const locks = [
      ...sql.matchAll(
        /^LOCK TABLE "([a-z_]+)" IN (SHARE|SHARE ROW EXCLUSIVE) MODE;$/gmu,
      ),
    ];

    assert.deepEqual(
      locks.map((match) => match[1]),
      [
        "canonical_company",
        "canonical_contact",
        "raw_source_record",
        "organization_identity_conflict",
        "organization_identity_decision",
        "organization_identifier",
        "organization_canonical_mapping",
        "organization_identity_replay",
        "organization_identity_conflict_party",
        "identity_link",
      ],
    );
    assert.deepEqual(
      locks.map((match) => match[2]),
      Array.from({ length: 10 }, () => "SHARE ROW EXCLUSIVE"),
    );
    assert.equal(occurrences(sql, /^LOCK TABLE /gmu), 10);
  });

  it("never reverses the frozen order when DDL upgrades table locks", () => {
    const sql = readContractMigration();
    const orderedDdlTargets = [
      'ALTER TABLE "organization_identity_conflict"',
      'ALTER TABLE "organization_identifier"',
      'ALTER TABLE "organization_canonical_mapping"',
      'ALTER TABLE "organization_identity_replay"',
      'ALTER TABLE "identity_link"',
    ];
    const offsets = orderedDdlTargets.map((target) => sql.indexOf(target));

    assert.ok(offsets.every((offset) => offset >= 0));
    assert.deepEqual(
      offsets,
      [...offsets].sort((left, right) => left - right),
    );
  });

  it("fails closed before DDL on incomplete IdentityLink lifecycle and target state", () => {
    const sql = readContractMigration();
    const firstAlter = sql.indexOf('ALTER TABLE "identity_link"');
    assert.ok(firstAlter > 0);
    const preflight = sql.slice(0, firstAlter);

    assert.match(
      preflight,
      /"status" IS NULL[\s\S]*"resolver_version" IS NULL[\s\S]*"input_hash" IS NULL/u,
    );
    assert.match(preflight, /\^\[0-9a-f\]\{64\}\$/u);
    assert.match(
      preflight,
      /GROUP BY[\s\S]*"canonical_type"[\s\S]*HAVING count\(\*\) > 1/u,
    );
    assert.match(preflight, /FROM public\."canonical_company"/u);
    assert.match(preflight, /FROM public\."canonical_contact"/u);
    assert.match(
      preflight,
      /IDENTITY_LINK_CONTRACT_PREFLIGHT_LIFECYCLE_INVALID/u,
    );
    assert.match(preflight, /IDENTITY_LINK_CONTRACT_PREFLIGHT_DUPLICATE/u);
    assert.match(preflight, /IDENTITY_LINK_CONTRACT_PREFLIGHT_TARGET_INVALID/u);
  });

  it("finalizes IdentityLink defaults, nullability, hash and exact uniqueness", () => {
    const sql = readContractMigration();

    for (const [column, expectedDefault] of [
      ["status", "ACTIVE"],
      ["resolver_version", "identity-v1"],
      ["input_hash", "legacy"],
    ]) {
      assert.match(
        sql,
        new RegExp(
          `ALTER COLUMN "${column}" SET DEFAULT '${expectedDefault}'`,
          "u",
        ),
      );
      assert.match(
        sql,
        new RegExp(`ALTER COLUMN "${column}" SET NOT NULL`, "u"),
      );
    }
    assert.doesNotMatch(sql, /ALTER COLUMN "conflict_id" SET NOT NULL/u);
    assert.match(sql, /CONSTRAINT "identity_link_input_hash_check"/u);
    assert.match(
      sql,
      /CONSTRAINT "identity_link_pending_conflict_owner_check" CHECK \(\s*"status" <> 'PENDING_CONFLICT' OR "conflict_id" IS NOT NULL\s*\)/u,
    );
    assert.match(sql, /"input_hash" = 'legacy'/u);
    assert.match(sql, /"input_hash" ~ '\^\[0-9a-f\]\{64\}\$'/u);
    assert.match(
      sql,
      /CREATE UNIQUE INDEX "identity_link_workspace_canonical_raw_key"\s+ON "identity_link"\(\s*"workspace_id",\s*"canonical_type",\s*"canonical_id",\s*"raw_record_id"\s*\)/u,
    );
  });

  it("installs typed target and immutable lifecycle guards with stable errors", () => {
    const sql = readContractMigration();

    for (const token of [
      "IDENTITY_LINK_CANONICAL_TYPE_INVALID",
      "IDENTITY_LINK_CANONICAL_TARGET_INVALID",
      "IDENTITY_LINK_IMMUTABLE",
      "IDENTITY_LINK_STATUS_TRANSITION_INVALID",
      "IDENTITY_LINK_DELETE_FORBIDDEN",
    ]) {
      assert.match(sql, new RegExp(token, "u"));
    }
    assert.match(sql, /TG_OP = 'INSERT'/u);
    assert.match(sql, /NEW\."canonical_type" = 'company'/u);
    assert.match(sql, /NEW\."canonical_type" = 'contact'/u);
    assert.equal(occurrences(sql, /FOR KEY SHARE/gu), 2);
    assert.match(sql, /creation-time reference/u);
    assert.match(sql, /historical UUID stub/u);
    assert.match(sql, /readers must tolerate a missing canonical target/u);
    assert.match(sql, /'PENDING_CONFLICT'[\s\S]*'ACTIVE'[\s\S]*'REVOKED'/u);
    assert.match(
      sql,
      /BEFORE INSERT OR UPDATE OF "workspace_id", "canonical_type", "canonical_id"/u,
    );
    assert.match(sql, /BEFORE UPDATE OR DELETE ON "identity_link"/u);
  });

  it("installs every six-table immutable/state guard and append-only delete gate", () => {
    const sql = readContractMigration();
    const requiredTokens = [
      "ORGANIZATION_IDENTIFIER_IMMUTABLE",
      "ORGANIZATION_IDENTIFIER_LAST_SEEN_REGRESSION",
      "ORGANIZATION_IDENTIFIER_STATUS_TRANSITION_INVALID",
      "ORGANIZATION_IDENTIFIER_DELETE_FORBIDDEN",
      "ORGANIZATION_IDENTITY_CONFLICT_IMMUTABLE",
      "ORGANIZATION_IDENTITY_CONFLICT_REVISION_INVALID",
      "ORGANIZATION_IDENTITY_CONFLICT_STATUS_TRANSITION_INVALID",
      "ORGANIZATION_IDENTITY_CONFLICT_DELETE_FORBIDDEN",
      "ORGANIZATION_IDENTITY_CONFLICT_PARTY_IMMUTABLE",
      "ORGANIZATION_IDENTITY_CONFLICT_PARTY_DELETE_FORBIDDEN",
      "ORGANIZATION_IDENTITY_DECISION_APPEND_ONLY",
      "ORGANIZATION_IDENTITY_DECISION_DELETE_FORBIDDEN",
      "ORGANIZATION_CANONICAL_MAPPING_DECISION_INVALID",
      "ORGANIZATION_CANONICAL_MAPPING_IMMUTABLE",
      "ORGANIZATION_CANONICAL_MAPPING_REVISION_INVALID",
      "ORGANIZATION_CANONICAL_MAPPING_STATUS_TRANSITION_INVALID",
      "ORGANIZATION_CANONICAL_MAPPING_DELETE_FORBIDDEN",
      "ORGANIZATION_IDENTITY_REPLAY_INPUT_HASH_MISMATCH",
      "ORGANIZATION_IDENTITY_REPLAY_IMMUTABLE",
      "ORGANIZATION_IDENTITY_REPLAY_ATTEMPT_INVALID",
      "ORGANIZATION_IDENTITY_REPLAY_STATUS_TRANSITION_INVALID",
      "ORGANIZATION_IDENTITY_REPLAY_STATE_SHAPE_INVALID",
      "ORGANIZATION_IDENTITY_REPLAY_TIMESTAMP_INVALID",
      "ORGANIZATION_IDENTITY_REPLAY_DELETE_FORBIDDEN",
    ];

    for (const token of requiredTokens) {
      assert.match(sql, new RegExp(token, "u"));
    }
    for (const table of [
      "organization_identifier",
      "organization_identity_conflict",
      "organization_identity_conflict_party",
      "organization_identity_decision",
      "organization_canonical_mapping",
      "organization_identity_replay",
    ]) {
      assert.match(
        sql,
        new RegExp(
          `(?:INSERT OR UPDATE OR DELETE|UPDATE OR DELETE) ON "${table}"`,
          "u",
        ),
      );
    }
  });

  it("fixes every trigger function search path and removes direct execution", () => {
    const sql = readContractMigration();
    const functions = [
      ...sql.matchAll(
        /^CREATE FUNCTION ([a-z0-9_]+)\(\)[\s\S]*?^\$[a-z0-9_]+\$;$/gmu,
      ),
    ];

    assert.equal(functions.length, 8);
    for (const match of functions) {
      assert.match(match[0], /SET search_path = pg_catalog, public/u);
      assert.doesNotMatch(match[0], /SECURITY DEFINER/iu);
      assert.match(
        sql,
        new RegExp(
          `REVOKE ALL ON FUNCTION ${match[1]}\\(\\) FROM PUBLIC, app_user;`,
          "u",
        ),
      );
    }
    assert.equal(occurrences(sql, /^REVOKE ALL ON FUNCTION /gmu), 8);
  });

  it("keeps the six new tables SELECT-only for app_user", () => {
    const sql = readContractMigration();
    for (const table of [
      "organization_identifier",
      "organization_identity_conflict",
      "organization_identity_conflict_party",
      "organization_identity_decision",
      "organization_canonical_mapping",
      "organization_identity_replay",
    ]) {
      assert.doesNotMatch(
        sql,
        new RegExp(
          `GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)[^;]*"${table}"[^;]* TO app_user`,
          "iu",
        ),
      );
    }
  });

  it("declares only the required final IdentityLink Prisma shape", () => {
    const schema = readFileSync(schemaPath, "utf8");
    const identityLink = schema.match(
      /model IdentityLink \{[\s\S]*?\n\}/u,
    )?.[0];
    assert.ok(identityLink, "IdentityLink Prisma model is absent");

    assert.match(
      identityLink,
      /status\s+IdentityLinkStatus\s+@default\(ACTIVE\)/u,
    );
    assert.match(
      identityLink,
      /resolverVersion\s+String\s+@default\("identity-v1"\)\s+@map\("resolver_version"\)\s+@db\.VarChar\(64\)/u,
    );
    assert.match(
      identityLink,
      /inputHash\s+String\s+@default\("legacy"\)\s+@map\("input_hash"\)\s+@db\.VarChar\(64\)/u,
    );
    assert.match(identityLink, /conflictId\s+String\?/u);
    assert.match(identityLink, /creation-time reference/u);
    assert.match(identityLink, /historical UUID stub/u);
    assert.match(identityLink, /tolerate a missing canonical target/u);
    assert.match(
      identityLink,
      /@@unique\(\[workspaceId, canonicalType, canonicalId, rawRecordId\], map: "identity_link_workspace_canonical_raw_key"\)/u,
    );
  });
});
