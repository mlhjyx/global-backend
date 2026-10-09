import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * PostgreSQL searches pg_temp FIRST for tables when a search_path does not list it, so a
 * session that may create temporary tables (app_user may) can shadow a table a SECURITY
 * DEFINER routine reads unqualified, and the routine then runs with its owner's rights on
 * the session's rows. Listing pg_temp last closes that. The hardening migration moved every
 * earlier SECURITY DEFINER routine; this guard keeps later migrations from adding one
 * without it. `security-definer-search-path.postgres.spec.ts` checks the migrated catalog.
 */
const MIGRATIONS = fileURLToPath(
  new URL('../../../../packages/db/prisma/migrations/', import.meta.url),
);
const HARDENING_MIGRATION = '20261009160000_security_definer_search_path_pg_temp';

const migrations = readdirSync(MIGRATIONS)
  .filter((name) => existsSync(`${MIGRATIONS}${name}/migration.sql`))
  .sort();

function migrationSql(name: string): string {
  return readFileSync(`${MIGRATIONS}${name}/migration.sql`, 'utf8');
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
    if (character === "'" || character === '"') {
      let end = index + 1;
      while (end < sql.length && !(sql[end] === character && sql[end + 1] !== character)) {
        end += sql[end] === character ? 2 : 1;
      }
      current += sql.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    // `$` inside an identifier (foo$bar$) never opens a dollar quote.
    const dollar = /[\w$]/u.test(sql[index - 1] ?? '')
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
const SEARCH_PATH = new RegExp(
  String.raw`\bset\s+search_path\s*(?:=|\bto\b)\s*(${SEARCH_PATH_ENTRY}(?:\s*,\s*${SEARCH_PATH_ENTRY})*)`,
  'iu',
);
const SECURITY_DEFINER = /\bsecurity\s+definer\b/iu;

function searchPathEntries(statement: string): string[] | null {
  const list = SEARCH_PATH.exec(statement)?.[1];
  return list === undefined
    ? null
    : list.split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/gu, '').toLowerCase());
}

/**
 * The routine a statement leaves as SECURITY DEFINER without pg_temp as its last search_path
 * entry, or null. An ALTER that sets a search_path must end with pg_temp too, and one that
 * switches a routine to SECURITY DEFINER must set the search_path in the same statement.
 */
export function unsafeDefinerRoutine(statement: string): string | null {
  const definition = ROUTINE_DEFINITION.exec(statement);
  const name = (definition ?? ROUTINE_ALTERATION.exec(statement))?.[1];
  if (!name) return null;
  const entries = searchPathEntries(statement);
  if (definition && !SECURITY_DEFINER.test(statement)) return null;
  if (!definition && !entries && !SECURITY_DEFINER.test(statement)) return null;
  return entries?.at(-1) === 'pg_temp' ? null : name;
}

function unsafeRoutines(names: readonly string[]): string[] {
  return names.flatMap((name) =>
    topLevelStatements(migrationSql(name))
      .map(unsafeDefinerRoutine)
      .filter((routine): routine is string => routine !== null)
      .map((routine) => `${name}: ${routine}`),
  );
}

describe('SECURITY DEFINER search_path guard', () => {
  it('reads routine attributes outside function bodies only', () => {
    const probes: ReadonlyArray<readonly [string, string | null]> = [
      ['CREATE FUNCTION a() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$ SELECT 1 $$', null],
      ["CREATE OR REPLACE FUNCTION public.b() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'pg_temp' AS $f$ SELECT 1 $f$", null],
      ['CREATE FUNCTION c() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT 1 $$', 'c'],
      ['CREATE FUNCTION d() RETURNS int LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$', 'd'],
      ['CREATE FUNCTION e() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_temp, pg_catalog, public AS $$ SELECT 1 $$', 'e'],
      ['CREATE FUNCTION f() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path FROM CURRENT AS $$ SELECT 1 $$', 'f'],
      ['CREATE FUNCTION g() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$', null],
      ["CREATE FUNCTION h() RETURNS text LANGUAGE sql AS $$ SELECT 'SECURITY DEFINER SET search_path = x' $$", null],
      ['CREATE FUNCTION i() RETURNS int AS $body$ SELECT 1 $body$ LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public', 'i'],
      ['CREATE PROCEDURE j() LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$ SELECT 1 $$', 'j'],
      ['ALTER FUNCTION k(uuid) SET search_path = pg_catalog, public', 'k'],
      ['ALTER FUNCTION l(uuid) SECURITY DEFINER', 'l'],
      ['ALTER FUNCTION m(uuid) SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp', null],
      ['ALTER FUNCTION n(uuid) OWNER TO app_user', null],
    ];
    for (const [sql, expected] of probes) {
      const statements = topLevelStatements(`-- probe\n${sql}; /* trailing */`);
      expect(statements).toHaveLength(1);
      expect(unsafeDefinerRoutine(statements[0]!), sql).toBe(expected);
    }
  });

  it('finds the earlier routines the hardening migration exists for', () => {
    // The guard below would pass vacuously if the parser missed every routine.
    const earlier = unsafeRoutines(migrations.filter((name) => name < HARDENING_MIGRATION));
    expect(earlier.length).toBeGreaterThan(100);
  });

  it('keeps every SECURITY DEFINER routine added after the hardening migration on a pg_temp-last search_path', () => {
    expect(migrations).toContain(HARDENING_MIGRATION);
    expect(unsafeRoutines(migrations.filter((name) => name > HARDENING_MIGRATION))).toEqual([]);
  });

  it('hardens the earlier routines in one transaction, changing settings only', () => {
    expect(migrations).toContain(HARDENING_MIGRATION);
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
