import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../../../packages/db/prisma/migrations/20260830130400_discovery_company_materialization_functions/migration.sql',
  import.meta.url,
);

const FUNCTIONS = Object.freeze({
  admit: 'admit_discovery_company_materialization_v1',
  inspect: 'inspect_discovery_company_materialization_v1',
  facts: 'lock_discovery_company_materialization_batch_facts_v1',
  append: 'append_discovery_company_materialization_batch_v1',
  finalizeQuery: 'finalize_discovery_company_materialization_query_v1',
  finalizeRun: 'finalize_discovery_company_materialization_run_v1',
});
const PUBLIC_FUNCTIONS = Object.freeze(Object.values(FUNCTIONS));
const RAW_FACT_HELPER = '_discovery_company_materialization_lock_raw_fact_v1';
const INTERNAL_EXECUTE_GRANTS = Object.freeze({
  _discovery_company_materialization_lock_raw_fact_v1:
    'discovery_materialization_function_owner',
  append_workspace_governed_child_relation_v1:
    'discovery_materialization_function_owner',
  attest_workspace_governed_child_relation_v1:
    'discovery_materialization_function_owner',
});
const STABLE_ERRORS = Object.freeze([
  'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INVALID',
  'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_CONFLICT',
  'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_UNAVAILABLE',
  'DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_INCOMPLETE_HOLD',
  'DOMAIN_ACK_DISCOVERY_COMPANY_IDENTITY_CONFLICT',
]);

