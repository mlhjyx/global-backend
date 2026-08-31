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
const migrationChecksum =
  "3cb5fe7ca22b3067b92d71ac25198c7ff14d08c08a0907343d84130bb0b7a882";
const forbiddenMigrationChecksums = Object.freeze([
  "3bf6e58db819352ca0777380e9adb2fbf32ca9eeb311b91df696b569302da7af",
  "098aa285a17cdc6e5ea2c092cbfb31a57cd0ec3ed6db83b0c1221e9d86f55c6a",
  "6e4b5a3bf448c1debb2450eef648d81dcd4e468d6a4aa48adc409b2933e39d23",
  "8423589e72a6bc6ef6914819063b5d76999fd2ab24f9ff5252ec2b68590e70be",
  "18d5a9b535d79e7d92b0886379d240919fb9e8c40c039cb0efed3089100e3cd8",
  "fb6b377fc23704bd7057c8367fd9713f67f9923497552abf399f59cb5347826b",
  "0c716f1d5449b89d3ade64ce5cc1c7214a3b96303b3737a6e2681334581ba518",
  "8c5d07dc1d8d7bc4befef71a8a26a0744232c2b176faaf1162a4aed761da6c66",
  "7e101a1d13c31a2657ea84b19b82e3b855102db104393ee33a9bb8a6c5415972",
]);
const schemaPath = resolve(repositoryRoot, "packages/db/prisma/schema.prisma");
const attackTestPath = resolve(
  repositoryRoot,
  "packages/db/test/organization-identity-command-attacks.disposable.spec.mjs",
);

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

function normalizeSql(value) {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

function sqlWithoutComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\/|--[^\r\n]*/gu, "");
}

function parameterTypes(parameters) {
  return parameters
    .split(",")
    .map((parameter) =>
      normalizeSql(parameter)
        .replace(/^(?:in|out|inout|variadic)\s+/u, "")
        .replace(/^[a-z_][a-z0-9_]*\s+/u, ""),
    )
    .join(", ");
}

function publicFunctionDefinitions(sql) {
  const definitions = [];
  const functionPattern =
    /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)\s*RETURNS\b[\s\S]*?AS\s+(?:(?<dollar>\$[a-z0-9_]*\$)[\s\S]*?\k<dollar>|'(?:''|[^'])*')\s*;/gimu;
  for (const match of sqlWithoutComments(sql).matchAll(functionPattern)) {
    const definition = match[0];
    const header = definition.slice(
      0,
      definition.search(/\s+AS\s+(?:\$[a-z0-9_]*\$|')/iu),
    );
    definitions.push({
      name: match[1].toLowerCase(),
      parameterDeclaration: normalizeSql(match[2]),
      parameterTypes: parameterTypes(match[2]),
      header: normalizeSql(header),
      definition,
    });
  }
  return definitions;
}

function functionGrantees(sql, definition) {
  const grants = [];
  const grantPattern =
    /^\s*GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)\s+TO\s+([^;]+);/gimu;
  for (const match of sqlWithoutComments(sql).matchAll(grantPattern)) {
    if (
      match[1].toLowerCase() === definition.name &&
      parameterTypes(match[2]) === definition.parameterTypes
    ) {
      grants.push(match[3].split(",").map(normalizeSql));
    }
  }
  return grants;
}

function functionRevokes(sql, definition) {
  const revokes = [];
  const revokePattern =
    /^\s*REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.([a-z0-9_]+)\s*\(([^)]*)\)\s+FROM\s+([^;]+);/gimu;
  for (const match of sqlWithoutComments(sql).matchAll(revokePattern)) {
    if (
      match[1].toLowerCase() === definition.name &&
      parameterTypes(match[2]) === definition.parameterTypes
    ) {
      revokes.push(match[3].split(",").map(normalizeSql));
    }
  }
  return revokes;
}

