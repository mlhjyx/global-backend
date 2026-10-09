import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * While a routine runs on a search_path that does not list pg_temp, PostgreSQL searches
 * pg_temp FIRST for tables, so a session that may create temporary tables (app_user may) can
 * shadow a table the routine reads unqualified. A SECURITY DEFINER routine then acts on the
 * session's rows with its owner's rights; so does a SECURITY INVOKER routine with its own
 * search_path setting when it runs inside one (a helper call or a trigger), because its own
 * setting replaces the caller's. The hardening migration moved every earlier routine that sets
 * a search_path to one ending in pg_temp; this guard keeps later migrations from adding one
 * without it, or a SECURITY DEFINER routine without any. The migrated catalog is checked by
 * `security-definer-search-path.postgres.spec.ts`.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../../../packages/db/prisma/migrations/', import.meta.url),
);
const HARDENING_MIGRATION = '20261009160000_security_definer_search_path_pg_temp';
/**
 * Migrations up to and including the hardening one. A migration named earlier but merged
 * later would apply after the hardening on an existing database and could quietly undo it,
 * and the runtime would also refuse it (its latest migration must match the image's).
 */
const MIGRATIONS_THROUGH_HARDENING = 140;

const migrations = readdirSync(MIGRATIONS)
  .filter((name) => existsSync(`${MIGRATIONS}${name}/migration.sql`))
  .sort();

function migrationSql(name: string): string {
  return readFileSync(`${MIGRATIONS}${name}/migration.sql`, 'utf8');
}

const IDENTIFIER_CHARACTER = /[\w$]/u;

/** End index of the quoted literal or identifier that opens at `start`. */
function quotedEnd(sql: string, start: number, backslashEscapes: boolean): number {
  const quote = sql[start];
  let end = start + 1;
  while (end < sql.length) {
    if (backslashEscapes && sql[end] === '\\') {
      end += 2;
    } else if (sql[end] === quote) {
      if (sql[end + 1] !== quote) return end;
      end += 2;
    } else {
      end += 1;
    }
  }
  return end;
}

/**
 * Top-level statements with comments dropped and every dollar-quoted body replaced by
 * `$body$`, so text inside a function body is never read as a routine attribute. Quoted
 * literals and identifiers stay: `SET search_path TO 'pg_catalog', 'public'`.
 */