function stripComments(value: string): string {
  return value
    .replace(/\/\*[^]*?\*\//gu, ' ')
    .replace(/--[^\n]*(?:\n|$)/gu, ' ');
}

function compact(value: string): string {
  return stripComments(value)
    .replaceAll('"', '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*=\s*/gu, '=')
    .replace(/\s*,\s*/gu, ',')
    .trim();
}

function functionBlock(sql: string, name: string): string {
  const start = new RegExp(`CREATE\\s+FUNCTION\\s+public\\.${name}\\s*\\(`, 'iu')
    .exec(sql)?.index;
  if (start === undefined) throw new Error(`C_TX_FUNCTION_MISSING_${name}`);
  const tail = sql.slice(start);
  const delimiter = /\bAS\s+(\$[A-Za-z0-9_]*\$)/iu.exec(tail);
  if (!delimiter?.[1] || delimiter.index === undefined) {
    throw new Error(`C_TX_FUNCTION_BODY_MISSING_${name}`);
  }
  const bodyStart = delimiter.index + delimiter[0].length;
  const bodyEnd = tail.indexOf(delimiter[1], bodyStart);
  if (bodyEnd < 0) throw new Error(`C_TX_FUNCTION_END_MISSING_${name}`);
  const terminator = tail.indexOf(';', bodyEnd + delimiter[1].length);
  if (terminator < 0) throw new Error(`C_TX_FUNCTION_TERMINATOR_MISSING_${name}`);
  return tail.slice(0, terminator + 1);
}

function executableBody(sql: string, name: string): string {
  const block = functionBlock(sql, name);
  const delimiter = /\bAS\s+(\$[A-Za-z0-9_]*\$)/iu.exec(block);
  if (!delimiter?.[1] || delimiter.index === undefined) {
    throw new Error(`C_TX_EXECUTABLE_BODY_MISSING_${name}`);
  }
  const start = delimiter.index + delimiter[0].length;
  const end = block.indexOf(delimiter[1], start);
  return stripComments(block.slice(start, end));
}

function requireText(value: string, fragment: string, code: string): void {
  if (!compact(value).toLowerCase().includes(compact(fragment).toLowerCase())) {
    throw new Error(code);
  }
}

function requireOrdered(value: string, fragments: readonly string[], code: string): void {
  const normalized = compact(value).toLowerCase();
  let cursor = -1;
  for (const fragment of fragments) {
    const next = normalized.indexOf(compact(fragment).toLowerCase(), cursor + 1);
    if (next <= cursor) throw new Error(`${code}_${fragment}`);
    cursor = next;
  }
}

function validateSecurity(sql: string, name: string): void {
  const normalized = compact(functionBlock(sql, name)).toLowerCase();
  for (const required of [
    'language plpgsql',
    'volatile',
    'security definer',
    'set search_path=pg_catalog,public',
  ]) requireText(normalized, required, `C_TX_FUNCTION_SECURITY_INVALID_${name}`);
}

function validateRawFactHelper(sql: string): void {
  validateSecurity(sql, RAW_FACT_HELPER);
  const clean = stripComments(sql);
  requireText(clean,
    `ALTER FUNCTION public.${RAW_FACT_HELPER}(UUID,UUID) OWNER TO discovery_materialization_fact_reader`,
    'C_TX_RAW_FACT_HELPER_OWNER_INVALID');
  requireText(clean,
    `REVOKE ALL ON FUNCTION public.${RAW_FACT_HELPER}(UUID,UUID) FROM PUBLIC,app_user`,
    'C_TX_RAW_FACT_HELPER_REVOKE_INVALID');
}

function validateAcl(sql: string): void {
  const clean = stripComments(sql);
  if (
    /GRANT\s+(?:ALL|ALL\s+PRIVILEGES)\b/iu.test(clean) ||
    /GRANT\s+EXECUTE\s+ON\s+ALL\s+FUNCTIONS/iu.test(clean) ||
    /ALTER\s+DEFAULT\s+PRIVILEGES/iu.test(clean)
  ) throw new Error('C_TX_FUNCTION_BROAD_ACL_FORBIDDEN');

  const grants = [...clean.matchAll(
    /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.([a-z0-9_]+)\s*\([^;]*\)\s+TO\s+([^;]+);/giu,
  )];
  const allowedGrantNames = new Set([
    ...PUBLIC_FUNCTIONS,
    ...Object.keys(INTERNAL_EXECUTE_GRANTS),
  ]);
  if (grants.some((grant) => !allowedGrantNames.has(grant[1]?.toLowerCase() ?? ''))) {
    throw new Error('C_TX_FUNCTION_BROAD_ACL_FORBIDDEN');
  }
  if (grants.length !== PUBLIC_FUNCTIONS.length + Object.keys(INTERNAL_EXECUTE_GRANTS).length) {
    throw new Error('C_TX_FUNCTION_GRANT_COUNT_INVALID');
  }
  for (const name of PUBLIC_FUNCTIONS) {
    const exact = grants.filter((grant) => grant[1]?.toLowerCase() === name);
    if (exact.length !== 1 || compact(exact[0]?.[2] ?? '').toLowerCase() !== 'app_user') {
      throw new Error(`C_TX_FUNCTION_GRANT_INVALID_${name}`);
    }
    const revoke = new RegExp(
      `REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${name}\\s*\\([^;]*\\)\\s+FROM\\s+[^;]*\\bPUBLIC\\b[^;]*;`,
      'iu',
    );
    if (!revoke.test(clean)) throw new Error(`C_TX_FUNCTION_PUBLIC_REVOKE_MISSING_${name}`);
  }
  for (const [name, role] of Object.entries(INTERNAL_EXECUTE_GRANTS)) {
    const internal = grants.filter((grant) => grant[1]?.toLowerCase() === name);
    if (internal.length !== 1 || compact(internal[0]?.[2] ?? '').toLowerCase() !== role) {
      throw new Error('C_TX_FUNCTION_BROAD_ACL_FORBIDDEN');
    }
  }
}

function validateAdmission(sql: string): void {
  const body = executableBody(sql, FUNCTIONS.admit);
  for (const required of [
    'discovery-company-materialization-run:',
    'discovery_company_materialization_activation',
    'materialization_contract_version',
    'discovery_query_receipt',
    'discovery_query_execution_outcome',
    'discovery_company_materialization_admission',
    'GOVERNED_C_TX',
    'LEGACY',
  ]) requireText(body, required, `C_TX_ADMISSION_CONTRACT_MISSING_${required}`);
  requireText(body, 'pg_advisory_xact_lock', 'C_TX_ADMISSION_RUN_LOCK_MISSING');
  requireText(body, 'INSERT INTO public.discovery_company_materialization_admission',
    'C_TX_ADMISSION_INSERT_MISSING');
}

function validateInspect(sql: string): void {
  const body = executableBody(sql, FUNCTIONS.inspect);
  if (/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CALL|EXECUTE)\b/iu.test(body)) {
    throw new Error('C_TX_INSPECT_NOT_READ_ONLY');
  }
  for (const required of [
    'discovery_company_materialization_admission',
    'discovery_company_materialization_batch_receipt',
    'discovery_company_materialization_outcome',
    'discovery_company_materialization_query_receipt',
    'discovery_company_materialization_run_receipt',
    'NOT_FOUND',
    'PARTIAL_RESUMABLE',
    'REPLAYED',
  ]) requireText(body, required, `C_TX_INSPECT_CONTRACT_MISSING_${required}`);
}

function validateBatchFacts(sql: string): void {
  const body = executableBody(sql, FUNCTIONS.facts);
  requireOrdered(body, [
    'acquisition-suppression-policy:',
    'discovery-company-materialization-run:',
    'discovery-company-materialization:',
    RAW_FACT_HELPER,
  ], 'C_TX_BATCH_LOCK_ORDER_INVALID');
  const rawHelper = executableBody(sql, RAW_FACT_HELPER);
  requireOrdered(rawHelper, [
    'raw_source_record',
    'FOR UPDATE',
  ], 'C_TX_RAW_FACT_HELPER_INVALID');
  for (const required of [
    'pg_advisory_xact_lock',
    'query_ordinal',
    'batch_ordinal',
    'ORDER BY query_ordinal, batch_ordinal',
    'LIMIT 1',
    'row_number() OVER',
    'ORDER BY provider_key, record_index, raw_record_id, id',
    '/ 128',
    'discovery_query_attempt_item',
    'discovery_company_materialization_query_receipt',
    'INSERT INTO public.discovery_company_materialization_tx_fence',
    'pg_backend_pid()',
    'pg_current_xact_id()',
    'snapshot_sha256',
    'attest_workspace_governed_child_relation_v1',
  ]) requireText(body, required, `C_TX_BATCH_FACT_CONTRACT_MISSING_${required}`);
  if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(?:canonical_company|identity_link|field_evidence)/iu.test(body)) {
    throw new Error('C_TX_BATCH_FACT_PRODUCT_DML_FORBIDDEN');
  }
}

