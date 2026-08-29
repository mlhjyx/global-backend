import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../../../packages/db/prisma/migrations/20260830121000_governed_subject_relation_append_attest/migration.sql',
  import.meta.url,
);

const APPEND = 'append_workspace_governed_child_relation_v1';
const ATTEST = 'attest_workspace_governed_child_relation_v1';
const PARAMETERS = [
  'p_workspace_id UUID',
  'p_authority_id UUID',
  'p_account_id UUID',
  'p_operation_id UUID',
  'p_operation_generation INTEGER',
  'p_ack_id CHAR(64)',
  'p_result_digest CHAR(64)',
  'p_root_subject_type VARCHAR(191)',
  'p_root_subject_id UUID',
  'p_root_data_class VARCHAR(16)',
  'p_root_dsr_subject_type VARCHAR(191)',
  'p_root_dsr_subject_id UUID',
  'p_parent_governed_subject_id UUID',
  'p_child_subject_type VARCHAR(191)',
  'p_child_subject_id UUID',
  'p_child_data_class VARCHAR(16)',
  'p_child_dsr_subject_type VARCHAR(191)',
  'p_child_dsr_subject_id UUID',
  'p_relation_key VARCHAR(200)',
  'p_relation_kind VARCHAR(32)',
  'p_source_ref_namespace VARCHAR(64)',
  'p_source_ref_uuid UUID',
  'p_source_ref_sha256 CHAR(64)',
  'p_contract_sha256 CHAR(64)',
] as const;
const RETURNS = [
  'operation_subject_id UUID',
  'parent_subject_id UUID',
  'child_subject_id UUID',
  'relation_id UUID',
  'replay BOOLEAN',
] as const;
const PARAMETER_TYPES = PARAMETERS.map((parameter) => parameter.split(' ').slice(1).join(' '));

function compact(value: string): string {
  return value.replaceAll('"', '').replace(/\s+/g, ' ').trim().toUpperCase();
}

function functionBlock(sql: string, name: string): string {
  const match = new RegExp(
    `CREATE FUNCTION public\\.${name}\\(([^]*?)\\)\\s*RETURNS TABLE\\(([^]*?)\\)([^]*?)\\$function\\$;`,
    'iu',
  ).exec(sql);
  if (!match) throw new Error(`MISSING_FUNCTION_${name}`);
  return match[0];
}

function signatureParts(sql: string, name: string): {
  parameters: string[];
  returns: string[];
  block: string;
} {
  const block = functionBlock(sql, name);
  const match = new RegExp(
    `CREATE FUNCTION public\\.${name}\\(([^]*?)\\)\\s*RETURNS TABLE\\(([^]*?)\\)`,
    'iu',
  ).exec(block);
  if (!match) throw new Error(`MISSING_SIGNATURE_${name}`);
  const split = (value: string) => value.split(',').map(compact);
  return { parameters: split(match[1] ?? ''), returns: split(match[2] ?? ''), block };
}

function validateFunction(sql: string, name: string, readOnly: boolean): void {
  const parsed = signatureParts(sql, name);
  if (JSON.stringify(parsed.parameters) !== JSON.stringify(PARAMETERS.map(compact))) {
    throw new Error(`INVALID_PARAMETER_ORDER_${name}`);
  }
  if (JSON.stringify(parsed.returns) !== JSON.stringify(RETURNS.map(compact))) {
    throw new Error(`INVALID_RETURN_ORDER_${name}`);
  }
  const normalized = compact(parsed.block);
  for (const required of [
    'LANGUAGE PLPGSQL',
    'VOLATILE',
    'SECURITY DEFINER',
    'SET SEARCH_PATH = PG_CATALOG, PUBLIC',
    'PG_ADVISORY_XACT_LOCK',
  ]) {
    if (!normalized.includes(required)) throw new Error(`INVALID_FUNCTION_SECURITY_${name}`);
  }
  if (
    readOnly &&
    /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|NEXTVAL|SETVAL)\b/iu.test(parsed.block)
  ) {
    throw new Error(`ATTEST_NOT_READ_ONLY_${name}`);
  }
}

