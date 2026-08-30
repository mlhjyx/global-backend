import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsRoot = resolve(root, 'packages/db/prisma/migrations');
const targetName = '20260830130300_discovery_company_materialization_schema';
const image = 'pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b';
const container = `codex-c2-materialization-pg-${process.pid}-${randomBytes(3).toString('hex')}`;
const contract = '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe';
const qContract = 'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c';
const ids = Object.freeze({
  workspace: '10000000-0000-4000-8000-000000000001',
  otherWorkspace: '10000000-0000-4000-8000-000000000002',
  run: '20000000-0000-4000-8000-000000000001',
  plan: '30000000-0000-4000-8000-000000000001',
  admission: '40000000-0000-4000-8000-000000000001',
  item: '50000000-0000-4000-8000-000000000001',
  raw: '60000000-0000-4000-8000-000000000001',
  raw2: '60000000-0000-4000-8000-000000000002',
  company: '70000000-0000-4000-8000-000000000001',
  otherCompany: '70000000-0000-4000-8000-000000000002',
  alternateCompany: '70000000-0000-4000-8000-000000000003',
  identity: '71000000-0000-4000-8000-000000000001',
  operation: '80000000-0000-4000-8000-000000000001',
  operationSubject: '81000000-0000-4000-8000-000000000001',
  rawSubject: '82000000-0000-4000-8000-000000000001',
  canonicalSubject: '83000000-0000-4000-8000-000000000001',
  alternateCanonicalSubject: '83000000-0000-4000-8000-000000000002',
  qRelation: '84000000-0000-4000-8000-000000000001',
  wrongCRelation: '85000000-0000-4000-8000-000000000001',
  cRelation: '85000000-0000-4000-8000-000000000002',
});
const queryKey = 'a'.repeat(64);

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options,
  });
  if (options.rejects) {
    assert.notEqual(result.status, 0, `unexpected success: docker ${args.join(' ')}`);
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
async function migrationFiles() {
  const directories = (await readdir(migrationsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return Promise.all(directories.map(async (directory) => ({
    directory,
    sql: await readFile(resolve(migrationsRoot, directory, 'migration.sql'), 'utf8'),
  })));
}
function applyOne(database, migration, sessionRole = 'global', rejects) {
  const explicit = /(^|\n)\s*BEGIN\s*;/iu.test(migration.sql);
  const sql = explicit
    ? `SET SESSION AUTHORIZATION ${sessionRole};\n${migration.sql}`
    : `SET SESSION AUTHORIZATION ${sessionRole};\nBEGIN;\n${migration.sql}\nCOMMIT;`;
  try {
    return psql(database, sql, rejects ? { rejects } : {});
  } catch (error) {
    throw new Error(`${migration.directory}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
async function applyAll(database, migrations) {
  for (const migration of migrations) applyOne(database, migration);
}
function cloneDatabase(name, template = 'c2_predecessor') {
  psql('postgres', `
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname='${template}' AND pid<>pg_backend_pid();
    CREATE DATABASE ${name} TEMPLATE ${template} OWNER global;
  `);
}
function asApp(sql, workspace = ids.workspace) {
  return `SET SESSION AUTHORIZATION app_user;BEGIN;
    SELECT set_config('app.current_workspace_id','${workspace}',true);
    ${sql} COMMIT;`;
}
function catalog(database) {
  return psql(database, `SELECT jsonb_build_object(
    'columns',(SELECT jsonb_agg(jsonb_build_array(table_name,column_name,udt_name,is_nullable,
      COALESCE(column_default,'')) ORDER BY table_name,ordinal_position)
      FROM information_schema.columns WHERE table_schema='public' AND
      (table_name LIKE 'discovery_company_materialization_%'
       OR table_name='discovery_run' AND column_name='materialization_contract_version')),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(conrelid::regclass::text,conname,contype,
      condeferrable,condeferred,pg_get_constraintdef(oid)) ORDER BY conrelid::regclass::text,conname)
      FROM pg_constraint WHERE conname LIKE '%materialization%' OR
        conrelid IN('identity_link'::regclass,'canonical_company'::regclass,
          'canonical_contact'::regclass,'raw_source_governance_disposition'::regclass)
        AND conname IN('identity_link_exact_tuple_key','identity_link_workspace_id_id_key',
          'canonical_company_workspace_id_id_key','canonical_contact_workspace_id_id_key',
          'raw_source_governance_disposition_workspace_id_raw_key')),
    'triggers',(SELECT jsonb_agg(jsonb_build_array(event_object_table,trigger_name,event_manipulation)
      ORDER BY event_object_table,trigger_name,event_manipulation)
      FROM information_schema.triggers WHERE trigger_name LIKE '%materialization%'
        OR trigger_name IN('identity_link_typed_target','identity_link_immutable')),
    'policies',(SELECT jsonb_agg(jsonb_build_array(tablename,policyname,qual,with_check)
      ORDER BY tablename,policyname) FROM pg_policies
      WHERE tablename LIKE 'discovery_company_materialization_%'),
    'indexes',(SELECT jsonb_agg(indexdef ORDER BY indexname) FROM pg_indexes
      WHERE schemaname='public' AND(indexname LIKE '%materialization%'
        OR indexname='identity_link_company_raw_unique'))
  )::text;`);
}

describe('Discovery company materialization Release A schema', { concurrency: false }, () => {
  let all;
  let predecessors;
  let target;
  const pollution = [];

  before(async () => {
    docker(['image', 'inspect', image]);
    docker(['run', '-d', '--name', container, '--network', 'none',
      '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=768m',
      '-e', 'POSTGRES_PASSWORD=local-only', image]);
    const inspected = JSON.parse(docker(['inspect', container]).stdout)[0];
    assert.equal(inspected.HostConfig.NetworkMode, 'none');
    assert.deepEqual(inspected.HostConfig.PortBindings, {});
    assert.equal(inspected.Config.Image, image);
    let ready = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = spawnSync('docker', ['exec', container, 'psql', '-U', 'postgres',
        '-d', 'postgres', '-X', '-qAt', '-c', 'SELECT 1'], { encoding: 'utf8' });
      ready = result.status === 0 ? ready + 1 : 0;
      if (ready >= 2) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.equal(ready >= 2, true, 'disposable PostgreSQL did not become ready');
    psql('postgres', 'CREATE ROLE global LOGIN SUPERUSER;CREATE DATABASE c2_predecessor OWNER global;');
    all = await migrationFiles();
    target = all.find((entry) => entry.directory === targetName);
    assert.ok(target);
    predecessors = all.filter((entry) => entry.directory < targetName);
    const releaseA = all.filter((entry) => entry.directory <= targetName);
    assert.equal(predecessors.length, 122);
    assert.equal(releaseA.length, 123);
    await applyAll('c2_predecessor', predecessors);
    for (const database of ['c2_polluted','c2_limited','c2_upgrade']) cloneDatabase(database);

    const roleSql = `CREATE ROLE discovery_materialization_fact_reader
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;`;
    psql('postgres', `${roleSql} GRANT discovery_materialization_fact_reader TO app_user;`);
    pollution.push(applyOne('c2_polluted', target, 'global', /MEMBERSHIP_INVALID/u));
    psql('postgres', 'REVOKE discovery_materialization_fact_reader FROM app_user;DROP ROLE discovery_materialization_fact_reader;');
    psql('postgres', `${roleSql} GRANT app_user TO discovery_materialization_fact_reader;`);
    pollution.push(applyOne('c2_polluted', target, 'global', /MEMBERSHIP_INVALID/u));
    psql('postgres', 'REVOKE app_user FROM discovery_materialization_fact_reader;DROP ROLE discovery_materialization_fact_reader;');
    psql('postgres', roleSql);
    psql('c2_polluted', 'GRANT SELECT ON workspace TO discovery_materialization_fact_reader;');
    pollution.push(applyOne('c2_polluted', target, 'global', /GRANT_INVALID/u));
    psql('c2_polluted', 'REVOKE SELECT ON workspace FROM discovery_materialization_fact_reader;');
    psql('postgres', 'DROP ROLE discovery_materialization_fact_reader;');
    psql('postgres', `${roleSql} GRANT CREATE ON DATABASE c2_polluted TO discovery_materialization_fact_reader;`);
    pollution.push(applyOne('c2_polluted', target, 'global', /GRANT_INVALID/u));
    psql('postgres', `REVOKE CREATE ON DATABASE c2_polluted FROM discovery_materialization_fact_reader;
      DROP ROLE discovery_materialization_fact_reader;`);
    psql('postgres', roleSql);
    psql('c2_polluted', 'GRANT CREATE ON SCHEMA public TO discovery_materialization_fact_reader;');
    pollution.push(applyOne('c2_polluted', target, 'global', /GRANT_INVALID/u));
    psql('c2_polluted', 'REVOKE CREATE ON SCHEMA public FROM discovery_materialization_fact_reader;');
    psql('postgres', 'DROP ROLE discovery_materialization_fact_reader;');
    psql('postgres', roleSql);
    psql('c2_polluted', `ALTER DEFAULT PRIVILEGES FOR ROLE global
      GRANT SELECT ON TABLES TO discovery_materialization_fact_reader;`);
    pollution.push(applyOne('c2_polluted', target, 'global', /GRANT_INVALID/u));
    psql('c2_polluted', `ALTER DEFAULT PRIVILEGES FOR ROLE global
      REVOKE SELECT ON TABLES FROM discovery_materialization_fact_reader;`);
    psql('postgres', 'DROP ROLE discovery_materialization_fact_reader;');
    psql('postgres', roleSql);
    psql('c2_polluted', 'CREATE TABLE polluted_owner(id integer);ALTER TABLE polluted_owner OWNER TO discovery_materialization_fact_reader;');
    pollution.push(applyOne('c2_polluted', target, 'global', /OWNERSHIP_INVALID/u));
    psql('c2_polluted', 'DROP TABLE polluted_owner;');
    psql('postgres', 'DROP ROLE discovery_materialization_fact_reader;');

    psql('postgres', 'CREATE ROLE c2_limited LOGIN NOSUPERUSER NOCREATEROLE;');
    applyOne('c2_limited', target, 'c2_limited', /MIGRATION_PRINCIPAL_INVALID/u);
    psql('postgres', 'DROP ROLE c2_limited;');

    applyOne('c2_upgrade', target);
    cloneDatabase('c2_behavior', 'c2_upgrade');
    psql('postgres', 'CREATE DATABASE c2_fresh OWNER global;');
    await applyAll('c2_fresh', releaseA);
  });

  after(() => {
    spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
  });

  it('applies the exact 122 to 123 upgrade and matches a fresh 123 catalog', () => {
    assert.equal(pollution.length, 7);
    assert.equal(catalog('c2_upgrade'), catalog('c2_fresh'));
    for (const database of ['c2_upgrade','c2_fresh']) {
      assert.equal(psql(database, `SELECT concat_ws('|',
        (SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
          AND table_name LIKE 'discovery_company_materialization_%'),
        (SELECT count(*) FROM discovery_company_materialization_activation),
        (SELECT count(*) FROM pg_class WHERE relname IN(
          'discovery_company_materialization_admission','discovery_company_materialization_outcome',
          'discovery_company_materialization_batch_receipt','discovery_company_materialization_query_receipt',
          'discovery_company_materialization_run_receipt') AND relrowsecurity AND relforcerowsecurity),
        (SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid IN(m.roleid,m.member)
          WHERE r.rolname='discovery_materialization_fact_reader'))`), '7|0|5|0');
    }
    assert.equal(psql('c2_fresh', `SELECT concat_ws('|',rolcanlogin,rolinherit,rolsuper,
      rolcreatedb,rolcreaterole,rolreplication,rolbypassrls) FROM pg_roles
      WHERE rolname='discovery_materialization_fact_reader'`), 'f|f|f|f|f|f|t');
    assert.equal(psql('c2_fresh', `SELECT string_agg(relname,',' ORDER BY relname) FROM pg_class
      WHERE relowner='discovery_materialization_fact_reader'::regrole`),
      'discovery_company_materialization_tx_fence,discovery_company_materialization_tx_fence_exact_key,discovery_company_materialization_tx_fence_pkey');
  });

  it('keeps Release A inactive and fences every activation mutation path', () => {
    assert.equal(psql('c2_behavior', 'SELECT count(*) FROM discovery_company_materialization_activation'), '0');
    const row = `1,'discovery-company-materialization/v1','${contract}',clock_timestamp()`;
    psql('c2_behavior', `INSERT INTO discovery_company_materialization_activation VALUES(${row});`,
      { rejects: /ACTIVATION_DENIED/u });
    psql('c2_behavior', `COPY discovery_company_materialization_activation FROM STDIN;
1\tdiscovery-company-materialization/v1\t${contract}\t2026-08-31 00:00:00+00
\.`, { rejects: /ACTIVATION_DENIED/u });
    psql('c2_behavior', `CREATE FUNCTION c2_dynamic_activation() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN EXECUTE format('INSERT INTO discovery_company_materialization_activation VALUES (1,%L,%L,clock_timestamp())',
        'discovery-company-materialization/v1','${contract}'); END $$;`);
    psql('c2_behavior', 'SELECT c2_dynamic_activation();', { rejects: /ACTIVATION_DENIED/u });
    for (const role of ['app_user','runtime_worker']) {
      psql('c2_behavior', `SET SESSION AUTHORIZATION ${role};BEGIN;
        SELECT set_config('app.discovery_company_materialization_activation_v1','${contract}',true);
        INSERT INTO discovery_company_materialization_activation VALUES(${row});COMMIT;`,
      { rejects: /permission denied/u });
      assert.equal(psql('c2_behavior',
        'SELECT count(*) FROM discovery_company_materialization_activation'), '0');
    }
    assert.equal(psql('c2_behavior', 'SELECT count(*) FROM discovery_company_materialization_activation'), '0');
    psql('c2_behavior', `BEGIN;SELECT set_config(
      'app.discovery_company_materialization_activation_v1','${contract}',true);
      INSERT INTO discovery_company_materialization_activation VALUES(${row});COMMIT;`);
    psql('c2_behavior', 'UPDATE discovery_company_materialization_activation SET activated_at=clock_timestamp();',
      { rejects: /IMMUTABLE/u });
    psql('c2_behavior', 'DELETE FROM discovery_company_materialization_activation;',
      { rejects: /IMMUTABLE/u });
    assert.equal(psql('c2_behavior', 'SELECT count(*) FROM discovery_company_materialization_activation'), '1');
  });

  it('enforces marker activation and typed target identities', () => {
    psql('c2_behavior', `INSERT INTO workspace(id,name,created_at,updated_at) VALUES
      ('${ids.workspace}','C2',now(),now()),('${ids.otherWorkspace}','C2 other',now(),now());
      INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status,materialization_contract_version)
      VALUES('${ids.run}','${ids.workspace}','${ids.plan}','90000000-0000-4000-8000-000000000001',
        'RUNNING','discovery-company-materialization/v1');`);
    psql('c2_behavior', asApp(`INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status,
      materialization_contract_version) VALUES('20000000-0000-4000-8000-000000000002',
      '${ids.workspace}','${ids.plan}','90000000-0000-4000-8000-000000000001','RUNNING',NULL);`),
      { rejects: /MARKER_REQUIRED/u });
    psql('c2_behavior', `SET session_replication_role=replica;
      INSERT INTO raw_source_record(id,workspace_id,run_id,provider_key,source_class,payload,ingest_version)
      VALUES('${ids.raw}','${ids.workspace}','${ids.run}','public_web','public_intelligence','{}','fixture/v1'),
        ('${ids.raw2}','${ids.workspace}','${ids.run}','public_web','public_intelligence','{}','fixture/v1');
      SET session_replication_role=origin;
      INSERT INTO canonical_company(id,workspace_id,name,status,dedupe_key,version,created_at,updated_at)
      VALUES('${ids.company}','${ids.workspace}','C2 Pumps','NEW','d:c2',1,now(),now()),
        ('${ids.otherCompany}','${ids.otherWorkspace}','Other','NEW','d:other',1,now(),now()),
        ('${ids.alternateCompany}','${ids.workspace}','Alternate','NEW','d:alternate',1,now(),now());`);
    psql('c2_behavior', asApp(`INSERT INTO identity_link(id,workspace_id,canonical_type,canonical_id,
      raw_record_id,match_rule,confidence,created_at) VALUES('${ids.identity}','${ids.workspace}',
      'company','${ids.company}','${ids.raw}','domain_exact',1,now());`));
    psql('c2_behavior', asApp(`INSERT INTO identity_link(id,workspace_id,canonical_type,canonical_id,
      raw_record_id,match_rule,confidence,created_at) VALUES(gen_random_uuid(),'${ids.workspace}',
      'company','${ids.otherCompany}','${ids.raw2}','domain_exact',1,now());`),
      { rejects: /IDENTITY_TARGET_INVALID/u });
    psql('c2_behavior', `UPDATE identity_link SET match_rule='name_country' WHERE id='${ids.identity}';`,
      { rejects: /IMMUTABLE/u });
  });

  it('rejects cross-paired Canonical subjects and C relation identities', () => {
    const sha = 'b'.repeat(64);
    psql('c2_behavior', `SET session_replication_role=replica;
      INSERT INTO discovery_query_receipt(workspace_id,run_id,plan_id,authority_id,account_key,purpose,
        subject_type,subject_id,request_sha256,query_key,query_ordinal,source_class,providers,provider_count,
        record_count,accepted_count,quarantined_count,rejected_count,duplicate_count,governance_denied_count,
        usage_quantity,cost_cents,contract_sha256) VALUES('${ids.workspace}','${ids.run}','${ids.plan}',
        '91000000-0000-4000-8000-000000000001',
        'discovery.run:discovery_run:request:${sha}:${sha}','discovery.run','discovery_run',
        'request:${sha}','${sha}','${queryKey}',0,'public_intelligence','["public_web"]',1,1,1,0,0,0,0,1,0,'${qContract}');
      INSERT INTO discovery_query_attempt_item(id,workspace_id,run_id,query_key,provider_key,operation_id,
        record_index,resolution_kind,raw_record_id,raw_payload_hash,raw_ingest_status,relation_key,
        operation_subject_id,child_subject_id,relation_id,contract_sha256) VALUES('${ids.item}',
        '${ids.workspace}','${ids.run}','${queryKey}','public_web','${ids.operation}',0,'INSERTED',
        '${ids.raw}','${sha}','ACCEPTED','discovery.raw_source_record:0','${ids.operationSubject}',
        '${ids.rawSubject}','${ids.qRelation}','${qContract}');
      INSERT INTO governed_subject(id,scope_key,workspace_id,subject_type,subject_id,data_class)
      VALUES('${ids.operationSubject}','${ids.workspace}','${ids.workspace}','tool_operation','${ids.operation}','NON_PERSONAL'),
        ('${ids.rawSubject}','${ids.workspace}','${ids.workspace}','raw_source_record','${ids.raw}','NON_PERSONAL'),
        ('${ids.canonicalSubject}','${ids.workspace}','${ids.workspace}','canonical_company','${ids.company}','NON_PERSONAL'),
        ('${ids.alternateCanonicalSubject}','${ids.workspace}','${ids.workspace}','canonical_company',
          '${ids.alternateCompany}','NON_PERSONAL');
      INSERT INTO governed_subject_relation(id,scope_key,workspace_id,authority_id,account_id,operation_id,
        operation_generation,ack_id,operation_subject_id,parent_subject_id,child_subject_id,relation_key,
        relation_kind,source_ref_namespace,source_ref_uuid,contract_sha256)
      VALUES('${ids.qRelation}','${ids.workspace}','${ids.workspace}',gen_random_uuid(),gen_random_uuid(),
        '${ids.operation}',1,'${sha}','${ids.operationSubject}','${ids.operationSubject}','${ids.rawSubject}',
        'discovery.raw_source_record:0','MATERIALIZED_CHILD','discovery_query_attempt_item','${ids.item}','${sha}'),
       ('${ids.wrongCRelation}','${ids.workspace}','${ids.workspace}',gen_random_uuid(),gen_random_uuid(),
        '${ids.operation}',1,'${sha}','${ids.operationSubject}','${ids.rawSubject}','${ids.canonicalSubject}',
        'discovery.canonical_company:99','DERIVED_FROM','discovery_company_materialization_outcome','${ids.item}','${sha}'),
       ('${ids.cRelation}','${ids.workspace}','${ids.workspace}',gen_random_uuid(),gen_random_uuid(),
        '${ids.operation}',1,'${sha}','${ids.operationSubject}','${ids.rawSubject}','${ids.canonicalSubject}',
        'discovery.canonical_company:0','DERIVED_FROM','discovery_company_materialization_outcome','${ids.item}','${sha}');
      SET session_replication_role=origin;
      INSERT INTO discovery_company_materialization_admission(admission_id,workspace_id,run_id,
        materialization_contract_version,mode,reason_code,q_contract_sha256,contract_sha256)
      VALUES('${ids.admission}','${ids.workspace}','${ids.run}','discovery-company-materialization/v1',
        'GOVERNED_C_TX','GOVERNED_Q_V2_COMPLETE','${qContract}','${contract}');
      INSERT INTO discovery_company_materialization_batch_receipt(workspace_id,admission_id,run_id,
        query_key,batch_ordinal,first_item_key,last_item_key,expected_item_count,item_set_sha256,
        outcome_canonicalized_count,outcome_raw_quarantined_count,outcome_raw_rejected_count,
        outcome_restricted_processing_count,outcome_suppressed_count,outcome_not_canonicalizable_count,
        outcome_expired_before_canonicalization_count,mutation_created_count,mutation_updated_count,
        mutation_linked_count,mutation_reused_count,evidence_manifest_count,evidence_manifest_sha256,
        contract_sha256) VALUES('${ids.workspace}','${ids.admission}','${ids.run}','${queryKey}',0,
        'public_web:0:${ids.raw}:${ids.item}','public_web:0:${ids.raw}:${ids.item}',1,'${sha}',
        1,0,0,0,0,0,0,1,0,0,0,1,'${sha}','${contract}');`);
    const outcome = (relationId, canonicalSubjectId = ids.canonicalSubject) =>
      `INSERT INTO discovery_company_materialization_outcome(
      workspace_id,admission_id,run_id,query_item_id,query_key,query_ordinal,provider_key,operation_id,
      record_index,raw_record_id,raw_governed_subject_id,q_relation_id,q_ingest_status,batch_ordinal,
      outcome,canonical_company_id,identity_link_id,identity_canonical_type,canonical_governed_subject_id,
      canonical_governed_subject_type,c_relation_id,c_relation_key,match_rule,confidence,mutation_class,
      evidence_count,evidence_manifest_sha256,contract_sha256) VALUES('${ids.workspace}','${ids.admission}',
      '${ids.run}','${ids.item}','${queryKey}',0,'public_web','${ids.operation}',0,'${ids.raw}',
      '${ids.rawSubject}','${ids.qRelation}','ACCEPTED',0,'CANONICALIZED','${ids.company}',
      '${ids.identity}','company','${canonicalSubjectId}','canonical_company','${relationId}',
      'discovery.canonical_company:0','domain_exact',1,'CREATED',1,'${sha}','${contract}');`;
    psql('c2_behavior', outcome(ids.cRelation, ids.alternateCanonicalSubject),
      { rejects: /canonical_subject_fkey/u });
    psql('c2_behavior', outcome(ids.wrongCRelation), { rejects: /outcome_c_relation_fkey/u });
    psql('c2_behavior', outcome(ids.cRelation));
    assert.equal(psql('c2_behavior', `SELECT count(*) FROM discovery_company_materialization_outcome
      WHERE workspace_id='${ids.workspace}'`), '1');
    assert.equal(psql('c2_behavior', asApp(`SELECT count(*) FROM discovery_company_materialization_outcome;`,
      ids.otherWorkspace)), `${ids.otherWorkspace}\n0`);
  });
});