describe("Organization Identity resolver command migration", () => {
  it("tracks hostile direct-SQL USERSET runtime as NOT_GUARANTEED", () => {
    const attackTest = readFileSync(attackTestPath, "utf8");
    assert.match(
      attackTest,
      /direct hostile SQL hard runtime is NOT_GUARANTEED under same-statement USERSET forgery/u,
    );
    assert.match(
      attackTest,
      /function runUsersetForgeryDiagnostic\(\)[\s\S]*WITH initial_runtime AS MATERIALIZED[\s\S]*forged_runtime AS MATERIALIZED[\s\S]*set_config\('statement_timeout','60s',true\)[\s\S]*set_config\('lock_timeout','5s',true\)[\s\S]*resolve_organization_identity_for_raw_v1/u,
    );
  });

  it("preserves every reviewed predecessor and the Prisma datamodel", () => {
    for (const [relativePath, expected] of frozenFiles) {
      assert.equal(
        sha256(readFileSync(resolve(migrationRoot, relativePath))),
        expected,
      );
    }
    assert.equal(
      sha256(readFileSync(schemaPath)),
      "3db362c1c84f5f12ffa788eb54f2448a3b77d0dad410b96733acef1cc7337c3b",
    );
  });

  it("pins only the final resolver migration checksum", () => {
    const observed = sha256(readFileSync(migrationPath));
    assert.equal(observed, migrationChecksum);
    assert.equal(new Set(forbiddenMigrationChecksums).size, 9);
    assert.ok(!forbiddenMigrationChecksums.includes(observed));
  });

  it("is one bounded DDL/ACL transaction with no datamodel mutation", () => {
    const sql = migrationSql();
    assert.equal(occurrences(sql, /^BEGIN;\s*$/gmu), 1);
    assert.equal(occurrences(sql, /^COMMIT;\s*$/gmu), 1);
    assert.doesNotMatch(
      sql,
      /^\s*(?:ALTER|CREATE|DROP)\s+(?:TABLE|TYPE|INDEX|POLICY)\b/gimu,
    );
  });

  it("rejects JSON command residue and exposes only the two-ID app_user command", () => {
    const sql = migrationSql();
    const definitions = publicFunctionDefinitions(sql);
    const commands = definitions.filter(
      (definition) =>
        definition.name === "resolve_organization_identity_for_raw_v1" &&
        definition.parameterTypes === "text, text",
    );
    assert.equal(commands.length, 1);
    const [command] = commands;
    assert.equal(
      command.parameterDeclaration,
      "p_workspace_id text, p_raw_record_id text",
    );
    assert.match(command.header, /language plpgsql security definer/u);
    assert.match(command.header, /set search_path = pg_catalog, public/u);
    assert.match(command.header, /set row_security = off/u);
    assert.doesNotMatch(command.header, /set lock_timeout/u);
    assert.doesNotMatch(command.header, /set statement_timeout/u);
    assert.match(sql, /current_setting\(\s*'lock_timeout',\s*true\s*\)/u);
    assert.match(sql, /current_setting\(\s*'statement_timeout',\s*true\s*\)/u);
    assert.match(sql, /lock_timeout_seconds\s+NOT BETWEEN 0\.001 AND 5/u);
    assert.match(sql, /statement_timeout_seconds\s+NOT BETWEEN 0\.001 AND 60/u);
    assert.match(sql, /EXCEPTION WHEN query_canceled THEN/u);
    assert.match(sql, /WHEN assert_failure THEN/u);
    assert.equal(
      occurrences(sql, /clock_timestamp\(\)\s*>=\s*statement_deadline/gu),
      1,
    );
    assert.match(
      sql,
      /EXCEPTION WHEN query_canceled THEN[\s\S]*clock_timestamp\(\)\s*>=\s*statement_deadline/u,
    );
    assert.deepEqual(functionRevokes(sql, command), [["public"]]);
    assert.deepEqual(functionGrantees(sql, command), [["app_user"]]);
    assert.doesNotMatch(
      command.definition,
      /public\.(?:raw_source_record|raw_source_governance_disposition|canonical_company|organization_identifier|organization_canonical_mapping|suppression_record|identity_link|organization_identity_conflict|organization_identity_conflict_party)\b/iu,
    );
    assert.doesNotMatch(
      command.definition,
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\./iu,
    );
    assert.equal(
      occurrences(
        command.definition,
        /organization_identity_resolve_for_raw_worker_v1/gu,
      ),
      1,
    );
    assert.match(
      command.definition,
      /EXECUTE[\s\S]*USING[\s\S]*v_workspace_id/u,
    );
    const workers = definitions.filter(
      (definition) =>
        definition.name === "organization_identity_resolve_for_raw_worker_v1" &&
        definition.parameterTypes === "text, text",
    );
    assert.equal(workers.length, 1);
    const [worker] = workers;
    assert.match(worker.header, /language plpgsql security invoker/u);
    assert.match(worker.header, /set search_path = pg_catalog, public/u);
    assert.match(worker.header, /set row_security = off/u);
    assert.doesNotMatch(worker.header, /set lock_timeout/u);
    assert.doesNotMatch(worker.header, /set statement_timeout/u);
    assert.deepEqual(functionRevokes(sql, worker), [["public", "app_user"]]);
    assert.deepEqual(functionGrantees(sql, worker), []);
    assert.equal(
      definitions.filter(
        (definition) =>
          definition.name === "apply_organization_identity_resolution_v1" &&
          definition.parameterTypes === "jsonb",
      ).length,
      0,
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

  it("fails closed on unexpected public function, owner, or ACL residue", () => {
    const sql = migrationSql();
    const definitions = publicFunctionDefinitions(sql);
    const commands = definitions.filter(
      (definition) =>
        definition.name === "resolve_organization_identity_for_raw_v1" &&
        definition.parameterTypes === "text, text",
    );
    assert.equal(commands.length, 1);
    const [command] = commands;
    for (const definition of definitions) {
      if (definition === command) continue;
      assert.deepEqual(functionRevokes(sql, definition), [
        ["public", "app_user"],
      ]);
      assert.deepEqual(functionGrantees(sql, definition), []);
    }
    assert.doesNotMatch(
      sqlWithoutComments(sql),
      /ALTER FUNCTION public\.[a-z0-9_]+\([^)]*\) OWNER TO (?!global\b)/u,
    );
  });
});