function fixtureFunction(name: string, body: string, volatility = 'VOLATILE'): string {
  return `
    CREATE FUNCTION public.${name}(
      ${PARAMETERS.join(',\n      ')}
    ) RETURNS TABLE(
      ${RETURNS.join(',\n      ')}
    )
    LANGUAGE plpgsql
    ${volatility}
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      PERFORM pg_advisory_xact_lock(1);
      ${body}
    END
    $function$;
  `;
}

async function migration(): Promise<string> {
  return readFile(migrationUrl, 'utf8');
}

describe('governed relation append and attest migration contract', () => {
  it('defines the exact two public signatures, parameter order and return order', async () => {
    const sql = await migration();
    validateFunction(sql, APPEND, false);
    validateFunction(sql, ATTEST, true);
    const publicFunctions = [...sql.matchAll(/CREATE FUNCTION public\.([a-z0-9_]+)\s*\(/giu)]
      .map((match) => match[1])
      .filter((name) => !name?.startsWith('_'));
    expect(publicFunctions).toEqual([APPEND, ATTEST]);
  });

  it('keeps attest persistently read-only while both functions use fixed security and volatility', async () => {
    const sql = await migration();
    validateFunction(sql, APPEND, false);
    validateFunction(sql, ATTEST, true);
    expect(functionBlock(sql, ATTEST)).not.toMatch(/apply_execution_domain_ack_v1/iu);
  });

  it('exposes function-only app ACL and no Task 3 tombstone function', async () => {
    const sql = await migration();
    const types = PARAMETER_TYPES.join(', ');
    for (const name of [APPEND, ATTEST]) {
      expect(compact(sql)).toContain(compact(
        `REVOKE ALL ON FUNCTION public.${name}(${types}) FROM PUBLIC, app_user, execution_budget_platform_writer, runtime_api, runtime_worker, runtime_outbox_relay`,
      ));
      expect(compact(sql)).toContain(compact(
        `GRANT EXECUTE ON FUNCTION public.${name}(${types}) TO app_user`,
      ));
    }
    expect(sql).not.toContain('tombstone_workspace_governed_subject_v1');
  });

  it('remains product-neutral and does not own Program B or Program C semantics', async () => {
    const sql = (await migration()).toLowerCase();
    for (const forbidden of [
      'discovery', 'raw_source_record', 'identity_link', 'canonical_company',
      'canonical_contact', 'provider_key', 'producer_id', 'opportunity',
    ]) expect(sql).not.toContain(forbidden);
  });

  it('mutation-kills reordered parameters, weak security, STABLE attest and attest DML', () => {
    const valid = fixtureFunction(APPEND, 'RETURN;') + fixtureFunction(ATTEST, 'RETURN;');
    expect(() => validateFunction(valid, APPEND, false)).not.toThrow();
    expect(() => validateFunction(valid, ATTEST, true)).not.toThrow();

    const reordered = valid.replace(
      'p_workspace_id UUID,\n      p_authority_id UUID',
      'p_authority_id UUID,\n      p_workspace_id UUID',
    );
    expect(() => validateFunction(reordered, APPEND, false))
      .toThrow(`INVALID_PARAMETER_ORDER_${APPEND}`);

    const stable = fixtureFunction(ATTEST, 'RETURN;', 'STABLE');
    expect(() => validateFunction(stable, ATTEST, true))
      .toThrow(`INVALID_FUNCTION_SECURITY_${ATTEST}`);

    const writing = fixtureFunction(ATTEST, 'UPDATE public.governed_subject SET id=id;');
    expect(() => validateFunction(writing, ATTEST, true))
      .toThrow(`ATTEST_NOT_READ_ONLY_${ATTEST}`);

    const weak = fixtureFunction(APPEND, 'RETURN;')
      .replace('SECURITY DEFINER', 'SECURITY INVOKER')
      .replace('SET search_path = pg_catalog, public', '');
    expect(() => validateFunction(weak, APPEND, false))
      .toThrow(`INVALID_FUNCTION_SECURITY_${APPEND}`);
  });
});
