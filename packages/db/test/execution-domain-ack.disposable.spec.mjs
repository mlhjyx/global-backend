import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';

const CONTAINER = process.env.TASK4_PG_CONTAINER;
const DATABASE = process.env.TASK4_PG_DATABASE ?? 'global_test';
const WORKSPACE_A = '10000000-0000-4000-8000-000000000001';
const WORKSPACE_B = '10000000-0000-4000-8000-000000000002';
const AUTHORITY_A = '20000000-0000-4000-8000-000000000001';
const AUTHORITY_PLATFORM = '20000000-0000-4000-8000-000000000002';
const ACCOUNT_A = '30000000-0000-4000-8000-000000000001';
const ACCOUNT_PLATFORM = '30000000-0000-4000-8000-000000000002';
const OP_APPLY = '40000000-0000-4000-8000-000000000001';
const OP_ROLLBACK = '40000000-0000-4000-8000-000000000002';
const OP_CONCURRENT = '40000000-0000-4000-8000-000000000003';
const OP_UNSETTLED = '40000000-0000-4000-8000-000000000004';
const OP_ARTIFACT = '40000000-0000-4000-8000-000000000005';
const OP_PLATFORM = '40000000-0000-4000-8000-000000000006';
const ARTIFACT_ID = '50000000-0000-4000-8000-000000000001';
const DOMAIN_KEY = 'a'.repeat(64);
const DOMAIN_REVISION = 'b'.repeat(64);
const PLATFORM_LOGIN = 'task4_platform_writer';
const UNTRUSTED_LOGIN = 'task4_untrusted';

function requireContainer() {
  assert.match(CONTAINER ?? '', /^codex-task4-pg-[a-z0-9-]+$/);
  return CONTAINER;
}

function dockerArgs() {
  return [
    'exec', '-i', requireContainer(),
    'psql', '-U', 'postgres', '-d', DATABASE,
    '--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  ];
}

function psql(sql, options = {}) {
  const result = spawnSync('docker', dockerArgs(), {
    encoding: 'utf8',
    input: sql,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (options.rejects) {
    assert.notEqual(result.status, 0, `SQL unexpectedly passed:\n${result.stdout}`);
    assert.match(`${result.stderr}\n${result.stdout}`, options.rejects);
    return '';
  }
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

function psqlAsync(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', dockerArgs(), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${stderr}\n${stdout}`));
    });
    child.stdin.end(sql);
  });
}

function asApp(sql, workspace = WORKSPACE_A) {
  return `
    SET SESSION AUTHORIZATION app_user;
    BEGIN;
    SELECT set_config('app.current_workspace_id', '${workspace}', true);
    ${sql}
    COMMIT;
  `;
}

function applySql(operationId, options = {}) {
  const scopeKey = options.scopeKey ?? WORKSPACE_A;
  const consumer = options.consumer ?? 'Task4Consumer';
  const aggregateType = options.aggregateType ?? 'Task4Aggregate';
  const domainKey = options.domainKey ?? DOMAIN_KEY;
  const revision = options.revision ?? DOMAIN_REVISION;
  return `SELECT jsonb_build_object('status',status,'ack',ack_json)::text
    FROM apply_execution_domain_ack_v1(
      '${scopeKey}', '${operationId}'::uuid, '${consumer}',
      '${aggregateType}', '${domainKey}', '${revision}'
    );`;
}