function validateAppend(sql: string): void {
  const body = executableBody(sql, FUNCTIONS.append);
  for (const required of [
    'discovery_company_materialization_tx_fence',
    'fence_id',
    'snapshot_sha256',
    'pg_backend_pid()',
    'pg_current_xact_id()',
    'DELETE FROM public.discovery_company_materialization_tx_fence',
    'append_workspace_governed_child_relation_v1',
    'INSERT INTO public.discovery_company_materialization_outcome',
    'INSERT INTO public.discovery_company_materialization_batch_receipt',
  ]) requireText(body, required, `C_TX_APPEND_CONTRACT_MISSING_${required}`);
  if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(?:canonical_company|identity_link|field_evidence)/iu.test(body)) {
    throw new Error('C_TX_APPEND_PRODUCT_DML_FORBIDDEN');
  }
}

function validateFinalizeQuery(sql: string): void {
  const body = executableBody(sql, FUNCTIONS.finalizeQuery);
  requireOrdered(body, [
    'discovery-company-materialization-run:',
    'discovery-company-materialization:',
  ], 'C_TX_QUERY_FINALIZE_LOCK_ORDER_INVALID');
  for (const required of [
    'discovery_query_attempt_item',
    'discovery_company_materialization_outcome',
    'discovery_company_materialization_batch_receipt',
    'COUNT(',
    'SUM(',
    'INSERT INTO public.discovery_company_materialization_query_receipt',
  ]) requireText(body, required, `C_TX_QUERY_FINALIZE_RECOMPUTE_MISSING_${required}`);
}

function validateFinalizeRun(sql: string): void {
  const body = executableBody(sql, FUNCTIONS.finalizeRun);
  for (const required of [
    'discovery-company-materialization-run:',
    'discovery_query_receipt',
    'discovery_company_materialization_query_receipt',
    'query_ordinal',
    'COUNT(',
    'SUM(',
    'INSERT INTO public.discovery_company_materialization_run_receipt',
  ]) requireText(body, required, `C_TX_RUN_FINALIZE_RECOMPUTE_MISSING_${required}`);
}

