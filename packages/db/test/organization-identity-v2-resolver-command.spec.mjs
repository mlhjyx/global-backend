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
const migrationName =
  "20260830090000_organization_identity_v2_resolver_command";
const migrationPath = resolve(migrationRoot, migrationName, "migration.sql");
const expectedMigrationChecksum =
  "7e101a1d13c31a2657ea84b19b82e3b855102db104393ee33a9bb8a6c5415972";
const schemaPath = resolve(repositoryRoot, "packages/db/prisma/schema.prisma");

const frozenFiles = Object.freeze([
  [
    "20260829090000_organization_identity_v2_expand_ddl/migration.sql",
    "2f6bab93bd253dd7ec80d2c94c45f91e2c6bb1fae51127b94e15b0e11b85a119",
  ],
  [
    "20260829091000_organization_identity_v2_legacy_link_backfill_dml/migration.sql",
    "d897ab5c50dd038e2f4bb04b7d1b37bd404ce7f9c68ac7dc5a45a47272fc9426",
  ],
  [
    "20260829092000_organization_identity_v2_contract_ddl/migration.sql",
    "1d8368c81f7af17dcb96999d23a4cd35d387436282935c20eb11befcb8c08396",
  ],
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function migrationSql() {
  assert.ok(existsSync(migrationPath), `${migrationName} must exist`);
  return readFileSync(migrationPath, "utf8");
}

function occurrences(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

describe("Organization Identity resolver command migration", () => {
  it("preserves every reviewed predecessor and the Prisma datamodel", () => {
    for (const [relativePath, expected] of frozenFiles) {
      assert.equal(
        sha256(readFileSync(resolve(migrationRoot, relativePath))),
        expected,
      );
    }
    assert.equal(
      sha256(readFileSync(schemaPath)),
      "0858f0d36634246e20a4dfd5fdae3ab6910d945af1e45e0c44ad489a13a0fca4",
    );
    assert.equal(sha256(migrationSql()), expectedMigrationChecksum);
  });

  it("is one bounded DDL/ACL transaction with no datamodel mutation", () => {
    const sql = migrationSql();
    assert.equal(occurrences(sql, /^BEGIN;\s*$/gmu), 1);
    assert.equal(occurrences(sql, /^COMMIT;\s*$/gmu), 1);
    assert.match(sql, /SET LOCAL lock_timeout = '5s';/u);
    assert.match(sql, /SET LOCAL statement_timeout = '60s';/u);
    assert.doesNotMatch(
      sql,
      /^\s*(?:ALTER|CREATE|DROP)\s+(?:TABLE|TYPE|INDEX|POLICY)\b/gimu,
    );
  });

  it("closes JSON, principal, workspace and function ACL boundaries", () => {
    const sql = migrationSql();
    for (const token of [
      "organization-identity-resolution-command/v1",
      "IDENTITY_RESOLUTION_COMMAND_DENIED",
      "IDENTITY_RESOLUTION_INPUT_INVALID",
      "IDENTITY_RESOLUTION_PLAN_STALE",
      "IDENTITY_INPUT_DRIFT",
      "IDENTITY_LEGACY_LINK_ALREADY_RESOLVED",
      "IDENTITY_RESOLUTION_SUPPRESSED",
      "current_workspace_id",
      "session_user",
      "current_user",
      "app_user",
    ]) {
      assert.match(sql, new RegExp(token, "u"));
    }
    assert.match(sql, /octet_length\(p_command::text\)\s*>\s*65536/u);
    assert.match(sql, /SECURITY DEFINER/u);
    assert.match(sql, /SET search_path = pg_catalog, public/u);
    assert.match(
      sql,
      /GRANT EXECUTE ON FUNCTION public\.apply_organization_identity_resolution_v1\(jsonb\) TO app_user/u,
    );
    assert.doesNotMatch(
      sql,
      /GRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL)[\s\S]*ON\s+(?:TABLE\s+)?(?:public\.)?(?:identity_link|organization_)/iu,
    );
  });

  it("uses the one suppression-to-identity lock order and bounded set inputs", () => {
    const sql = migrationSql();
    const suppression = sql.indexOf("acquisition-suppression-policy:");
    const identity = sql.indexOf("organization-identity:");
    assert.ok(suppression > 0 && identity > suppression);
    assert.equal(occurrences(sql, /acquisition-suppression-policy:/gu), 1);
    assert.equal(occurrences(sql, /organization-identity:/gu), 1);
    assert.match(
      sql,
      /jsonb_array_length[\s\S]*authorityIdentifiers[\s\S]*>\s*32/u,
    );
    assert.match(
      sql,
      /jsonb_array_length[\s\S]*existingBindings[\s\S]*>\s*64/u,
    );
    assert.match(sql, /jsonb_array_length[\s\S]*rootMappings[\s\S]*>\s*64/u);
  });

  it("keeps helpers private and the public command exact", () => {
    const sql = migrationSql();
    assert.equal(
      occurrences(
        sql,
        /CREATE OR REPLACE FUNCTION public\.apply_organization_identity_resolution_v1\(p_command jsonb\)/gu,
      ),
      1,
    );
    assert.match(
      sql,
      /REVOKE ALL ON FUNCTION public\.apply_organization_identity_resolution_v1\(jsonb\) FROM PUBLIC/u,
    );
    for (const match of sql.matchAll(
      /CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(/gu,
    )) {
      if (match[1] === "apply_organization_identity_resolution_v1") continue;
      assert.match(
        sql,
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${match[1]}\\([^;]+ FROM PUBLIC, app_user`,
          "u",
        ),
      );
    }
  });
});