const SEED_SQL = `
  DROP ROLE IF EXISTS ${UNTRUSTED_LOGIN};
  DROP ROLE IF EXISTS ${PLATFORM_LOGIN};
  CREATE ROLE ${UNTRUSTED_LOGIN}
    LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  CREATE ROLE ${PLATFORM_LOGIN}
    LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  GRANT execution_budget_platform_writer TO ${PLATFORM_LOGIN};

  INSERT INTO workspace(id,name,created_at,updated_at) VALUES
    ('${WORKSPACE_A}'::uuid,'Task4 A',now(),now()),
    ('${WORKSPACE_B}'::uuid,'Task4 B',now(),now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO execution_budget_authority(
    id,scope_key,authority_kind,workspace_id,issuer,audience,jti,token_sha256,
    schema_version,purpose,subject_type,subject_id,request_sha256,schedule_id,
    currency,unit,cap_microusd,cap_per_run_microusd,campaign_cap_microusd,
    max_runs,runs_consumed,issued_at,not_before,expires_at,consumed_at
  ) VALUES (
    '${AUTHORITY_A}'::uuid,'${WORKSPACE_A}','WORKSPACE_GRANT','${WORKSPACE_A}'::uuid,
    'https://task4.test','global-backend:execution-budget',
    '21000000-0000-4000-8000-000000000001'::uuid,'1' || repeat('0',63),
    'execution-budget-grant/v1','icp.design','company','company:task4',repeat('2',64),NULL,
    'USD','microusd',100000,NULL,NULL,NULL,1,
    statement_timestamp()-interval '30 seconds',statement_timestamp()-interval '20 seconds',
    statement_timestamp()+interval '4 minutes',statement_timestamp()
  ), (
    '${AUTHORITY_PLATFORM}'::uuid,'platform','PLATFORM_GRANT',NULL,
    'https://task4.test','global-backend:execution-budget',
    '21000000-0000-4000-8000-000000000002'::uuid,'3' || repeat('0',63),
    'execution-budget-grant/v1','platform.acquisition','schedule','task4-schedule',NULL,'task4-schedule',
    'USD','microusd',NULL,100000,1000000,10,1,
    statement_timestamp()-interval '30 seconds',statement_timestamp()-interval '20 seconds',
    statement_timestamp()+interval '4 minutes',statement_timestamp()
  );

  INSERT INTO tool_budget_account(
    id,scope_key,account_key,generation,cap_cents,reserved_cents,charged_cents,
    exhausted,ref_count,authority_id,authorized_cap_microusd,
    reserved_microusd,charged_microusd
  ) VALUES
    ('${ACCOUNT_A}'::uuid,'${WORKSPACE_A}','task4-account',1,0,0,0,false,1,
      '${AUTHORITY_A}'::uuid,100000,0,0),
    ('${ACCOUNT_PLATFORM}'::uuid,'platform','task4-platform-account',1,0,0,0,false,1,
      '${AUTHORITY_PLATFORM}'::uuid,100000,0,0);

  DO $seed$
  DECLARE
    base_projection jsonb;
    projection jsonb;
    projection_digest text;
    typed_usage jsonb := '{
      "currency":"USD","unit":"microusd","callCount":1,
      "inputTokens":7,"outputTokens":3,
      "chargedMicrousd":"10000","upperBoundMicrousd":"20000"
    }'::jsonb;
    artifact_usage jsonb := '{
      "currency":"USD","unit":"microusd","callCount":1,
      "upperBoundMicrousd":"20000"
    }'::jsonb;
  BEGIN
    base_projection := jsonb_build_object(
      'schemaVersion','generic-operation-projection/v1',
      'kind','model','schema','taxonomy-code/v1',
      'data',jsonb_build_object('data',jsonb_build_object('code','CPV-123'))
    );
    projection_digest := generic_operation_projection_digest(base_projection);
    projection := base_projection || jsonb_build_object('digest',projection_digest);

    INSERT INTO tool_budget_operation(
      id,scope_key,account_id,generation,operation_key,reserved_cents,
      observed_cents,charged_cents,result_schema_version,result_schema,
      result_digest,result_json,status,settled_at,amount_unit,
      receipt_usage,receipt_cost_basis
    )
    SELECT operation_id,scope_key,account_id,1,operation_key,2,1,1,
      'generic-operation-projection/v1','taxonomy-code/v1',projection_digest,
      projection,'SETTLED',clock_timestamp(),'cent',typed_usage,'token_pricing'
    FROM (VALUES
      ('${OP_APPLY}'::uuid,'${WORKSPACE_A}'::text,'${ACCOUNT_A}'::uuid,'apply'),
      ('${OP_ROLLBACK}'::uuid,'${WORKSPACE_A}'::text,'${ACCOUNT_A}'::uuid,'rollback'),
      ('${OP_CONCURRENT}'::uuid,'${WORKSPACE_A}'::text,'${ACCOUNT_A}'::uuid,'concurrent'),
      ('${OP_PLATFORM}'::uuid,'platform'::text,'${ACCOUNT_PLATFORM}'::uuid,'platform')
    ) input(operation_id,scope_key,account_id,operation_key);

    INSERT INTO tool_budget_operation(
      id,scope_key,account_id,generation,operation_key,reserved_cents,
      status,amount_unit
    ) VALUES (
      '${OP_UNSETTLED}'::uuid,'${WORKSPACE_A}','${ACCOUNT_A}'::uuid,1,
      'unsettled',2,'RESERVED','cent'
    );

    INSERT INTO tool_budget_operation(
      id,scope_key,account_id,generation,operation_key,reserved_cents,
      observed_cents,charged_cents,result_schema_version,result_schema,
      result_digest,result_json,status,settled_at,amount_unit,
      receipt_usage,receipt_cost_basis
    ) VALUES (
      '${OP_ARTIFACT}'::uuid,'${WORKSPACE_A}','${ACCOUNT_A}'::uuid,1,'artifact',2,1,1,
      'generic-operation-artifact-ref/v1','http-get/v1',repeat('c',64),
      jsonb_build_object(
        'schemaVersion','generic-operation-artifact-ref/v1',
        'artifactId','${ARTIFACT_ID}','operationId','${OP_ARTIFACT}',
        'resultSchema','http-get/v1','sha256',repeat('c',64),
        'sizeBytes','123','mediaType','text/plain',
        'expiresAt','2026-08-24T00:00:00.000Z'
      ),'SETTLED',clock_timestamp(),'cent',artifact_usage,'estimated_upper_bound'
    );
  END
  $seed$;

  CREATE TABLE task4_domain_mutation(
    operation_id uuid PRIMARY KEY,
    value text NOT NULL
  );
  REVOKE ALL ON task4_domain_mutation FROM PUBLIC;
  GRANT SELECT,INSERT ON task4_domain_mutation TO app_user;
`;

