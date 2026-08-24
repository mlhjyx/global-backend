import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsRoot = resolve(repositoryRoot, 'packages/db/prisma/migrations');
const image = 'pgvector/pgvector:pg16';
const container = `codex-task6-pg-${process.pid}-${randomBytes(3).toString('hex')}`;
const workspaceId = '61000000-0000-4000-8000-000000000001';
const authorityId = '62000000-0000-4000-8000-000000000001';

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (options.rejects) {
    assert.notEqual(result.status, 0, `command unexpectedly passed: docker ${args.join(' ')}`);
    assert.match(`${result.stderr}\n${result.stdout}`, options.rejects);
    return result;
  }
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return result;
}

function psql(database, sql, options = {}) {
  return docker([
    'exec', '-i', container, 'psql', '-U', 'postgres', '-d', database,
    '--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  ], { input: sql, ...options }).stdout.trim();
}

function psqlAsync(database, sql) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('docker', [
      'exec', '-i', container, 'psql', '-U', 'postgres', '-d', database,
      '--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else rejectPromise(new Error(`${stderr}\n${stdout}`));
    });
    child.stdin.end(sql);
  });
}

async function migrationFiles() {
  const directories = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Promise.all(directories.map(async (directory) => ({
    directory,
    sql: await readFile(resolve(migrationsRoot, directory, 'migration.sql'), 'utf8'),
  })));
}

