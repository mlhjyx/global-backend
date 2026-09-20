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
const expandMigrationPath = resolve(
  migrationRoot,
  "20260829090000_organization_identity_v2_expand_ddl/migration.sql",
);
const backfillMigrationPath = resolve(
  migrationRoot,
  "20260829091000_organization_identity_v2_legacy_link_backfill_dml/migration.sql",
);
const expectedExpandChecksum =
  "b4e2a705efa3c1f60a75e2775e444cfd11fca995fb4b8dcd0ec26bd668dfc0d7";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readBackfillMigration() {
  assert.ok(
    existsSync(backfillMigrationPath),
    "exact legacy IdentityLink DML migration is absent",
  );
  return readFileSync(backfillMigrationPath, "utf8");
}

function occurrences(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

describe("Organization Identity v2 legacy IdentityLink backfill migration", () => {
  it("preserves the expand migration byte-for-byte and requires the exact DML successor", () => {
    assert.equal(
      sha256(readFileSync(expandMigrationPath)),
      expectedExpandChecksum,
    );
    assert.ok(
      existsSync(backfillMigrationPath),
      "exact legacy IdentityLink DML migration is absent",
    );
  });

  it("uses only the reviewed DML transaction vocabulary", () => {
    const sql = readBackfillMigration();

    assert.match(sql, /^BEGIN;\s*$/mu);
    assert.match(sql, /^COMMIT;\s*$/mu);
    assert.equal(occurrences(sql, /^BEGIN;\s*$/gmu), 1);
    assert.equal(occurrences(sql, /^COMMIT;\s*$/gmu), 1);
    assert.equal(occurrences(sql, /^DO\s+/gmu), 1);
    assert.equal(occurrences(sql, /^UPDATE\s+"identity_link"/gmu), 1);
    assert.doesNotMatch(
      sql,
      /\b(?:CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE|INSERT|DELETE|MERGE|COPY|CALL|VACUUM|ANALYZE|REFRESH|REINDEX|CLUSTER|COMMENT|SECURITY\s+LABEL)\b/iu,
    );
    assert.doesNotMatch(
      sql,
      /\b(?:provider|runtime_process_lease|runtime_component|heartbeat|organization_identifier|organization_identity_(?:conflict|decision|replay)|organization_canonical_mapping)\b/iu,
    );
    assert.doesNotMatch(sql, /UPDATE\s+(?!"identity_link")/iu);
    assert.doesNotMatch(sql, /UPDATE\s+"raw_source_record"/iu);
  });

  it("sets the exact local safety bounds and acquires existing-table locks in fixed order", () => {
    const sql = readBackfillMigration();
    assert.match(sql, /SET LOCAL lock_timeout = '5s';/u);
    assert.match(sql, /SET LOCAL statement_timeout = '60s';/u);
    assert.match(sql, /SET LOCAL row_security = off;/u);
    assert.equal(occurrences(sql, /^SET LOCAL /gmu), 3);

    const lockMatches = [
      ...sql.matchAll(
        /^LOCK TABLE "([a-z_]+)" IN (SHARE|SHARE ROW EXCLUSIVE) MODE;$/gmu,
      ),
    ];
    assert.deepEqual(
      lockMatches.map((match) => match[1]),
      [
        "canonical_company",
        "canonical_contact",
        "raw_source_record",
        "identity_link",
      ],
    );
    assert.deepEqual(
      lockMatches.map((match) => match[2]),
      ["SHARE", "SHARE", "SHARE", "SHARE"],
    );
    assert.equal(occurrences(sql, /^LOCK TABLE /gmu), 4);
  });

  it("fails closed on every legacy inconsistency before the sole UPDATE", () => {
    const sql = readBackfillMigration();
    const updateOffset = sql.indexOf('UPDATE "identity_link"');
    assert.ok(updateOffset > 0);
    const preUpdate = sql.slice(0, updateOffset);

    assert.match(preUpdate, /canonical_type NOT IN \('company', 'contact'\)/u);
    assert.match(preUpdate, /FROM "canonical_company"/u);
    assert.match(preUpdate, /FROM "canonical_contact"/u);
    assert.match(preUpdate, /FROM "raw_source_record"/u);
    assert.match(
      preUpdate,
      /GROUP BY\s+"workspace_id",\s*"canonical_type",\s*"canonical_id",\s*"raw_record_id"[\s\S]*HAVING count\(\*\) > 1/u,
    );
    assert.match(
      preUpdate,
      /"status" IS NOT NULL[\s\S]*"resolver_version" IS NOT NULL[\s\S]*"input_hash" IS NOT NULL[\s\S]*"conflict_id" IS NOT NULL/u,
    );

    for (const message of [
      "unsupported canonical_type",
      "missing or cross-workspace company target",
      "missing or cross-workspace contact target",
      "missing or cross-workspace raw target",
      "duplicate canonical/raw binding",
      "unexpected partial lifecycle state",
    ]) {
      assert.match(preUpdate, new RegExp(message, "u"));
    }
  });

  it("updates every legacy row once and validates exact lifecycle values and count", () => {
    const sql = readBackfillMigration();
    assert.match(
      sql,
      /UPDATE "identity_link"\s+SET "status" = 'ACTIVE',\s*"resolver_version" = 'identity-v1',\s*"input_hash" = 'legacy',\s*"conflict_id" = NULL;/u,
    );
    assert.match(sql, /GET DIAGNOSTICS [a-z_]+ = ROW_COUNT;/u);
    assert.match(sql, /updated row count changed/u);
    assert.match(
      sql,
      /"status" IS DISTINCT FROM 'ACTIVE'[\s\S]*"resolver_version" IS DISTINCT FROM 'identity-v1'[\s\S]*"input_hash" IS DISTINCT FROM 'legacy'[\s\S]*"conflict_id" IS NOT NULL/u,
    );
    assert.match(sql, /post-backfill lifecycle validation failed/u);
    assert.match(sql, /post-backfill row count changed/u);
  });
});