describe('Task 4 disposable PostgreSQL Domain ACK trust path', () => {
  before(() => {
    requireContainer();
    psql(SEED_SQL);
  });

  after(() => {
    psql(`
      DROP TABLE IF EXISTS task4_domain_mutation;
      DROP ROLE IF EXISTS ${UNTRUSTED_LOGIN};
      REVOKE execution_budget_platform_writer FROM ${PLATFORM_LOGIN};
      DROP ROLE IF EXISTS ${PLATFORM_LOGIN};
    `);
  });

  it('has exact table/function ACLs and no PUBLIC SECURITY DEFINER execute', () => {
    const facts = JSON.parse(psql(`
      WITH task4_functions AS (
        SELECT p.oid,p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname IN (
          'apply_execution_domain_ack_v1',
          'reserve_tool_budget_with_receipt_v1',
          'settle_tool_budget_with_receipt_v1',
          'reserve_tool_budget_microusd_with_receipt_v1',
          'settle_tool_budget_microusd_with_receipt_v1'
        )
      )
      SELECT jsonb_build_object(
        'publicExecute',COALESCE(bool_or(has_function_privilege('public',oid,'EXECUTE')),false),
        'appExecute',bool_and(has_function_privilege('app_user',oid,'EXECUTE')),
        'platformExecute',bool_and(has_function_privilege('execution_budget_platform_writer',oid,'EXECUTE')),
        'appInsert',has_table_privilege('app_user','execution_domain_ack','INSERT'),
        'platformInsert',has_table_privilege('execution_budget_platform_writer','execution_domain_ack','INSERT'),
        'rls',(SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='execution_domain_ack'::regclass)
      )::text FROM task4_functions;
    `));
    assert.deepEqual(facts, {
      publicExecute: false,
      appExecute: true,
      platformExecute: true,
      appInsert: false,
      platformInsert: false,
      rls: true,
    });
  });

  it('derives strategy, artifact and ack identity from the settled ledger', () => {
    const typed = JSON.parse(psql(asApp(applySql(OP_APPLY))));
    assert.equal(typed.status, 'APPLIED');
    assert.equal(typed.ack.resultStrategy, 'typed_projection');
    assert.equal(typed.ack.artifactId, null);
    assert.match(typed.ack.ackId, /^[0-9a-f]{64}$/);
    assert.equal(typed.ack.domainAckKey, DOMAIN_KEY);
    assert.equal(typed.ack.domainRevision, DOMAIN_REVISION);
    assert.deepEqual(Object.keys(typed.ack).sort(), [
      'accountId','ackId','artifactId','authorityId','consumer','costBasis',
      'domainAckKey','domainAggregateType','domainRevision','operationId',
      'operationKey','resultDigest','resultSchema','resultStrategy',
      'schemaVersion','scopeKey','usage',
    ].sort());

    const artifact = JSON.parse(psql(asApp(applySql(OP_ARTIFACT, {
      domainKey: 'd'.repeat(64),
    }))));
    assert.equal(artifact.ack.resultStrategy, 'artifact_reference');
    assert.equal(artifact.ack.artifactId, ARTIFACT_ID);
  });

  it('is exact-idempotent and preserves compound ACK identity', () => {
    const replay = JSON.parse(psql(asApp(applySql(OP_APPLY))));
    assert.equal(replay.status, 'REPLAYED');
    const secondAggregate = JSON.parse(psql(asApp(applySql(OP_APPLY, {
      domainKey: 'e'.repeat(64),
    }))));
    const secondRevision = JSON.parse(psql(asApp(applySql(OP_APPLY, {
      revision: 'f'.repeat(64),
    }))));
    assert.equal(secondAggregate.status, 'APPLIED');
    assert.equal(secondRevision.status, 'APPLIED');
    assert.notEqual(secondAggregate.ack.ackId, secondRevision.ack.ackId);
  });

  it('rolls back ACK and domain mutation together when the transaction aborts', () => {
    psql(`
      SET SESSION AUTHORIZATION app_user;
      BEGIN;
      SELECT set_config('app.current_workspace_id', '${WORKSPACE_A}', true);
      ${applySql(OP_ROLLBACK)}
      INSERT INTO task4_domain_mutation(operation_id,value)
        VALUES ('${OP_ROLLBACK}'::uuid,'must-rollback');
      ROLLBACK;
    `);
    const counts = psql(`
      SELECT (SELECT count(*) FROM execution_domain_ack WHERE operation_id='${OP_ROLLBACK}'::uuid)
        || ':' ||
        (SELECT count(*) FROM task4_domain_mutation WHERE operation_id='${OP_ROLLBACK}'::uuid);
    `);
    assert.equal(counts, '0:0');
  });

  it('serializes concurrent missing-key application into APPLIED plus REPLAYED', async () => {
    const first = psqlAsync(`
      SET SESSION AUTHORIZATION app_user;
      BEGIN;
      SELECT set_config('app.current_workspace_id', '${WORKSPACE_A}', true);
      ${applySql(OP_CONCURRENT)}
      SELECT pg_sleep(0.4);
      COMMIT;
    `);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const second = psqlAsync(asApp(applySql(OP_CONCURRENT)));
    const results = (await Promise.all([first, second])).map((output) =>
      JSON.parse(output.split('\n').find((line) => line.startsWith('{'))));
    assert.deepEqual(results.map((row) => row.status).sort(), ['APPLIED', 'REPLAYED']);
    assert.equal(new Set(results.map((row) => row.ack.ackId)).size, 1);
  });

  it('fails closed for cross-workspace, untrusted principal and unsettled operation', () => {
    psql(asApp(applySql(OP_APPLY), WORKSPACE_B), {
      rejects: /DOMAIN_ACK_SCOPE_MISMATCH|permission denied|DOMAIN_ACK_LEDGER_MISMATCH/,
    });
    psql(`
      SET SESSION AUTHORIZATION ${UNTRUSTED_LOGIN};
      ${applySql(OP_APPLY)}
    `, { rejects: /permission denied for function apply_execution_domain_ack_v1/ });
    psql(asApp(applySql(OP_UNSETTLED)), {
      rejects: /DOMAIN_ACK_LEDGER_MISMATCH/,
    });
  });

  it('admits only the existing exact platform-writer principal for platform ACKs', () => {
    const applied = JSON.parse(psql(`
      SET SESSION AUTHORIZATION ${PLATFORM_LOGIN};
      ${applySql(OP_PLATFORM, { scopeKey: 'platform' })}
    `));
    assert.equal(applied.status, 'APPLIED');
    assert.equal(applied.ack.scopeKey, 'platform');

    psql(`
      SET SESSION AUTHORIZATION app_user;
      BEGIN;
      SELECT set_config('app.current_workspace_id', '${WORKSPACE_A}', true);
      ${applySql(OP_PLATFORM, { scopeKey: 'platform', domainKey: '9'.repeat(64) })}
      COMMIT;
    `, { rejects: /EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID|DOMAIN_ACK_SCOPE_MISMATCH/ });
  });
});
