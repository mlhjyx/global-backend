import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN } from "./source-policy-scope";

/**
 * Static contract of the migration that lets the database writer bind public_web records to the
 * company-site source policy. Its behaviour on PostgreSQL is checked by
 * raw-source-company-site-policy.postgres.spec.ts (CI step "Raw source company-site policy on
 * PostgreSQL").
 */
const MIGRATIONS = fileURLToPath(
  new URL("../../../../packages/db/prisma/migrations/", import.meta.url),
);
const MIGRATION = "20261009180000_public_web_company_site_source_policy";
const WRITER_HARDENING = "20260826130000_raw_source_governance_writer_hardening";

function migrationSql(name: string): string {
  return readFileSync(`${MIGRATIONS}${name}/migration.sql`, "utf8");
}

/** Lines `first`..`last` (1-based, inclusive). */
function lineRange(text: string, first: number, last: number): string[] {
  return text.split("\n").slice(first - 1, last);
}

/** Top-level statements, comments dropped, every `$$` body replaced by `$body$`, whitespace folded. */
function topLevelStatements(text: string): string[] {
  return text
    .replace(/\$\$[\s\S]*?\$\$/gu, "$body$")
    .split("\n")
    .map((line) => line.replace(/--.*$/u, ""))
    .join("\n")
    .split(";")
    .map((statement) => statement.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
}

/** The text between `AS $$` and `$$;` of the routine whose definition starts with `head`. */
function routine(text: string, head: string): { header: string; body: string } {
  const start = text.indexOf(head);
  expect(start, head).toBeGreaterThanOrEqual(0);
  const open = text.indexOf("AS $$\n", start);
  const close = text.indexOf("\n$$;", open);
  expect(open).toBeGreaterThan(start);
  expect(close).toBeGreaterThan(open);
  return {
    header: text.slice(start, open + "AS $$".length),
    body: text.slice(open + "AS $$\n".length, close),
  };
}

const BINDING_HEAD = "CREATE FUNCTION public.raw_source_policy_binding_v3(";
const LEGACY_HEAD =
  "CREATE OR REPLACE FUNCTION public.write_raw_source_record_v2_legacy(p_command JSONB)";
/** The one statement that stands in for 20260826130000 L911-947. */
const BINDING_CALL = [
  "  derived_snapshot := public.raw_source_policy_binding_v3(",
  "    command_provider_key,command_ingest_status,source_host,",
  "    command_payload,command_source_policy_id,command_retention_days",
  "  );",
];

describe("public_web company-site source policy migration", () => {
  const sql = migrationSql(MIGRATION);

  it("runs in one bounded transaction that only defines the binding function and redefines the legacy writer", () => {
    const statements = topLevelStatements(sql);

    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements).toContain("SET LOCAL lock_timeout = '5s'");
    expect(statements).toContain("SET LOCAL statement_timeout = '30s'");
    expect(
      statements.filter((statement) => /^create\b/iu.test(statement)).map(
        (statement) => statement.slice(0, statement.indexOf("(")),
      ),
    ).toEqual([
      "CREATE FUNCTION public.raw_source_policy_binding_v3",
      "CREATE OR REPLACE FUNCTION public.write_raw_source_record_v2_legacy",
    ]);
    expect(
      statements.filter((statement) => /^revoke\b/iu.test(statement)),
    ).toEqual([
      "REVOKE ALL ON FUNCTION public.raw_source_policy_binding_v3(TEXT,TEXT,TEXT,JSONB,UUID,INTEGER) FROM PUBLIC, app_user",
      "REVOKE ALL ON FUNCTION public.write_raw_source_record_v2_legacy(JSONB) FROM PUBLIC, app_user",
    ]);
    // No schema, row or grant change: no table, column, data, owner or privilege statement.
    expect(statements).toHaveLength(8);
    for (const statement of statements) {
      expect(statement).not.toMatch(
        /^(?:alter|drop|grant|insert|update|delete|truncate|copy|comment)\b|^create\s+(?!(?:or\s+replace\s+)?function\b)/iu,
      );
    }
  });

  it("copies the legacy writer body verbatim, swapping only the policy block for the binding call", () => {
    const original = migrationSql(WRITER_HARDENING);
    // The anchors of 20260826130000: the header, the body and the replaced policy block.
    expect(lineRange(original, 695, 695)).toEqual([
      "CREATE OR REPLACE FUNCTION write_raw_source_record_v2(p_command JSONB)",
    ]);
    expect(lineRange(original, 706, 707)).toEqual(["AS $$", "DECLARE"]);
    expect(lineRange(original, 911, 911)).toEqual([
      "  IF command_source_policy_id IS NULL THEN",
    ]);
    expect(lineRange(original, 947, 948)).toEqual(["  END IF;", ""]);
    expect(lineRange(original, 1010, 1011)).toEqual(["END", "$$;"]);

    const legacy = routine(sql, LEGACY_HEAD);
    expect(legacy.body).toBe(
      [
        ...lineRange(original, 707, 910),
        ...BINDING_CALL,
        ...lineRange(original, 948, 1010),
      ].join("\n"),
    );
    // Same signature, result columns, language and SECURITY DEFINER; only the name is now the
    // renamed one (20260826150000) and pg_temp is listed last (20261009160000).
    expect(legacy.header).toBe(
      [
        LEGACY_HEAD,
        ...lineRange(original, 696, 704),
        "SET search_path = pg_catalog, public, pg_temp",
        "AS $$",
      ].join("\n"),
    );
  });

  it("keeps the binding function an owner-only helper on a pg_temp-last search_path", () => {
    const binding = routine(sql, BINDING_HEAD);

    expect(binding.header).toContain(
      "RETURNS JSONB\nLANGUAGE plpgsql\nSET search_path = pg_catalog, public, pg_temp\nAS $$",
    );
    // It runs inside the SECURITY DEFINER writer with the owner's rights and takes a row lock,
    // so it is neither a definer itself nor STABLE/IMMUTABLE.
    expect(binding.header).not.toMatch(/SECURITY|STABLE|IMMUTABLE|STRICT/u);
    expect(binding.body).toContain("FOR KEY SHARE");
    // Every relation is schema-qualified (set-returning function calls are not relations, and
    // IS DISTINCT FROM is a comparison).
    const relations = [
      ...binding.body.matchAll(
        /(?<!DISTINCT\s+)\b(?:FROM|JOIN)\s+([A-Za-z_][\w.]*)\b(?!\s*\()/gu,
      ),
    ].map((match) => match[1]);
    expect(relations.length).toBeGreaterThan(0);
    expect(relations.every((relation) => relation === "public.source_policy")).toBe(true);
    // The same error the replaced block raised, and no other.
    expect(
      [...binding.body.matchAll(/RAISE EXCEPTION '([A-Z_]+)'/gu)].map((match) => match[1]),
    ).toEqual(
      expect.arrayContaining(["RAW_SOURCE_WRITER_POLICY_BINDING_INVALID"]),
    );
    expect(
      new Set(
        [...binding.body.matchAll(/RAISE EXCEPTION '([A-Z_]+)'/gu)].map((match) => match[1]),
      ),
    ).toEqual(new Set(["RAW_SOURCE_WRITER_POLICY_BINDING_INVALID"]));
  });

  it("names the reserved company-site key exactly as Raw ingestion and the seed do", () => {
    const literals = [...sql.matchAll(/'(public_web:[^']*)'/gu)].map((match) => match[1]);

    expect(literals.length).toBeGreaterThanOrEqual(2);
    expect(new Set(literals)).toEqual(new Set([PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN]));
  });

  it("compares hosts and policy domains with the ASCII fold and www. rule of Raw ingestion", () => {
    const binding = routine(sql, BINDING_HEAD).body;

    // Both the candidate site policies and the bound one are folded before www. is dropped.
    expect(
      binding.match(/'ABCDEFGHIJKLMNOPQRSTUVWXYZ',\s*'abcdefghijklmnopqrstuvwxyz'/gu)
        ?.length,
    ).toBe(2);
    expect(binding.match(/'\^www\\\.'/gu)?.length).toBe(3);
    // lower() would follow the database collation; Raw ingestion folds ASCII only.
    expect(binding).not.toMatch(/\blower\(/u);
  });
});
