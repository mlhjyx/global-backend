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
  const start = new RegExp(`CREATE FUNCTION public\\.${name}\\(`, 'iu').exec(sql)?.index;
  if (start === undefined) throw new Error(`MISSING_FUNCTION_${name}`);
  const tail = sql.slice(start);
  const delimiter = /\bAS\s+(\$[A-Za-z0-9_]*\$)/iu.exec(tail);
  if (!delimiter?.[1] || delimiter.index === undefined) {
    throw new Error(`MISSING_FUNCTION_BODY_${name}`);
  }
  const bodyStart = delimiter.index + delimiter[0].length;
  const bodyEnd = tail.indexOf(delimiter[1], bodyStart);
  if (bodyEnd < 0) throw new Error(`MISSING_FUNCTION_END_${name}`);
  const semicolon = tail.indexOf(';', bodyEnd + delimiter[1].length);
  if (semicolon < 0) throw new Error(`MISSING_FUNCTION_TERMINATOR_${name}`);
  return tail.slice(0, semicolon + 1);
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

const READ_ONLY_FORBIDDEN = /\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CALL|EXECUTE|NEXTVAL|CURRVAL|SETVAL|LOCK\s+TABLE|FOR\s+(?:NO\s+KEY\s+)?UPDATE|FOR\s+SHARE)\b/iu;
const READ_ONLY_CALL_ALLOWLIST = new Set([
  'array_length', 'cardinality', 'char_length', 'coalesce', 'count',
  'current_workspace_id', 'greatest', 'hashtextextended', 'least', 'lower',
  'nullif', 'pg_advisory_xact_lock', 'current_setting',
]);

function stripSqlNoise(value: string): string {
  return value
    .replace(/\/\*[^]*?\*\//gu, ' ')
    .replace(/--[^\n]*(?:\n|$)/gu, ' ')
    .replace(/(?:E|U&)?'(?:''|[^'])*'/giu, "''");
}

function executableBody(block: string): string {
  const delimiter = /\bAS\s+(\$[A-Za-z0-9_]*\$)/iu.exec(block);
  if (!delimiter?.[1] || delimiter.index === undefined) throw new Error('MISSING_EXECUTABLE_BODY');
  const start = delimiter.index + delimiter[0].length;
  const end = block.indexOf(delimiter[1], start);
  if (end < 0) throw new Error('MISSING_EXECUTABLE_BODY_END');
  return stripSqlNoise(block.slice(start, end));
}