function validateFence(sql: string): void {
  const clean = stripComments(sql);
  for (const required of [
    'CREATE CONSTRAINT TRIGGER discovery_company_materialization_tx_fence_guard',
    'AFTER INSERT ON public.discovery_company_materialization_tx_fence',
    'DEFERRABLE INITIALLY DEFERRED',
    'FOR EACH ROW EXECUTE FUNCTION public.reject_unconsumed_discovery_company_materialization_fence_v1()',
  ]) requireText(clean, required, `C_TX_FENCE_CONTRACT_MISSING_${required}`);
}

function validateNoBypass(sql: string): void {
  const clean = stripComments(sql);
  if (/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.(?:governed_subject|tool_operation_subject|governed_subject_relation)/iu.test(clean)) {
    throw new Error('C_TX_A_RELATION_DIRECT_DML_FORBIDDEN');
  }
  requireText(clean, 'append_workspace_governed_child_relation_v1', 'C_TX_A_APPEND_API_MISSING');
  requireText(clean, 'attest_workspace_governed_child_relation_v1', 'C_TX_A_ATTEST_API_MISSING');
}

function validateFunctionsMigration(sql: string): void {
  for (const name of PUBLIC_FUNCTIONS) validateSecurity(sql, name);
  validateRawFactHelper(sql);
  validateAcl(sql);
  validateAdmission(sql);
  validateInspect(sql);
  validateBatchFacts(sql);
  validateAppend(sql);
  validateFinalizeQuery(sql);
  validateFinalizeRun(sql);
  validateFence(sql);
  validateNoBypass(sql);
  const clean = stripComments(sql);
  for (const error of STABLE_ERRORS) {
    requireText(clean, error, `C_TX_STABLE_ERROR_MISSING_${error}`);
  }
}

function fixtureFunction(name: string, body: string): string {
  return `
    CREATE FUNCTION public.${name}(p_workspace_id uuid, p_run_id uuid)
    RETURNS TABLE(status text)
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path=pg_catalog,public AS $${name}$
    BEGIN ${body} END
    $${name}$;
    REVOKE ALL ON FUNCTION public.${name}(uuid,uuid) FROM PUBLIC, app_user,
      runtime_api, runtime_worker, runtime_outbox_relay;
    GRANT EXECUTE ON FUNCTION public.${name}(uuid,uuid) TO app_user;
  `;
}

function mutateFunction(
  sql: string,
  name: string,
  from: string,
  to: string,
): string {
  const block = functionBlock(sql, name);
  return sql.replace(block, block.replace(from, to));
}

