import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const migrationsRoot = `${repoRoot}packages/db/prisma/migrations`;

const ICP_LEASE_MIGRATION = '20261010110000_icp_admission_lease';
const DISCOVERY_LEASE_MIGRATION = '20261009170000_discovery_run_admission_lease';
const CONSUME_ORIGIN = '20260821090000_execution_budget_authority';
const CONSUME = 'consume_workspace_execution_authority';
const ATTEST = 'attest_authorized_tool_budget_v1';
const LEASE_CHECK = 'execution_budget_authority_admission_lease_check';

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

/** The ALTER TABLE statement that replaces the lease CHECK. */
function leaseCheckStatement(sql: string): string {
  const start = sql.indexOf('ALTER TABLE "execution_budget_authority"');
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf('\n  );\n', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + '\n  );'.length);
}

/** `purpose/subject_type` → lease duration, as one SQL text spells it. */
function leaseDurations(text: string, pattern: RegExp): Record<string, string> {
  return Object.fromEntries(
    [...text.matchAll(pattern)].map(([, purpose, subjectType, duration]) => [
      `${purpose}/${subjectType}`,
      duration,
    ]),
  );
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

describe('ICP design and query plan admission lease migration', () => {
  it('is one forward-only transaction with bounded locks and no backfill', async () => {
    const sql = await migrationSql(ICP_LEASE_MIGRATION);

    expect(sql).toMatch(/^--[^]*?\nBEGIN;\n/);
    expect(sql.trimEnd()).toMatch(/\nCOMMIT;$/);
    expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '30s';");
    expect(sql).not.toMatch(/\bUPDATE\s+"?execution_budget_authority"?/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\b(?:TRUNCATE|GRANT|REVOKE|ADD COLUMN)\b/);
    expect(sql).not.toMatch(/\bSECURITY\s+INVOKER\b/i);
    // The only thing dropped is the CHECK that the same statement adds back.
    expect([...sql.matchAll(/\bDROP\b[^\n]*/g)].map(([line]) => line)).toEqual([
      `DROP CONSTRAINT "${LEASE_CHECK}",`,
    ]);
  });

  it('replaces the lease CHECK with one cap per admitted pair, keeping the other conditions', async () => {
    const sql = await migrationSql(ICP_LEASE_MIGRATION);

    expect(normalized(leaseCheckStatement(sql))).toBe(
      normalized(`ALTER TABLE "execution_budget_authority"
        DROP CONSTRAINT "${LEASE_CHECK}",
        ADD CONSTRAINT "${LEASE_CHECK}" CHECK (
          "admission_lease_expires_at" IS NULL
          OR (
            "authority_kind" = 'WORKSPACE_GRANT'
            AND "consumed_at" IS NOT NULL
            AND "admission_lease_expires_at" > "expires_at"
            AND (
              (
                "purpose" = 'discovery.run'
                AND "subject_type" = 'discovery_run'
                AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '3 hours'
              )
              OR (
                "purpose" = 'icp.design'
                AND "subject_type" = 'company'
                AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '30 minutes'
              )
              OR (
                "purpose" = 'icp.query_plan'
                AND "subject_type" = 'icp'
                AND "admission_lease_expires_at" <= "consumed_at" + INTERVAL '30 minutes'
              )
            )
          )
        );`),
    );
    expect(sql).toMatch(
      /COMMENT ON COLUMN "execution_budget_authority"\."admission_lease_expires_at" IS\n {2}'[^']+';/,
    );
    const comment = /COMMENT ON COLUMN [^\n]+\n {2}'([^']+)';/.exec(sql)![1]!;
    expect(comment).toContain('3 hours');
    expect(comment).toContain('30 minutes');
    expect(comment).toContain('icp.design');
    expect(comment).toContain('icp.query_plan');
  });

  it('writes each pair exactly the lease its CHECK caps, and nothing for any other admission', async () => {
    const sql = await migrationSql(ICP_LEASE_MIGRATION);
    const check = leaseDurations(
      leaseCheckStatement(sql),
      new RegExp(
        [
          `"purpose" = '([^']+)'`,
          `AND "subject_type" = '([^']+)'`,
          `AND "admission_lease_expires_at" <= "consumed_at" \\+ INTERVAL '([^']+)'`,
        ].join('\\s+'),
        'g',
      ),
    );
    const stamped = leaseDurations(
      functionStatement(sql, CONSUME),
      /WHEN p_purpose = '([^']+)' AND p_subject_type = '([^']+)'\s+THEN admitted_at \+ INTERVAL '([^']+)'/g,
    );

    expect(check).toEqual({
      'discovery.run/discovery_run': '3 hours',
      'icp.design/company': '30 minutes',
      'icp.query_plan/icp': '30 minutes',
    });
    expect(stamped).toEqual(check);
    // A CASE without ELSE leaves every other admission NULL.
    expect(functionStatement(sql, CONSUME)).not.toMatch(/\bELSE\b/);
  });

  it('redefines only consume: attest, open and the platform entries keep their definitions', async () => {
    const sql = await migrationSql(ICP_LEASE_MIGRATION);

    expect(
      [...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION\s+([a-z0-9_]+)\s*\(/gi)].map(
        (match) => match[1],
      ),
    ).toEqual([CONSUME]);
    expect(sql).not.toMatch(/FUNCTION\s+attest_authorized_tool_budget_v1/);
    expect(sql).not.toMatch(/FUNCTION\s+open_authorized_tool_budget_v1/);
    expect(sql).not.toMatch(/FUNCTION\s+ingest_and_admit_platform_execution_budget_run_v2/);
    expect(sql).not.toMatch(/FUNCTION\s+execution_budget_authority_time_state/);

    // Attest already judges expiry by the lease, else the Grant window (since #618).
    const attestDefiners = (await migrationsDefining(ATTEST)).filter(
      (directory) => directory <= ICP_LEASE_MIGRATION,
    );
    expect(attestDefiners.at(-1)).toBe(DISCOVERY_LEASE_MIGRATION);
    expect(functionStatement(await migrationSql(DISCOVERY_LEASE_MIGRATION), ATTEST)).toContain(
      'COALESCE(authority."admission_lease_expires_at", authority."expires_at")',
    );
  });

  it('copies consume verbatim from its latest definition except the two ICP lease branches', async () => {
    const previous = functionStatement(await migrationSql(DISCOVERY_LEASE_MIGRATION), CONSUME);
    const lease = functionStatement(await migrationSql(ICP_LEASE_MIGRATION), CONSUME);

    const expected = (
      [
        [
          "        THEN admitted_at + INTERVAL '3 hours'\n    END\n",
          [
            "        THEN admitted_at + INTERVAL '3 hours'",
            "      WHEN p_purpose = 'icp.design' AND p_subject_type = 'company'",
            "        THEN admitted_at + INTERVAL '30 minutes'",
            "      WHEN p_purpose = 'icp.query_plan' AND p_subject_type = 'icp'",
            "        THEN admitted_at + INTERVAL '30 minutes'",
            '    END',
            '',
          ].join('\n'),
        ],
      ] as const
    ).reduce(replaceOnce, previous);

    expect(lease).toBe(expected);
    // Every attribute CREATE OR REPLACE resets is restated: definer, volatile, pg_temp last.
    expect(lease).toContain(
      '\nLANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = pg_catalog, public, pg_temp\nAS $$\n',
    );
    expect(lease).not.toMatch(/\n(?:STABLE|IMMUTABLE)\n/);
    // One admission instant serves consumed_at and the lease, so the CHECK holds exactly.
    expect(lease.match(/clock_timestamp\(\)/g)).toHaveLength(1);
    // The replay branch returns the stored row and never rewrites the lease.
    expect(lease.match(/admission_lease_expires_at/g)).toHaveLength(1);
  });

  it('copies from the latest earlier definition: nothing redefined consume in between', async () => {
    const throughLease = (definers: string[]) =>
      definers.filter((directory) => directory <= ICP_LEASE_MIGRATION);

    expect(throughLease(await migrationsDefining(CONSUME))).toEqual([
      CONSUME_ORIGIN,
      DISCOVERY_LEASE_MIGRATION,
      ICP_LEASE_MIGRATION,
    ]);
  });

  it('documents both lease durations on the Prisma field', async () => {
    const schema = await readFile(`${repoRoot}packages/db/prisma/schema.prisma`, 'utf8');
    const field = /\n((?: {2}\/\/\/[^\n]*\n)+) {2}admissionLeaseExpiresAt +DateTime\?/.exec(schema);

    expect(field).not.toBeNull();
    expect(field![1]).toContain('3 hours');
    expect(field![1]).toContain('30 minutes');
  });
});
