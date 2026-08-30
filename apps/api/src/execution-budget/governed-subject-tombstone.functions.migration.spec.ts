import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const task1 = new URL(
  '../../../../packages/db/prisma/migrations/20260830120000_governed_subject_relation_schema/migration.sql',
  import.meta.url,
);
const task2 = new URL(
  '../../../../packages/db/prisma/migrations/20260830121000_governed_subject_relation_append_attest/migration.sql',
  import.meta.url,
);
const task3 = new URL(
  '../../../../packages/db/prisma/migrations/20260830122000_governed_subject_relation_tombstone/migration.sql',
  import.meta.url,
);
const FUNCTION = 'tombstone_workspace_governed_subject_v1';
const PARAMS = [
  'p_workspace_id UUID', 'p_governed_subject_id UUID', 'p_deletion_request_id UUID',
];
const RETURNS = [
  'governed_subject_id UUID', 'tombstoned_at TIMESTAMPTZ', 'audit_id UUID',
  'outcome VARCHAR(48)',
];

function compact(value: string): string {
  return value.replaceAll('"', '').replace(/\s+/gu, ' ').trim().toUpperCase();
}

function functionBlock(sql: string): string {
  const start = new RegExp(`CREATE FUNCTION public\\.${FUNCTION}\\(`, 'iu').exec(sql)?.index;
  if (start === undefined) throw new Error('TASK3_FUNCTION_MISSING');
  const tail = sql.slice(start);
  const delimiter = /\bAS\s+(\$[A-Za-z0-9_]*\$)/iu.exec(tail);
  if (!delimiter?.[1] || delimiter.index === undefined) throw new Error('TASK3_BODY_MISSING');
  const end = tail.indexOf(delimiter[1], delimiter.index + delimiter[0].length);
  if (end < 0) throw new Error('TASK3_BODY_END_MISSING');
  const semicolon = tail.indexOf(';', end + delimiter[1].length);
  if (semicolon < 0) throw new Error('TASK3_TERMINATOR_MISSING');
  return tail.slice(0, semicolon + 1);
}

function validate(sql: string): void {
  const block = functionBlock(sql);
  const signature = new RegExp(
    `CREATE FUNCTION public\\.${FUNCTION}\\(([^]*?)\\)\\s*RETURNS TABLE\\(([^]*?)\\)\\s*LANGUAGE`,
    'iu',
  ).exec(block);
  if (!signature) throw new Error('TASK3_SIGNATURE_MISSING');
  const split = (value: string) => value.split(',').map(compact);
  if (JSON.stringify(split(signature[1] ?? '')) !== JSON.stringify(PARAMS.map(compact))) {
    throw new Error('TASK3_PARAMETER_DRIFT');
  }
  if (JSON.stringify(split(signature[2] ?? '')) !== JSON.stringify(RETURNS.map(compact))) {
    throw new Error('TASK3_RETURN_DRIFT');
  }
  const normalized = compact(block);
  for (const required of [
    'LANGUAGE PLPGSQL', 'VOLATILE', 'SECURITY DEFINER',
    'SET SEARCH_PATH = PG_CATALOG, PUBLIC',
  ]) if (!normalized.includes(required)) throw new Error('TASK3_SECURITY_DRIFT');
  if (/\b(?:DISCOVERY|RAW_SOURCE|IDENTITY_LINK|CANONICAL_COMPANY|CONTACT|PROVIDER)\b/iu.test(block)) {
    throw new Error('TASK3_BUSINESS_OWNERSHIP');
  }
  const normalizedSql = compact(sql);
  if (!normalizedSql.includes(
    `REVOKE ALL ON FUNCTION PUBLIC.${FUNCTION.toUpperCase()}(UUID,UUID,UUID) FROM PUBLIC, APP_USER, EXECUTION_BUDGET_PLATFORM_WRITER, RUNTIME_API, RUNTIME_WORKER, RUNTIME_OUTBOX_RELAY`,
  )) {
    throw new Error('TASK3_REVOKE_MISSING');
  }
  if (!normalizedSql.includes(
    `GRANT EXECUTE ON FUNCTION PUBLIC.${FUNCTION.toUpperCase()}(UUID,UUID,UUID) TO APP_USER`,
  )) {
    throw new Error('TASK3_APP_GRANT_MISSING');
  }
  if (/GRANT EXECUTE ON FUNCTION public\._/iu.test(sql)) throw new Error('TASK3_HELPER_EXPOSED');
}

function fixture(): string {
  return `CREATE FUNCTION public.${FUNCTION}(${PARAMS.join(',')})
    RETURNS TABLE(${RETURNS.join(',')}) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path = pg_catalog, public AS $task3$ BEGIN RETURN; END $task3$;
    REVOKE ALL ON FUNCTION public.${FUNCTION}(UUID,UUID,UUID) FROM
      PUBLIC, app_user, execution_budget_platform_writer, runtime_api, runtime_worker,
      runtime_outbox_relay;
    GRANT EXECUTE ON FUNCTION public.${FUNCTION}(UUID,UUID,UUID) TO app_user;`;
}

describe('governed subject Task 3 tombstone migration contract', () => {
  it('mutation-proves the exact signature, security and ACL validator', () => {
    const valid = fixture();
    expect(() => validate(valid)).not.toThrow();
    expect(() => validate(valid.replace('p_deletion_request_id UUID', 'p_request UUID')))
      .toThrow('TASK3_PARAMETER_DRIFT');
    expect(() => validate(valid.replace('VOLATILE', 'STABLE')))
      .toThrow('TASK3_SECURITY_DRIFT');
    expect(() => validate(valid.replace('SECURITY DEFINER', 'SECURITY INVOKER')))
      .toThrow('TASK3_SECURITY_DRIFT');
    expect(() => validate(valid.replace('pg_catalog, public', 'public')))
      .toThrow('TASK3_SECURITY_DRIFT');
    expect(() => validate(`${valid}\nGRANT EXECUTE ON FUNCTION public._task3_helper() TO app_user;`))
      .toThrow('TASK3_HELPER_EXPOSED');
  });

  it('keeps Task 3 out of immutable Task 1 and Task 2 migrations', async () => {
    const [schema, appendAttest] = await Promise.all([readFile(task1, 'utf8'), readFile(task2, 'utf8')]);
    expect(schema).not.toContain(FUNCTION);
    expect(appendAttest).not.toContain(FUNCTION);
  });

  it('requires only the additive 20260830122000 migration with exact public contract', async () => {
    let sql: string;
    try {
      sql = await readFile(task3, 'utf8');
    } catch {
      throw new Error('TASK3_MIGRATION_MISSING');
    }
    validate(sql);
    expect(sql).toContain('governed_subject_tombstone');
    expect(sql).toContain('governed_subject_tombstone_audit');
    expect(sql).toContain('deletion_request');
    expect(sql).toContain('pg_advisory_xact_lock');
  });
});