function lockedReference(): string {
  const admit = fixtureFunction(FUNCTIONS.admit, `
    PERFORM pg_advisory_xact_lock(hashtextextended('discovery-company-materialization-run:',0));
    PERFORM 1 FROM public.discovery_company_materialization_activation;
    PERFORM materialization_contract_version FROM public.discovery_run;
    PERFORM 1 FROM public.discovery_query_receipt;
    PERFORM 1 FROM public.discovery_query_execution_outcome;
    INSERT INTO public.discovery_company_materialization_admission(mode,reason_code)
      VALUES ('GOVERNED_C_TX','LEGACY'); RETURN;`);
  const inspect = fixtureFunction(FUNCTIONS.inspect, `
    PERFORM 1 FROM public.discovery_company_materialization_admission;
    PERFORM 1 FROM public.discovery_company_materialization_batch_receipt;
    PERFORM 1 FROM public.discovery_company_materialization_outcome;
    PERFORM 1 FROM public.discovery_company_materialization_query_receipt;
    PERFORM 1 FROM public.discovery_company_materialization_run_receipt;
    RETURN QUERY SELECT 'NOT_FOUND'; RETURN QUERY SELECT 'PARTIAL_RESUMABLE';
    RETURN QUERY SELECT 'REPLAYED';`);
  const facts = fixtureFunction(FUNCTIONS.facts, `
    PERFORM pg_advisory_xact_lock(hashtextextended('acquisition-suppression-policy:',0));
    PERFORM pg_advisory_xact_lock(hashtextextended('discovery-company-materialization-run:',0));
    PERFORM pg_advisory_xact_lock(hashtextextended('discovery-company-materialization:',0));
    PERFORM 1 FROM public.discovery_company_materialization_query_receipt
      ORDER BY query_ordinal, batch_ordinal LIMIT 1;
    PERFORM ranked.id FROM (
      SELECT item.id, row_number() OVER
        (ORDER BY provider_key, record_index, raw_record_id, id) AS position
      FROM public.discovery_query_attempt_item item
    ) ranked WHERE ((ranked.position - 1) / 128)=p_run_id::text::integer;
    PERFORM 1 FROM public._discovery_company_materialization_lock_raw_fact_v1(
      p_workspace_id,p_run_id);
    PERFORM public.attest_workspace_governed_child_relation_v1();
    INSERT INTO public.discovery_company_materialization_tx_fence(
      backend_pid,transaction_id,snapshot_sha256)
      VALUES(pg_backend_pid(),pg_current_xact_id(),'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    RETURN;`);
  const append = fixtureFunction(FUNCTIONS.append, `
    PERFORM 1 FROM public.discovery_company_materialization_tx_fence
      WHERE fence_id=p_run_id AND snapshot_sha256 IS NOT NULL
        AND backend_pid=pg_backend_pid() AND transaction_id=pg_current_xact_id();
    PERFORM public.append_workspace_governed_child_relation_v1();
    INSERT INTO public.discovery_company_materialization_outcome DEFAULT VALUES;
    INSERT INTO public.discovery_company_materialization_batch_receipt DEFAULT VALUES;
    DELETE FROM public.discovery_company_materialization_tx_fence WHERE fence_id=p_run_id;
    RETURN;`);
  const query = fixtureFunction(FUNCTIONS.finalizeQuery, `
    PERFORM pg_advisory_xact_lock(hashtextextended('discovery-company-materialization-run:',0));
    PERFORM pg_advisory_xact_lock(hashtextextended('discovery-company-materialization:',0));
    PERFORM count(*),sum(o.record_index) FROM public.discovery_query_attempt_item i
      JOIN public.discovery_company_materialization_outcome o ON true
      JOIN public.discovery_company_materialization_batch_receipt b ON true;
    INSERT INTO public.discovery_company_materialization_query_receipt DEFAULT VALUES;
    RETURN;`);
  const run = fixtureFunction(FUNCTIONS.finalizeRun, `
    PERFORM pg_advisory_xact_lock(hashtextextended('discovery-company-materialization-run:',0));
    PERFORM count(*),sum(c.item_count),jsonb_agg(c.query_key ORDER BY q.query_ordinal)
      FROM public.discovery_query_receipt q
      JOIN public.discovery_company_materialization_query_receipt c ON true;
    INSERT INTO public.discovery_company_materialization_run_receipt DEFAULT VALUES;
    RETURN;`);
  const errors = STABLE_ERRORS.map((error) => `RAISE NOTICE '${error}';`).join('\n');
  return `
    CREATE FUNCTION public._discovery_company_materialization_lock_raw_fact_v1(uuid,uuid)
      RETURNS TABLE(raw_status text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER
      SET search_path=pg_catalog,public AS $raw$ BEGIN
        RETURN QUERY SELECT raw.ingest_status::text
          FROM public.raw_source_record raw FOR UPDATE;
      END $raw$;
    REVOKE ALL ON FUNCTION public._discovery_company_materialization_lock_raw_fact_v1(uuid,uuid)
      FROM PUBLIC,app_user,runtime_api,runtime_worker,runtime_outbox_relay;
    ALTER FUNCTION public._discovery_company_materialization_lock_raw_fact_v1(uuid,uuid)
      OWNER TO discovery_materialization_fact_reader;
    GRANT EXECUTE ON FUNCTION public._discovery_company_materialization_lock_raw_fact_v1(uuid,uuid)
      TO discovery_materialization_function_owner;
    GRANT EXECUTE ON FUNCTION public.append_workspace_governed_child_relation_v1(uuid)
      TO discovery_materialization_function_owner;
    GRANT EXECUTE ON FUNCTION public.attest_workspace_governed_child_relation_v1(uuid)
      TO discovery_materialization_function_owner;
    ${admit}${inspect}${facts}${append}${query}${run}
    CREATE FUNCTION public.reject_unconsumed_discovery_company_materialization_fence_v1()
      RETURNS trigger LANGUAGE plpgsql AS $guard$ BEGIN ${errors} RETURN NEW; END $guard$;
    CREATE CONSTRAINT TRIGGER discovery_company_materialization_tx_fence_guard
      AFTER INSERT ON public.discovery_company_materialization_tx_fence
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION
        public.reject_unconsumed_discovery_company_materialization_fence_v1();
  `;
}