function validateReadOnlyBlock(
  sql: string,
  name: string,
  block: string,
  visited: ReadonlySet<string> = new Set(),
): void {
  const executable = executableBody(block);
  if (READ_ONLY_FORBIDDEN.test(executable)) throw new Error(`ATTEST_NOT_READ_ONLY_${name}`);
  const nextVisited = new Set(visited).add(name);
  const calls = [...executable.matchAll(/(?:(public|pg_catalog)\.)?([a-z_][a-z0-9_]*)\s*\(/giu)];
  for (const call of calls) {
    const schema = call[1]?.toLowerCase() ?? null;
    const called = call[2]?.toLowerCase();
    if (!called) continue;
    if (called === APPEND) throw new Error(`ATTEST_CALLS_APPEND_${name}`);
    if (called.startsWith('_')) {
      if (schema !== null && schema !== 'public') throw new Error(`ATTEST_HELPER_SCHEMA_${name}`);
      if (nextVisited.has(called)) throw new Error(`ATTEST_HELPER_CYCLE_${name}`);
      validateReadOnlyBlock(sql, name, functionBlock(sql, called), nextVisited);
      continue;
    }
    if (!READ_ONLY_CALL_ALLOWLIST.has(called)) {
      throw new Error(`ATTEST_CALL_NOT_ALLOWLISTED_${name}`);
    }
  }
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
  if (readOnly) validateReadOnlyBlock(sql, name, parsed.block);
}

function fixtureFunction(
  name: string,
  body: string,
  volatility = 'VOLATILE',
  delimiter = '$governed_relation$',
): string {
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
    AS ${delimiter}
    BEGIN
      PERFORM pg_advisory_xact_lock(1);
      ${body}
    END
    ${delimiter};
  `;
}

function fixtureAcl(name: string): string {
  const types = PARAMETER_TYPES.join(', ');
  return `
    REVOKE ALL ON FUNCTION public.${name}(${types}) FROM
      PUBLIC, app_user, execution_budget_platform_writer,
      runtime_api, runtime_worker, runtime_outbox_relay;
    GRANT EXECUTE ON FUNCTION public.${name}(${types}) TO app_user;
  `;
}

function validateAcl(sql: string): void {
  const normalized = compact(sql);
  const types = compact(PARAMETER_TYPES.join(', '));
  if (
    /\bGRANT\s+(?:ALL|ALL\s+PRIVILEGES)\b/iu.test(sql) ||
    /\bON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA\b/iu.test(sql) ||
    /\bALTER\s+DEFAULT\s+PRIVILEGES\b/iu.test(sql)
  ) throw new Error('BROAD_FUNCTION_GRANT_FORBIDDEN');
  if (/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\._/iu.test(sql)) {
    throw new Error('INTERNAL_HELPER_EXECUTE_EXPOSED');
  }
  const actualGrants = [...sql.matchAll(/\bGRANT\b[^;]*;/giu)].map((match) => compact(match[0]));
  const expectedGrants = [APPEND, ATTEST].map((name) => compact(
    `GRANT EXECUTE ON FUNCTION public.${name}(${PARAMETER_TYPES.join(', ')}) TO app_user;`,
  ));
  if (
    actualGrants.length !== expectedGrants.length ||
    expectedGrants.some((grant) => !actualGrants.includes(grant))
  ) throw new Error('UNEXPECTED_FUNCTION_GRANT');
  for (const name of [APPEND, ATTEST]) {
    const grants = [...sql.matchAll(new RegExp(
      `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+public\\.${name}\\(([^;]*)\\)\\s+TO\\s+([^;]+);`,
      'giu',
    ))];
    if (
      grants.length !== 1 || compact(grants[0]?.[1] ?? '') !== types ||
      compact(grants[0]?.[2] ?? '') !== 'APP_USER'
    ) throw new Error(`INVALID_FUNCTION_GRANT_${name}`);
    const revoke = compact(
      `REVOKE ALL ON FUNCTION public.${name}(${PARAMETER_TYPES.join(', ')}) FROM PUBLIC, app_user, execution_budget_platform_writer, runtime_api, runtime_worker, runtime_outbox_relay`,
    );
    if (!normalized.includes(revoke)) throw new Error(`INVALID_FUNCTION_REVOKE_${name}`);
  }
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

  it('locks caller role, fixed operation facts and bounded dense-DAG reachability', async () => {
    const sql = await migration();
    const caller = functionBlock(sql, '_governed_relation_assert_caller_v1');
    expect(caller).toMatch(/current_setting\s*\(\s*'role'\s*,\s*true\s*\)\s+IS\s+DISTINCT\s+FROM\s+'none'/iu);
    const operation = functionBlock(sql, '_governed_relation_lock_operation_v1');
    const facts = [
      'tool_budget_operation', 'tool_budget_account',
      'execution_budget_authority', 'execution_domain_ack',
    ];
    let cursor = -1;
    for (const fact of facts) {
      const index = operation.indexOf(fact, cursor + 1);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
    expect(operation.match(/FOR\s+SHARE/giu)).toHaveLength(4);
    expect(operation).toMatch(/revoked_at\s+IS\s+NOT\s+NULL[^]*?GOVERNED_SUBJECT_AUTHORITY_REVOKED/iu);
    expect(operation).toMatch(/consumed_at\s+IS\s+NULL[^]*?GOVERNED_OPERATION_SUBJECT_INVALID/iu);
    const append = functionBlock(sql, APPEND);
    expect(append).toMatch(/WITH\s+RECURSIVE\s+reachable[^]*?\bUNION\b(?!\s+ALL)[^]*?depth\s*<\s*65/iu);
  });

  it('exposes function-only app ACL and no Task 3 tombstone function', async () => {
    const sql = await migration();
    expect(() => validateAcl(sql)).not.toThrow();
    expect(sql).not.toContain('tombstone_workspace_governed_subject_v1');
  });

  it('remains product-neutral and does not own Program B or Program C semantics', async () => {
    const sql = (await migration()).toLowerCase();
    for (const forbidden of [
      'discovery', 'raw_source_record', 'identity_link', 'canonical_company',
      'canonical_contact', 'provider_key', 'producer_id', 'opportunity',
    ]) expect(sql).not.toContain(forbidden);
  });

  it('mutation-kills reordered parameters, arbitrary quote regressions and every attest write path', () => {
    const valid = fixtureFunction(APPEND, 'RETURN;', 'VOLATILE', '$append_v2$') +
      fixtureFunction(ATTEST, 'RETURN;', 'VOLATILE', '$ATTEST_9$');
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

    for (const body of [
      'CALL public.some_procedure();',
      "EXECUTE 'SELECT 1';",
      'PERFORM 1 FROM public.governed_subject FOR UPDATE;',
      'PERFORM 1 FROM public.governed_subject FOR SHARE;',
      'LOCK TABLE public.governed_subject;',
      "PERFORM nextval('forbidden_sequence');",
      "PERFORM currval('forbidden_sequence');",
      "PERFORM setval('forbidden_sequence',1);",
    ]) {
      expect(() => validateFunction(fixtureFunction(ATTEST, body), ATTEST, true))
        .toThrow(`ATTEST_NOT_READ_ONLY_${ATTEST}`);
    }

    const helper = `
      CREATE FUNCTION public._writing_helper() RETURNS void
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER
      SET search_path=pg_catalog,public AS $helper_1$
      BEGIN UPDATE public.governed_subject SET id=id; END $helper_1$;
    `;
    const helperCall = helper + fixtureFunction(ATTEST, 'PERFORM public._writing_helper();');
    expect(() => validateFunction(helperCall, ATTEST, true))
      .toThrow(`ATTEST_NOT_READ_ONLY_${ATTEST}`);
    const unqualifiedHelper = helper + fixtureFunction(ATTEST, 'PERFORM _writing_helper();');
    expect(() => validateFunction(unqualifiedHelper, ATTEST, true))
      .toThrow(`ATTEST_NOT_READ_ONLY_${ATTEST}`);
    const appendCall = fixtureFunction(
      ATTEST,
      `PERFORM public.${APPEND}();`,
    );
    expect(() => validateFunction(appendCall, ATTEST, true))
      .toThrow(`ATTEST_CALLS_APPEND_${ATTEST}`);
    for (const body of ['PERFORM public.unknown_project_call();', 'PERFORM unknown_project_call();']) {
      expect(() => validateFunction(fixtureFunction(ATTEST, body), ATTEST, true))
        .toThrow(`ATTEST_CALL_NOT_ALLOWLISTED_${ATTEST}`);
    }

    const harmlessText = fixtureFunction(ATTEST, `
      -- UPDATE public.governed_subject SET id=id;
      RAISE NOTICE 'CALL public.${APPEND}(); DELETE FROM secret';
      RETURN;
    `);
    expect(() => validateFunction(harmlessText, ATTEST, true)).not.toThrow();

    const weak = fixtureFunction(APPEND, 'RETURN;')
      .replace('SECURITY DEFINER', 'SECURITY INVOKER')
      .replace('SET search_path = pg_catalog, public', '');
    expect(() => validateFunction(weak, APPEND, false))
      .toThrow(`INVALID_FUNCTION_SECURITY_${APPEND}`);
  });

  it('mutation-kills later public grants and every helper execute grant', () => {
    const valid = fixtureFunction(APPEND, 'RETURN;') + fixtureFunction(ATTEST, 'RETURN;') +
      fixtureAcl(APPEND) + fixtureAcl(ATTEST);
    expect(() => validateAcl(valid)).not.toThrow();
    expect(() => validateAcl(`${valid}\n${fixtureAcl(APPEND)}`))
      .toThrow('UNEXPECTED_FUNCTION_GRANT');
    expect(() => validateAcl(`${valid}\nGRANT EXECUTE ON FUNCTION public.${ATTEST}(${PARAMETER_TYPES.join(', ')}) TO runtime_worker;`))
      .toThrow('UNEXPECTED_FUNCTION_GRANT');
    expect(() => validateAcl(`${valid}\nGRANT EXECUTE ON FUNCTION public._read_helper() TO app_user;`))
      .toThrow('INTERNAL_HELPER_EXECUTE_EXPOSED');
    expect(() => validateAcl(`${valid}\nGRANT ALL PRIVILEGES ON FUNCTION public.${ATTEST}(${PARAMETER_TYPES.join(', ')}) TO app_user;`))
      .toThrow('BROAD_FUNCTION_GRANT_FORBIDDEN');
    expect(() => validateAcl(`${valid}\nGRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user;`))
      .toThrow('BROAD_FUNCTION_GRANT_FORBIDDEN');
  });
});
