import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const migrationsRoot = `${repoRoot}packages/db/prisma/migrations`;

const LEASE_MIGRATION = '20261009170000_discovery_run_admission_lease';
const HARDENING_MIGRATION = '20261009160000_security_definer_search_path_pg_temp';
const CONSUME_ORIGIN = '20260821090000_execution_budget_authority';
const ATTEST_ORIGIN = '20260822203000_execution_budget_account_attestation';
const CONSUME = 'consume_workspace_execution_authority';
const ATTEST = 'attest_authorized_tool_budget_v1';

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

/** Applies one intended edit; the edit must hit exactly one place. */
function replaceOnce(text: string, [from, to]: readonly [string, string]): string {
  const hits = text.split(from).length - 1;
  if (hits !== 1) {
    throw new Error(`expected one occurrence of ${JSON.stringify(from)}, found ${hits}`);
  }
  return text.replace(from, () => to);
}

function normalized(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

async function migrationDirectories(): Promise<string[]> {
  return (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function migrationsDefining(name: string): Promise<string[]> {
  const definers: string[] = [];
  for (const directory of await migrationDirectories()) {
    const sql = await migrationSql(directory);
    if (new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${name}\\(`).test(sql)) {
      definers.push(directory);
    }
  }
  return definers;
}

describe('discovery run admission lease migration', () => {
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
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|GRANT|REVOKE)\b/);
    expect(sql).not.toMatch(/\bSECURITY\s+INVOKER\b/i);
  });

  it('adds one nullable lease column without a default and a two-valued shape CHECK', async () => {
    const sql = await migrationSql(LEASE_MIGRATION);

    expect(sql).toContain(
      'ALTER TABLE "execution_budget_authority"\n  ADD COLUMN "admission_lease_expires_at" TIMESTAMPTZ(3),\n',
    );
    expect(sql.match(/ADD COLUMN/g)).toHaveLength(1);
    expect(sql).not.toMatch(/"admission_lease_expires_at"[^,\n]*\b(?:NOT NULL|DEFAULT)\b/i);

    const check = sql.slice(
      sql.indexOf('ADD CONSTRAINT "execution_budget_authority_admission_lease_check"'),
      sql.indexOf(');', sql.indexOf('ADD CONSTRAINT')) + 2,
    );
    expect(normalized(check)).toBe(
      normalized(`ADD CONSTRAINT "execution_budget_authority_admission_lease_check" CHECK (
        "admission_lease_expires_at" IS NULL
        OR (
          "authority_kind" = 'WORKSPACE_GRANT'
          AND "purpose" = 'discovery.run'
          AND "subject_type" = 'discovery_run'
          AND "consumed_at" IS NOT NULL
          AND "admission_lease_expires_at" > "expires_at"
          AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '3 hours'
        )
      );`),
    );
    expect(sql).toMatch(
      /COMMENT ON COLUMN "execution_budget_authority"\."admission_lease_expires_at" IS\n {2}'[^']+';/,
    );
  });

  it('redefines only consume and attest, and nothing that admits on the Grant window', async () => {
    const sql = await migrationSql(LEASE_MIGRATION);

    expect(
      [...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION\s+([a-z0-9_]+)\s*\(/gi)].map(
        (match) => match[1],
      ),
    ).toEqual([CONSUME, ATTEST]);
    expect(sql).not.toMatch(/FUNCTION\s+open_authorized_tool_budget_v1/);
    expect(sql).not.toMatch(/FUNCTION\s+ingest_and_admit_platform_execution_budget_run_v2/);
    expect(sql).not.toMatch(/FUNCTION\s+execution_budget_authority_time_state/);

    // The lease the function writes is the CHECK's upper bound.
    expect(sql.match(/INTERVAL '3 hours'/g)).toHaveLength(2);
  });

  it('copies consume verbatim except one admission instant used for consumed_at and the lease', async () => {
    const original = functionStatement(await migrationSql(CONSUME_ORIGIN), CONSUME);
    const lease = functionStatement(await migrationSql(LEASE_MIGRATION), CONSUME);

    const expected = (
      [
        [`CREATE FUNCTION ${CONSUME}(`, `CREATE OR REPLACE FUNCTION ${CONSUME}(`],
        [
          'SECURITY DEFINER\nSET search_path = pg_catalog, public\nAS $$',
          'SECURITY DEFINER\nSET search_path = pg_catalog, public, pg_temp\nAS $$',
        ],
        ['  time_state TEXT;\nBEGIN', '  time_state TEXT;\n  admitted_at TIMESTAMPTZ;\nBEGIN'],
        [
          '  INSERT INTO "execution_budget_authority"(',
          '  admitted_at := clock_timestamp();\n  INSERT INTO "execution_budget_authority"(',
        ],
        [
          '    "issued_at", "not_before", "expires_at", "consumed_at"\n',
          '    "issued_at", "not_before", "expires_at", "consumed_at",\n    "admission_lease_expires_at"\n',
        ],
        [
          '    p_cap_microusd, p_issued_at, p_not_before, p_expires_at, clock_timestamp()\n',
          [
            '    p_cap_microusd, p_issued_at, p_not_before, p_expires_at, admitted_at,',
            '    CASE',
            "      WHEN p_purpose = 'discovery.run' AND p_subject_type = 'discovery_run'",
            "        THEN admitted_at + INTERVAL '3 hours'",
            '    END',
            '',
          ].join('\n'),
        ],
      ] as const
    ).reduce(replaceOnce, original);

    expect(lease).toBe(expected);
    expect(lease).toContain('\nLANGUAGE plpgsql\nSECURITY DEFINER\n');
    expect(lease).not.toMatch(/\n(?:STABLE|IMMUTABLE)\n/);
    expect(lease.match(/clock_timestamp\(\)/g)).toHaveLength(1);
    // The replay branch returns the stored row and never rewrites the lease.
    expect(lease.match(/admission_lease_expires_at/g)).toHaveLength(1);
  });

  it('copies attest verbatim except the lease-or-Grant-window expiry and keeps it read-only', async () => {
    const original = functionStatement(await migrationSql(ATTEST_ORIGIN), ATTEST);
    const lease = functionStatement(await migrationSql(LEASE_MIGRATION), ATTEST);

    const expected = (
      [
        [`CREATE FUNCTION ${ATTEST}(`, `CREATE OR REPLACE FUNCTION ${ATTEST}(`],
        [
          'SECURITY DEFINER\nSET search_path = pg_catalog, public\nAS $$',
          'SECURITY DEFINER\nSET search_path = pg_catalog, public, pg_temp\nAS $$',
        ],
        [
          '    authority."expires_at",\n    statement_timestamp()\n',
          '    COALESCE(authority."admission_lease_expires_at", authority."expires_at"),\n    statement_timestamp()\n',
        ],
      ] as const
    ).reduce(replaceOnce, original);

    expect(lease).toBe(expected);
    expect(lease).toContain('\nLANGUAGE plpgsql\nSTABLE\nSECURITY DEFINER\n');
    expect(lease).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it('copies from the latest earlier definitions: nothing redefined either function in between', async () => {
    const throughLease = (definers: string[]) =>
      definers.filter((directory) => directory <= LEASE_MIGRATION);

    expect(throughLease(await migrationsDefining(CONSUME))).toEqual([CONSUME_ORIGIN, LEASE_MIGRATION]);
    expect(throughLease(await migrationsDefining(ATTEST))).toEqual([ATTEST_ORIGIN, LEASE_MIGRATION]);
  });

  it('deploys after the SECURITY DEFINER search_path hardening, which must already be on the branch', async () => {
    // The runtime compares the database's last finished migration with the image's
    // alphabetically last one. If the hardening merged after this migration, deploying it
    // later would leave those two apart and the runtime would refuse to start, so the
    // hardening (#616) has to merge first.
    expect(await migrationDirectories()).toContain(HARDENING_MIGRATION);
    expect(LEASE_MIGRATION > HARDENING_MIGRATION).toBe(true);
  });

  it('maps the column in the Prisma model so migrate dev does not drop it', async () => {
    const schema = await readFile(`${repoRoot}packages/db/prisma/schema.prisma`, 'utf8');
    const model = schema.slice(
      schema.indexOf('model ExecutionBudgetAuthority {'),
      schema.indexOf('\n}', schema.indexOf('model ExecutionBudgetAuthority {')),
    );

    expect(model).toMatch(
      /\n {2}admissionLeaseExpiresAt +DateTime\? +@map\("admission_lease_expires_at"\) @db\.Timestamptz\(3\)\n/,
    );
  });
});