async function migration(): Promise<string> {
  try {
    return await readFile(migrationUrl, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('DISCOVERY_COMPANY_MATERIALIZATION_FUNCTIONS_MIGRATION_MISSING', {
        cause: error,
      });
    }
    throw error;
  }
}

describe('Discovery company materialization C3 SECURITY DEFINER functions migration', () => {
  it('mutation-proves security, fence, ordering, recomputation, ACL and A-boundary checks', () => {
    const valid = lockedReference();
    expect(() => validateFunctionsMigration(valid)).not.toThrow();

    const mutations = [
      ['security-definer', mutateFunction(valid, FUNCTIONS.admit,
        'SECURITY DEFINER', 'SECURITY INVOKER')],
      ['raw-helper-security-definer', mutateFunction(valid, RAW_FACT_HELPER,
        'SECURITY DEFINER', 'SECURITY INVOKER')],
      ['search-path', mutateFunction(valid, FUNCTIONS.admit,
        'SET search_path=pg_catalog,public', '')],
      ['lock-order', valid.replace('acquisition-suppression-policy:', 'zz-after-query-lock:')],
      ['batch-size', valid.replace('/ 128', '/ 129')],
      ['fence-consume', valid.replace('DELETE FROM public.discovery_company_materialization_tx_fence',
        'PERFORM 1 FROM public.discovery_company_materialization_tx_fence')],
      ['a-append', valid.replace('append_workspace_governed_child_relation_v1',
        'missing_workspace_governed_child_relation_v1')],
      ['query-sum', valid.replace('sum(o.record_index)', 'max(o.record_index)')],
      ['run-sum', valid.replace('sum(c.item_count)', 'max(c.item_count)')],
      ['public-revoke', valid.replace(`REVOKE ALL ON FUNCTION public.${FUNCTIONS.admit}`,
        `REVOKE ALL ON FUNCTION public.${FUNCTIONS.admit}_missing`)],
      ['public-grant', valid.replace(`GRANT EXECUTE ON FUNCTION public.${FUNCTIONS.inspect}`,
        `GRANT EXECUTE ON FUNCTION public.${FUNCTIONS.inspect}x`)],
      ['inspect-write', valid.replace('RETURN QUERY SELECT \'NOT_FOUND\';',
        'UPDATE public.discovery_company_materialization_outcome SET outcome=outcome;')],
      ['stable-error', valid.replace('DOMAIN_ACK_DISCOVERY_COMPANY_MATERIALIZATION_CONFLICT',
        'C_TX_CONFLICT_ERROR_REMOVED')],
    ];
    for (const [label, mutation] of mutations) {
      expect(() => validateFunctionsMigration(mutation), label).toThrow();
    }

    expect(() => validateFunctionsMigration(`${valid}
      INSERT INTO public.governed_subject_relation DEFAULT VALUES;`))
      .toThrow('C_TX_A_RELATION_DIRECT_DML_FORBIDDEN');
    expect(() => validateFunctionsMigration(`${valid}
      GRANT EXECUTE ON FUNCTION public._internal_helper() TO app_user;`))
      .toThrow('C_TX_FUNCTION_BROAD_ACL_FORBIDDEN');
  });

  it('requires the additive C3 functions migration', async () => {
    validateFunctionsMigration(await migration());
  });
});
