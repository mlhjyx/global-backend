import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const migrationsRoot = `${repoRoot}packages/db/prisma/migrations`;

const LEASE_MIGRATION = '20261110090000_understanding_admission_lease';
const PRECEDENT = '20261010110000_icp_admission_lease';
const CONSUME = 'consume_workspace_execution_authority';

function migrationSql(name: string): Promise<string> {
  return readFile(`${migrationsRoot}/${name}/migration.sql`, 'utf8');
}

/** One CREATE [OR REPLACE] FUNCTION statement, from its header to the closing `$$;`. */
function functionStatement(sql: string, name: string): string {
  const headers = [
    ...sql.matchAll(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name}\\(`, 'g')),
  ];
  expect(headers, name).toHaveLength(1);
  const start = headers[0]!.index!;
  const end = sql.indexOf('\n$$;', start);
  expect(end, name).toBeGreaterThan(start);
  return sql.slice(start, end + '\n$$;'.length);
}

function normalized(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('understanding admission lease migration', () => {
  it('is one forward-only transaction with bounded locks and no backfill', async () => {
    const sql = await migrationSql(LEASE_MIGRATION);

    expect(sql).toMatch(/^--[^]*?\nBEGIN;\n/);
    expect(sql.trimEnd()).toMatch(/\nCOMMIT;$/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '30s';");
    expect(sql).not.toMatch(/\bUPDATE\s+"?execution_budget_authority"?/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bSECURITY\s+INVOKER\b/i);
  });

  it('lets only understanding.run + company carry the new 30 minute lease', async () => {
    const sql = await migrationSql(LEASE_MIGRATION);

    expect(normalized(sql)).toContain(
      normalized(`OR (
          "purpose" = 'understanding.run'
          AND "subject_type" = 'company'
          AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '30 minutes'
        )`),
    );
    // The lease still must exceed the Grant window and stay tied to a consumed grant.
    expect(normalized(sql)).toContain(
      normalized(`"admission_lease_expires_at" > "expires_at"`),
    );
  });

  it('redefines consume as the precedent body plus exactly one lease branch', async () => {
    const sql = await migrationSql(LEASE_MIGRATION);
    const precedent = await migrationSql(PRECEDENT);
    const body = functionStatement(sql, CONSUME);
    const base = functionStatement(precedent, CONSUME);

    const extended = base.replace(
      `      WHEN p_purpose = 'icp.query_plan' AND p_subject_type = 'icp'
        THEN admitted_at + INTERVAL '30 minutes'
    END`,
      () => `      WHEN p_purpose = 'icp.query_plan' AND p_subject_type = 'icp'
        THEN admitted_at + INTERVAL '30 minutes'
      WHEN p_purpose = 'understanding.run' AND p_subject_type = 'company'
        THEN admitted_at + INTERVAL '30 minutes'
    END`,
    );

    expect(normalized(body)).toBe(normalized(extended));
    expect(normalized(body)).toContain(
      normalized(`WHEN p_purpose = 'understanding.run' AND p_subject_type = 'company'
        THEN admitted_at + INTERVAL '30 minutes'`),
    );
    // Hardened attributes are restated verbatim.
    expect(body).toContain('LANGUAGE plpgsql');
    expect(body).toContain('SECURITY DEFINER');
    expect(normalized(body)).toContain(normalized('pg_catalog, public, pg_temp'));
  });
});