export function topLevelStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;
  while (index < sql.length) {
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      let depth = 0;
      do {
        if (sql.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      } while (depth > 0 && index < sql.length);
      current += ' ';
      continue;
    }
    const character = sql[index]!;
    const previous = sql[index - 1] ?? '';
    if (character === "'" || character === '"') {
      // E'…' takes backslash escapes; an E that ends an identifier does not start one.
      const escaped =
        character === "'" &&
        /^[Ee]$/u.test(previous) &&
        !IDENTIFIER_CHARACTER.test(sql[index - 2] ?? '');
      const end = quotedEnd(sql, index, escaped);
      current += sql.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    // `$` inside an identifier (foo$bar$) never opens a dollar quote.
    const dollar = IDENTIFIER_CHARACTER.test(previous)
      ? null
      : /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(sql.slice(index, index + 64));
    if (dollar) {
      const end = sql.indexOf(dollar[0], index + dollar[0].length);
      if (end === -1) throw new Error(`unterminated dollar quote ${dollar[0]}`);
      current += ' $body$ ';
      index = end + dollar[0].length;
      continue;
    }
    if (character === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else {
      current += character;
    }
    index += 1;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

const ROUTINE_DEFINITION = /^create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+([^\s(]+)/iu;
const ROUTINE_ALTERATION = /^alter\s+(?:function|procedure|routine)\s+([^\s(]+)/iu;
const SEARCH_PATH_ENTRY = String.raw`(?:'[^']*'|"[^"]*"|[A-Za-z_][\w$]*)`;
const SEARCH_PATH_LIST = new RegExp(
  String.raw`\bset\s+search_path\s*(?:=|\bto\b)\s*(${SEARCH_PATH_ENTRY}(?:\s*,\s*${SEARCH_PATH_ENTRY})*)`,
  'iu',
);
const SETS_SEARCH_PATH = /\bset\s+search_path\b/iu;
const RESETS_SEARCH_PATH = /\breset\s+(?:search_path|all)\b/iu;
const SECURITY_DEFINER = /\bsecurity\s+definer\b/iu;

/** Schemas of a `SET search_path` list, or null for FROM CURRENT and other forms. */
function searchPathEntries(statement: string): string[] | null {
  const list = SEARCH_PATH_LIST.exec(statement)?.[1];
  if (list === undefined) return null;
  // One quoted literal is one schema name: 'pg_catalog, public, pg_temp' is not three.
  return [...list.matchAll(new RegExp(SEARCH_PATH_ENTRY, 'gu'))].map(([entry]) =>
    entry.startsWith("'") || entry.startsWith('"') ? entry.slice(1, -1) : entry.toLowerCase(),
  );
}

/**
 * The routine a statement leaves on a search_path where pg_temp is not last, or null:
 * - any CREATE or ALTER that sets a search_path not ending in pg_temp (DEFAULT and
 *   FROM CURRENT included);
 * - a SECURITY DEFINER routine created without a search_path, or switched to SECURITY
 *   DEFINER without one in the same statement;
 * - an ALTER that resets the search_path (RESET search_path, RESET ALL).
 */
export function unsafeRoutine(statement: string): string | null {
  const definition = ROUTINE_DEFINITION.exec(statement);
  const name = (definition ?? ROUTINE_ALTERATION.exec(statement))?.[1];
  if (!name) return null;
  if (SETS_SEARCH_PATH.test(statement)) {
    return searchPathEntries(statement)?.at(-1) === 'pg_temp' ? null : name;
  }
  if (!definition && RESETS_SEARCH_PATH.test(statement)) return name;
  return SECURITY_DEFINER.test(statement) ? name : null;
}

function unsafeRoutines(names: readonly string[]): string[] {
  return names.flatMap((name) =>
    topLevelStatements(migrationSql(name))
      .map(unsafeRoutine)
      .filter((routine): routine is string => routine !== null)
      .map((routine) => `${name}: ${routine}`),
  );
}

describe('routine search_path guard', () => {
  it('reads routine attributes outside function bodies only', () => {
    const probes: ReadonlyArray<readonly [string, string | null]> = [
      ['CREATE FUNCTION a() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ SELECT 1 $$', null],
      ["CREATE OR REPLACE FUNCTION public.b() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $f$ SELECT 1 $f$", null],
      ['CREATE FUNCTION c() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT 1 $$', 'c'],
      ['CREATE FUNCTION d() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$', 'd'],
      ['CREATE FUNCTION e() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_temp, pg_catalog, public AS $$ SELECT 1 $$', 'e'],
      ['CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$ SELECT 1 $$', 'f'],
      ["CREATE FUNCTION g() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = 'pg_catalog, public, pg_temp' AS $$ SELECT 1 $$", 'g'],
      ['CREATE FUNCTION h() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path TO DEFAULT AS $$ SELECT 1 $$', 'h'],
      // SECURITY INVOKER: its own setting replaces the caller's, so it must end in pg_temp too.
      ['CREATE FUNCTION i() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$ BEGIN RETURN NEW; END $$', 'i'],
      ['CREATE FUNCTION j() RETURNS int LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $$ SELECT 1 $$', null],
      ['CREATE FUNCTION k() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$', null],
      ["CREATE FUNCTION l() RETURNS text LANGUAGE sql AS $$ SELECT 'SECURITY DEFINER SET search_path = x' $$", null],
      ['CREATE FUNCTION m() RETURNS int AS $body$ SELECT 1 $body$ LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public', 'm'],
      ['CREATE PROCEDURE n() LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT 1 $$', 'n'],
      ['CREATE FUNCTION o$p$() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT 1 $$', 'o$p$'],
      ['ALTER FUNCTION q(uuid) SET search_path = pg_catalog, public', 'q'],
      ['ALTER FUNCTION r(uuid) SET search_path FROM CURRENT', 'r'],
      ['ALTER FUNCTION s(uuid) RESET search_path', 's'],
      ['ALTER FUNCTION t(uuid) RESET ALL', 't'],
      ['ALTER FUNCTION u(uuid) SECURITY DEFINER', 'u'],
      ['ALTER FUNCTION v(uuid) SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp', null],
      ['ALTER FUNCTION w(uuid) OWNER TO app_user', null],
    ];
    for (const [sql, expected] of probes) {
      const statements = topLevelStatements(`-- probe\n${sql}; /* trailing */`);
      expect(statements, sql).toHaveLength(1);
      expect(unsafeRoutine(statements[0]!), sql).toBe(expected);
    }
  });

  it('splits statements around escape strings and quoted semicolons', () => {
    const statements = topLevelStatements(
      "COMMENT ON TABLE t IS E'it\\'s; still one';\n" +
        "COMMENT ON TABLE u IS 'a ''quoted''; one';\n" +
        'CREATE FUNCTION x() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1; $$;',
    );
    expect(statements).toHaveLength(3);
    expect(unsafeRoutine(statements[2]!)).toBe('x');
  });

  it('finds the earlier routines the hardening migration exists for', () => {
    // The guard below would pass vacuously if the parser missed every routine.
    const earlier = unsafeRoutines(migrations.filter((name) => name < HARDENING_MIGRATION));
    expect(earlier.length).toBeGreaterThan(150);
  });

  it('admits no migration named before the hardening migration', () => {
    expect(migrations).toContain(HARDENING_MIGRATION);
    expect(migrations.filter((name) => name <= HARDENING_MIGRATION)).toHaveLength(
      MIGRATIONS_THROUGH_HARDENING,
    );
  });

  it('keeps every routine set or altered after the hardening migration on a pg_temp-last search_path', () => {
    expect(unsafeRoutines(migrations.filter((name) => name > HARDENING_MIGRATION))).toEqual([]);
  });

  it('hardens the earlier routines in one transaction, changing settings only', () => {
    const sql = migrationSql(HARDENING_MIGRATION);
    const statements = topLevelStatements(sql);
    expect(statements[0]).toMatch(/^begin$/iu);
    expect(statements.at(-1)).toMatch(/^commit$/iu);
    expect(statements.some((statement) => /^set\s+local\s+lock_timeout\b/iu.test(statement))).toBe(true);
    // No CREATE: every routine body, owner and grant stays exactly as it was.
    expect(statements.some((statement) => /^create\b/iu.test(statement))).toBe(false);
    expect(sql).toMatch(/\bprosecdef\b/u);
    expect(sql).toMatch(/deptype\s*=\s*'e'/u);
    expect(sql).toMatch(/SET search_path = pg_catalog, public, pg_temp/u);
    expect(sql).toMatch(/RAISE EXCEPTION/u);
  });
});