async function apply(database, migrations) {
  for (const migration of migrations) {
    try {
      const explicitTransaction = /(^|\n)\s*BEGIN\s*;/i.test(migration.sql);
      const sql = explicitTransaction
        ? `SET SESSION AUTHORIZATION global;\n${migration.sql}`
        : `BEGIN;\nSET LOCAL ROLE global;\n${migration.sql}\nCOMMIT;`;
      psql(database, sql);
    } catch (error) {
      throw new Error(`${migration.directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function asApp(sql, workspace = workspaceId) {
  return `
    SET SESSION AUTHORIZATION app_user;
    BEGIN;
    SELECT set_config('app.current_workspace_id', '${workspace}', true);
    ${sql}
    COMMIT;
  `;
}

function asPlatform(sql) {
  return `SET SESSION AUTHORIZATION task6_platform_writer; BEGIN; ${sql} COMMIT;`;
}

function seedWorkspaceAndAuthority(database) {
  psql(database, `
    INSERT INTO workspace(id,name,created_at,updated_at)
    VALUES ('${workspaceId}'::uuid,'Task6',now(),now());
    INSERT INTO execution_budget_authority(
      id,scope_key,authority_kind,workspace_id,issuer,audience,jti,token_sha256,
      schema_version,purpose,subject_type,subject_id,request_sha256,schedule_id,
      currency,unit,cap_microusd,cap_per_run_microusd,campaign_cap_microusd,
      max_runs,runs_consumed,issued_at,not_before,expires_at,consumed_at
    ) VALUES (
      '${authorityId}'::uuid,'${workspaceId}','WORKSPACE_GRANT','${workspaceId}'::uuid,
      'https://task6.test','global-backend:execution-budget','${randomUUID()}'::uuid,
      repeat('a',64),'execution-budget-grant/v1','icp.design','company','company:task6',
      repeat('b',64),NULL,'USD','microusd',10000,NULL,NULL,NULL,0,
      now()-interval '30 seconds',now()-interval '20 seconds',now()+interval '4 minutes',now()
    );
  `);
}

function seedHistoricalTerminal(database) {
  psql(database, `
    INSERT INTO tool_budget_account(
      id,scope_key,account_key,generation,cap_cents,reserved_cents,charged_cents,
      reserved_microusd,charged_microusd,exhausted,ref_count,authority_id,
      authorized_cap_microusd,closed_at,created_at,updated_at
    ) VALUES (
      '63000000-0000-4000-8000-000000000001'::uuid,'${workspaceId}',
      'historical-terminal',1,7,0,7,0,0,true,0,NULL,NULL,now(),now(),now()
    );
  `);
}

describe('Task 6 authority-only PostgreSQL cutover', () => {
  let allMigrations;
  let predecessors;
  let cutover;

  before(async () => {
    docker(['image', 'inspect', image]);
    docker([
      'run', '-d', '--name', container, '--network', 'none',
      '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=512m',
      '-e', 'POSTGRES_PASSWORD=task6-local-only', image,
    ]);
    let ready = false;
    let consecutive = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const result = spawnSync('docker', [
        'exec', container, 'psql', '-U', 'postgres', '-d', 'postgres',
        '--no-psqlrc', '-X', '-qAt', '-c', 'SELECT 1',
      ], { encoding: 'utf8' });
      consecutive = result.status === 0 ? consecutive + 1 : 0;
      if (consecutive >= 2) { ready = true; break; }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.equal(ready, true, 'disposable PostgreSQL did not become ready');

    allMigrations = await migrationFiles();
    cutover = allMigrations.find((entry) =>
      entry.directory.endsWith('_execution_budget_authority_cutover'));
    predecessors = allMigrations.filter((entry) => entry !== cutover);

    psql('postgres', `
      CREATE ROLE global LOGIN SUPERUSER;
      CREATE DATABASE task6_template OWNER global;
    `);
    await apply('task6_template', predecessors);
    psql('postgres', `
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname='task6_template' AND pid <> pg_backend_pid();
      CREATE DATABASE task6_upgrade TEMPLATE task6_template;
      CREATE DATABASE task6_rollback TEMPLATE task6_template;
      CREATE DATABASE task6_fresh;
    `);
  });

  after(() => {
    spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
  });

  it('migrates a fresh empty database to one authority-only microusd lifecycle', async () => {
    await apply('task6_fresh', allMigrations);
    seedWorkspaceAndAuthority('task6_fresh');

    const procedures = psql('task6_fresh', `SELECT concat_ws('|',
      to_regprocedure('open_tool_budget(text,uuid,text,boolean)') IS NOT NULL,
      to_regprocedure('open_tool_budget(text,text,bigint,boolean)') IS NULL,
      NOT has_function_privilege('app_user','open_authorized_tool_budget_v1(text,uuid,text,boolean)','EXECUTE'),
      NOT has_function_privilege('app_user','reserve_tool_budget_microusd_v1(text,text,text,bigint)','EXECUTE'),
      NOT has_function_privilege('app_user','settle_tool_budget_microusd_v1(text,uuid,bigint,text,text,text,jsonb)','EXECUTE'),
      NOT has_function_privilege('app_user','release_tool_budget_microusd_v1(text,uuid)','EXECUTE'),
      NOT has_function_privilege('app_user','mark_tool_budget_result_unknown_v4(text,uuid,jsonb,smallint,boolean,text,text,text,boolean,text,uuid)','EXECUTE'),
      NOT has_function_privilege('app_user','load_tool_budget_result_unknown_artifact_v4(text,uuid,uuid,text,uuid)','EXECUTE'),
      NOT has_function_privilege('app_user','settle_tool_budget_artifact_manifest_v4(text,uuid,bigint,jsonb,smallint,boolean,text,text,text,boolean,text,uuid)','EXECUTE'),
      NOT has_function_privilege('execution_budget_platform_writer','mark_tool_budget_result_unknown_v4(text,uuid,jsonb,smallint,boolean,text,text,text,boolean,text,uuid)','EXECUTE'),
      NOT has_function_privilege('execution_budget_platform_writer','load_tool_budget_result_unknown_artifact_v4(text,uuid,uuid,text,uuid)','EXECUTE'),
      NOT has_function_privilege('execution_budget_platform_writer','settle_tool_budget_artifact_manifest_v4(text,uuid,bigint,jsonb,smallint,boolean,text,text,text,boolean,text,uuid)','EXECUTE'),
      has_function_privilege('app_user','load_tool_budget_result_unknown_artifact_v5(text,uuid,uuid,text,uuid)','EXECUTE')
    );`);
    assert.equal(procedures, 't|t|t|t|t|t|t|t|t|t|t|t|t');

    const opened = psql('task6_fresh', asApp(`
      SELECT authority_id::text || '|' || authorized_cap_microusd::text
      FROM open_tool_budget('${workspaceId}','${authorityId}'::uuid,'fresh-account',false);
    `));
    assert.match(opened, new RegExp(`${authorityId}\\|10000`));

    const outcomes = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      psqlAsync('task6_fresh', asApp(`
        SELECT kind FROM reserve_tool_budget(
          '${workspaceId}','fresh-account','operation-${index}',1000
        );
      `))));
    assert.equal(outcomes.filter((value) => value.includes('EXECUTE')).length, 10);
    assert.equal(outcomes.filter((value) => value.includes('DENIED')).length, 10);
    const invariant = psql('task6_fresh', `
      SELECT (reserved_microusd + charged_microusd <= authorized_cap_microusd)::text
      FROM tool_budget_account WHERE account_key='fresh-account';
    `);
    assert.equal(invariant, 'true');

    const operationId = psql('task6_fresh', `
      SELECT operation."id"::text
      FROM tool_budget_operation operation
      JOIN tool_budget_account account ON account.id=operation.account_id
      WHERE account.account_key='fresh-account'
        AND operation.operation_key='operation-0';
    `);
    const reserveAndSettle = await Promise.all(Array.from(
      { length: 20 },
      (_, index) => index % 2 === 0
        ? psqlAsync('task6_fresh', asApp(`
            SELECT kind FROM reserve_tool_budget(
              '${workspaceId}','fresh-account','operation-0',1000
            );
          `))
        : psqlAsync('task6_fresh', asApp(`
            SELECT status FROM settle_tool_budget(
              '${workspaceId}','${operationId}'::uuid,900,
              NULL,NULL,NULL,NULL,NULL,NULL
            );
          `)),
    ));
    assert.equal(reserveAndSettle.length, 20);
    assert.equal(reserveAndSettle.every((value) => !/deadlock detected/i.test(value)), true);
    assert.throws(() => psql('task6_fresh', asApp(`
      SELECT * FROM mark_tool_budget_result_unknown_v4(
        '${workspaceId}','${operationId}'::uuid,NULL::jsonb,
        NULL::smallint,NULL::boolean,NULL::text,NULL::text,NULL::text,
        NULL::boolean,NULL::text,NULL::uuid
      );
    `)), /permission denied for function mark_tool_budget_result_unknown_v4/);
  });

  it('upgrades nonempty authority data while preserving historical terminal rows read-only', async () => {
    assert.ok(cutover, 'Task 6 cutover migration is required');
    seedWorkspaceAndAuthority('task6_upgrade');
    seedHistoricalTerminal('task6_upgrade');
    psql('task6_upgrade', asApp(`
      SELECT * FROM open_authorized_tool_budget_v1(
        '${workspaceId}','${authorityId}'::uuid,'upgrade-authority',false
      );
    `));
    await apply('task6_upgrade', [cutover]);

    const preserved = psql('task6_upgrade', `
      SELECT concat_ws('|',account_key,cap_cents,charged_cents,closed_at IS NOT NULL)
      FROM tool_budget_account WHERE account_key='historical-terminal';
    `);
    assert.equal(preserved, 'historical-terminal|7|7|t');
    psql('task6_upgrade', asApp(`
      SELECT * FROM reserve_tool_budget(
        '${workspaceId}','historical-terminal','forbidden-history-reopen',1
      );
    `), { rejects: /TOOL_BUDGET_ACCOUNT_UNAVAILABLE|TOOL_BUDGET_HISTORICAL_TERMINAL/ });

    const active = psql('task6_upgrade', `
      SELECT authority_id::text || '|' || authorized_cap_microusd::text || '|' || cap_cents::text
      FROM tool_budget_account WHERE account_key='upgrade-authority';
    `);
    assert.equal(active, `${authorityId}|10000|0`);
  });

  it('lets only the bounded platform writer complete the final microusd lifecycle', async () => {
    const platformAuthorityId = '62000000-0000-4000-8000-000000000002';
    psql('task6_fresh', `
      CREATE ROLE task6_platform_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS INHERIT;
      GRANT execution_budget_platform_writer TO task6_platform_writer;
      INSERT INTO execution_budget_authority(
        id,scope_key,authority_kind,workspace_id,issuer,audience,jti,token_sha256,
        schema_version,purpose,subject_type,subject_id,request_sha256,schedule_id,
        currency,unit,cap_microusd,cap_per_run_microusd,campaign_cap_microusd,
        max_runs,runs_consumed,issued_at,not_before,expires_at,consumed_at
      ) VALUES (
        '${platformAuthorityId}'::uuid,'platform','PLATFORM_GRANT',NULL,
        'https://task6.test','global-backend:execution-budget','${randomUUID()}'::uuid,
        repeat('c',64),'execution-budget-grant/v1','platform.acquisition',
        'schedule','task6-platform',NULL,'task6-platform','USD','microusd',NULL,
        10000,100000,10,0,now()-interval '30 seconds',now()-interval '20 seconds',
        now()+interval '4 minutes',NULL
      );
    `);
    psql('task6_fresh', asPlatform(`
      SELECT * FROM open_tool_budget(
        'platform','${platformAuthorityId}'::uuid,'platform-account',false
      );
    `));
    const execute = JSON.parse(psql('task6_fresh', asPlatform(`
      SELECT row_to_json(result)::text FROM reserve_tool_budget(
        'platform','platform-account','platform-settle',1000
      ) result;
    `)).split('\n').find((line) => line.startsWith('{')));
    assert.equal(execute.kind, 'EXECUTE');
    const settled = psql('task6_fresh', asPlatform(`
      SELECT charged_microusd::text || '|' || status
      FROM settle_tool_budget(
        'platform','${execute.operation_id}'::uuid,750,
        NULL,NULL,NULL,NULL,NULL,NULL
      );
    `));
    assert.match(settled, /750\|SETTLED/);
    const releasedReservation = JSON.parse(psql('task6_fresh', asPlatform(`
      SELECT row_to_json(result)::text FROM reserve_tool_budget(
        'platform','platform-account','platform-release',1000
      ) result;
    `)).split('\n').find((line) => line.startsWith('{')));
    const released = psql('task6_fresh', asPlatform(`
      SELECT status FROM release_tool_budget(
        'platform','${releasedReservation.operation_id}'::uuid
      );
    `));
    assert.match(released, /RELEASED/);
    assert.equal(psql('task6_fresh', asPlatform(`
      SELECT remaining_microusd::text FROM tool_budget_status(
        'platform','platform-account'
      );
    `)).split('\n').find((line) => /^\d+$/.test(line)), '9250');
  });

  it('rolls the migration transaction back when an active unauthorized account exists', async () => {
    assert.ok(cutover, 'Task 6 cutover migration is required');
    psql('task6_rollback', `
      INSERT INTO workspace(id,name,created_at,updated_at)
      VALUES ('${workspaceId}'::uuid,'Task6 rollback',now(),now());
      INSERT INTO tool_budget_account(
        scope_key,account_key,generation,cap_cents,reserved_cents,charged_cents,
        reserved_microusd,charged_microusd,exhausted,ref_count,created_at,updated_at
      ) VALUES ('${workspaceId}','unauthorized-active',1,5,0,0,0,0,false,1,now(),now());
    `);
    psql('task6_rollback', `SET SESSION AUTHORIZATION global;\n${cutover.sql}`, {
      rejects: /TOOL_BUDGET_ACTIVE_UNAUTHORIZED_ACCOUNTS|active unauthorized/i,
    });
    const rollback = psql('task6_rollback', `SELECT concat_ws('|',
      to_regprocedure('open_tool_budget(text,text,bigint,boolean)') IS NOT NULL,
      to_regprocedure('open_tool_budget(text,uuid,text,boolean)') IS NULL,
      EXISTS(SELECT 1 FROM tool_budget_account WHERE account_key='unauthorized-active')
    );`);
    assert.equal(rollback, 't|t|t');
  });
});
