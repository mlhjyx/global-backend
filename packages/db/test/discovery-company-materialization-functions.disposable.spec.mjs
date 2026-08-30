import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationsRoot = resolve(root, 'packages/db/prisma/migrations');
const target = '20260830130400_discovery_company_materialization_functions';
const image = 'pgvector/pgvector@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b';
const container = `codex-c3-materialization-pg-${process.pid}-${randomBytes(3).toString('hex')}`;
const database = 'c3_functions';
const contract = '558e526a674a7eac4e5e83d03fcf4f635c15b1b3081cffc7f03c2d9213c0c9fe';
const ws = '10000000-0000-4000-8000-000000000001';
const otherWs = '10000000-0000-4000-8000-000000000002';
const legacyRun = '20000000-0000-4000-8000-000000000001';
const governedRun = '20000000-0000-4000-8000-000000000002';
const plan = '30000000-0000-4000-8000-000000000001';
const icp = '40000000-0000-4000-8000-000000000001';
const qContract = 'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c';
const aContract = 'dd2f4144f58de22f7415dfc11be56c4828c137e52d34e916852e64cfde38a2e1';

function docker(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (options.rejects) {
    assert.notEqual(result.status, 0, `unexpected success: docker ${args.join(' ')}`);
    assert.match(`${result.stderr}\n${result.stdout}`, options.rejects);
    return result;
  }
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return result;
}
function psql(sql, options = {}) {
  return docker(['exec', '-i', container, 'psql', '-U', 'global', '-d', database,
    '--no-psqlrc', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, ...options }).stdout.trim();
}
function app(sql, workspace = ws) {
  return `SET SESSION AUTHORIZATION app_user;BEGIN;
    SELECT set_config('app.current_workspace_id','${workspace}',true);
    ${sql} COMMIT;`;
}
function identity(runId, admissionId) {
  return JSON.stringify({ workspaceId: ws, ...(admissionId ? { admissionId } : {}), runId });
}

describe('Discovery company materialization C3 functions', { concurrency: false }, () => {
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
    assert.equal(ready >= 2, true);
    docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres',
      '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: `CREATE ROLE global LOGIN SUPERUSER;
      CREATE DATABASE ${database} OWNER global;` });
    const directories = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name <= target)
      .map((entry) => entry.name).sort();
    assert.equal(directories.at(-1), target);
    for (const directory of directories) {
      const migration = await readFile(resolve(migrationsRoot, directory, 'migration.sql'), 'utf8');
      const explicit = /(^|\n)\s*BEGIN\s*;/iu.test(migration);
      const sql = explicit ? migration : `BEGIN;\n${migration}\nCOMMIT;`;
      try { psql(sql); } catch (error) { throw new Error(`migration ${directory} failed`, { cause: error }); }
    }
  });

  after(() => { spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' }); });

  it('uses one inaccessible BYPASSRLS Raw helper and ordinary public owners', () => {
    const rows = psql(`SELECT proname||'|'||pg_get_userbyid(proowner)||'|'||r.rolbypassrls::text
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE proname LIKE '%discovery_company_materialization%'
      ORDER BY proname;`).split('\n');
    const rawHelper = rows.find((row) => row.startsWith('_discovery_company_materialization_lock_raw_fact_v1|'));
    assert.equal(rawHelper,
      '_discovery_company_materialization_lock_raw_fact_v1|discovery_materialization_fact_reader|true');
    for (const name of ['admit','inspect','lock','append','finalize']) {
      for (const row of rows.filter((candidate) => candidate.startsWith(`${name}_discovery_company_materialization`))) {
        assert.match(row, /\|discovery_materialization_function_owner\|false$/u);
      }
    }
    assert.equal(psql(`SELECT has_function_privilege('app_user',
      '_discovery_company_materialization_lock_raw_fact_v1(uuid,uuid)','EXECUTE')::text`), 'false');
    assert.equal(psql(`SELECT count(*) FROM pg_auth_members membership
      WHERE membership.roleid IN('discovery_materialization_fact_reader'::regrole,
        'discovery_materialization_function_owner'::regrole)
         OR membership.member IN('discovery_materialization_fact_reader'::regrole,
        'discovery_materialization_function_owner'::regrole)`), '0');
    const helper = psql(`SELECT pg_get_functiondef(
      '_discovery_company_materialization_lock_raw_fact_v1(uuid,uuid)'::regprocedure)`);
    assert.match(helper, /raw_source_record/u);
    assert.match(helper, /raw_source_governance_disposition/u);
    assert.doesNotMatch(helper, /governed_subject_relation|attest_workspace|append_workspace/u);
  });

  it('admits and replays pre-C legacy while v1 stays unavailable before activation', () => {
    psql(`INSERT INTO workspace(id,name,created_at,updated_at) VALUES
      ('${ws}','C3',now(),now()),('${otherWs}','C3 other',now(),now());
      SET session_replication_role=replica;
      INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status,materialization_contract_version)
      VALUES('${legacyRun}','${ws}','${plan}','${icp}','RUNNING',NULL),
        ('${governedRun}','${ws}','${plan}','${icp}','RUNNING','discovery-company-materialization/v1');
      SET session_replication_role=origin;`);
    const first = psql(app(`SELECT status||'|'||mode||'|'||admission_id::text
      FROM admit_discovery_company_materialization_v1('${identity(legacyRun)}'::jsonb);`)).split('\n').at(-1);
    const [status, mode, admissionId] = first.split('|');
    assert.equal(`${status}|${mode}`, 'APPLIED|LEGACY');
    assert.equal(psql(app(`SELECT status||'|'||mode||'|'||admission_id::text
      FROM admit_discovery_company_materialization_v1('${identity(legacyRun)}'::jsonb);`)).split('\n').at(-1),
    `REPLAYED|LEGACY|${admissionId}`);
    psql(app(`SELECT * FROM admit_discovery_company_materialization_v1(
      '${identity(governedRun)}'::jsonb);`), { rejects: /UNAVAILABLE/u });
    assert.equal(psql(`SELECT count(*) FROM discovery_company_materialization_admission
      WHERE run_id='${governedRun}'`), '0');
  });

  it('activates once and completes zero-query governed materialization with replay', () => {
    psql(`SET session_replication_role=replica;
      INSERT INTO discovery_query_plan(id,workspace_id,icp_id,status,queries,updated_at)
      VALUES('${plan}','${ws}','${icp}','READY','[]',now());
      SET session_replication_role=origin;
      BEGIN;SELECT set_config('app.discovery_company_materialization_activation_v1','${contract}',true);
      INSERT INTO discovery_company_materialization_activation VALUES
        (1,'discovery-company-materialization/v1','${contract}',clock_timestamp());COMMIT;`);
    const admitted = psql(app(`SELECT status||'|'||mode||'|'||admission_id::text
      FROM admit_discovery_company_materialization_v1('${identity(governedRun)}'::jsonb);`)).split('\n').at(-1);
    const admissionId = admitted.split('|')[2];
    assert.match(admitted, /^APPLIED\|GOVERNED_C_TX\|/u);
    assert.equal(psql(app(`SELECT status||'|'||(next_work->>'kind')
      FROM inspect_discovery_company_materialization_v1(
      '${identity(governedRun, admissionId)}'::jsonb);`)).split('\n').at(-1), 'NOT_FOUND|FINALIZE_RUN');
    assert.equal(psql(app(`SELECT status||'|'||companies||'|'||suppressed
      FROM finalize_discovery_company_materialization_run_v1(
      '${identity(governedRun, admissionId)}'::jsonb);`)).split('\n').at(-1), 'APPLIED|0|0');
    assert.equal(psql(app(`SELECT status||'|'||companies||'|'||suppressed
      FROM finalize_discovery_company_materialization_run_v1(
      '${identity(governedRun, admissionId)}'::jsonb);`)).split('\n').at(-1), 'REPLAYED|0|0');
    assert.equal(psql(app(`SELECT status||'|'||(run_summary->>'companies')||'|'||
      (run_summary->>'suppressed') FROM inspect_discovery_company_materialization_v1(
      '${identity(governedRun, admissionId)}'::jsonb);`)).split('\n').at(-1), 'REPLAYED|0|0');
  });

  it('locks exact governed Q/A/Raw facts, appends one terminal batch, finalizes and replays', () => {
    const run = '20000000-0000-4000-8000-000000000010';
    const qPlan = '30000000-0000-4000-8000-000000000010';
    const query = 'a'.repeat(64);
    const sha = 'b'.repeat(64);
    const authority = '50000000-0000-4000-8000-000000000010';
    const account = '51000000-0000-4000-8000-000000000010';
    const operation = '52000000-0000-4000-8000-000000000010';
    const raw = '53000000-0000-4000-8000-000000000010';
    const item = '54000000-0000-4000-8000-000000000010';
    psql(`SET session_replication_role=replica;
      INSERT INTO discovery_query_plan(id,workspace_id,icp_id,status,queries,updated_at)
      VALUES('${qPlan}','${ws}','${icp}','READY','[{"source":"public_web"}]',now());
      INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status,materialization_contract_version)
      VALUES('${run}','${ws}','${qPlan}','${icp}','RUNNING','discovery-company-materialization/v1');
      INSERT INTO raw_source_record(id,workspace_id,run_id,provider_key,source_class,payload,
        ingest_key,payload_hash,payload_bytes,ingest_version,ingest_status,disposition_code,
        retention_days,expires_at,source_policy_snapshot)
      VALUES('${raw}','${ws}','${run}','public_web','public_intelligence',
        '{"name":"must-not-leak"}','external:c3','${sha}',24,'raw-source/v2','QUARANTINED',
        'governance.quarantined',30,now()+interval '30 days','{}');
      SET session_replication_role=origin;
      INSERT INTO execution_budget_authority(id,scope_key,authority_kind,workspace_id,issuer,audience,jti,
        token_sha256,schema_version,purpose,subject_type,subject_id,request_sha256,currency,unit,
        cap_microusd,runs_consumed,issued_at,not_before,expires_at,consumed_at)
      VALUES('${authority}','${ws}','WORKSPACE_GRANT','${ws}','https://c3.test',
        'global-backend:execution-budget','55000000-0000-4000-8000-000000000010',repeat('5',64),
        'execution-budget-grant/v1','discovery.run','discovery_run','request:${sha}','${sha}',
        'USD','microusd',1000,1,now()-interval '30 seconds',now()-interval '20 seconds',
        now()+interval '4 minutes',now()-interval '10 seconds');
      INSERT INTO tool_budget_account(id,scope_key,account_key,generation,cap_cents,reserved_cents,
        charged_cents,exhausted,ref_count,authority_id,authorized_cap_microusd,reserved_microusd,
        charged_microusd,created_at,updated_at)
      VALUES('${account}','${ws}','discovery.run:discovery_run:request:${sha}:${sha}',1,
        0,0,0,false,1,'${authority}',1000,0,50,now(),now());
      DO $seed$ DECLARE base jsonb; projection jsonb; result_digest text; usage jsonb;
      BEGIN
        base:=jsonb_build_object('schemaVersion','generic-operation-projection/v1','kind','model',
          'schema','discovery-extract-company/v1','data',jsonb_build_object('companies','[]'::jsonb));
        result_digest:=generic_operation_projection_digest(base);
        projection:=base||jsonb_build_object('digest',result_digest);
        usage:=jsonb_build_object('currency','USD','unit','microusd','callCount',1,
          'upperBoundMicrousd','100');
        INSERT INTO tool_budget_operation(id,scope_key,account_id,generation,operation_key,amount_unit,
          reserved_cents,reserved_microusd,observed_microusd,charged_microusd,result_schema_version,
          result_schema,result_digest,result_json,status,receipt_usage,receipt_cost_basis,settled_at,created_at)
        VALUES('${operation}','${ws}','${account}',1,'c3-operation','microusd',0,100,50,50,
          'generic-operation-projection/v1','discovery-extract-company/v1',result_digest,projection,
          'SETTLED',usage,'estimated_upper_bound',now(),now());
      END $seed$;`);
    psql(app(`SELECT status FROM apply_execution_domain_ack_v1('${ws}','${operation}',
      'PublicWebDiscoveryProvider.mineDomain','RawSourceRecord','${'6'.repeat(64)}','${'7'.repeat(64)}');`));
    psql(`DO $q$ DECLARE ack text; result text; relation record;
      BEGIN
        SELECT a.ack_id,o.result_digest INTO ack,result FROM execution_domain_ack a
          JOIN tool_budget_operation o ON o.id=a.operation_id WHERE a.operation_id='${operation}';
        INSERT INTO discovery_query_receipt(workspace_id,run_id,plan_id,authority_id,account_key,
          purpose,subject_type,subject_id,request_sha256,query_key,query_ordinal,source_class,
          providers,provider_count,record_count,accepted_count,quarantined_count,rejected_count,
          duplicate_count,governance_denied_count,usage_quantity,cost_cents,contract_sha256)
        VALUES('${ws}','${run}','${qPlan}','${authority}',
          'discovery.run:discovery_run:request:${sha}:${sha}','discovery.run','discovery_run',
          'request:${sha}','${sha}','${query}',0,'public_intelligence','["public_web"]',1,
          1,0,1,0,0,1,0,0,'${qContract}');
        INSERT INTO discovery_query_execution_outcome(workspace_id,run_id,query_key,budget_truncated,
          contract_sha256) VALUES('${ws}','${run}','${query}',false,'${qContract}');
        INSERT INTO discovery_query_operation_attempt(workspace_id,run_id,query_key,provider_key,
          producer_id,operation_id,scope_key,authority_id,account_id,operation_generation,ack_id,
          consumer,domain_aggregate_type,domain_ack_key,domain_revision,result_digest,result_schema,
          lineage_schema,provider_record_count,covered_item_count,contract_sha256)
        VALUES('${ws}','${run}','${query}','public_web','discovery.extract_company','${operation}',
          '${ws}','${authority}','${account}',1,ack,'PublicWebDiscoveryProvider.mineDomain',
          'RawSourceRecord','${'6'.repeat(64)}','${'7'.repeat(64)}',result,
          'discovery-extract-company/v1','discovery-company-result-lineage/v1',1,1,'${qContract}');
        SET LOCAL SESSION AUTHORIZATION app_user;
        PERFORM set_config('app.current_workspace_id','${ws}',true);
        SELECT * INTO STRICT relation FROM append_workspace_governed_child_relation_v1(
          '${ws}','${authority}','${account}','${operation}',1,ack,result,
          'tool_operation','${operation}','NON_PERSONAL',NULL,NULL,NULL,'raw_source_record','${raw}',
          'NON_PERSONAL',NULL,NULL,'discovery.raw_source_record:0','MATERIALIZED_CHILD',
          'discovery_query_attempt_item','${item}',NULL,'${aContract}');
        RESET SESSION AUTHORIZATION;
        INSERT INTO discovery_query_attempt_item(id,workspace_id,run_id,query_key,provider_key,
          operation_id,record_index,resolution_kind,raw_record_id,raw_payload_hash,raw_ingest_status,
          relation_key,operation_subject_id,child_subject_id,relation_id,contract_sha256)
        VALUES('${item}','${ws}','${run}','${query}','public_web','${operation}',0,'INSERTED',
          '${raw}','${sha}','QUARANTINED','discovery.raw_source_record:0',relation.operation_subject_id,
          relation.child_subject_id,relation.relation_id,'${aContract}');
      END $q$;`);
    const admitted = psql(app(`SELECT admission_id::text FROM admit_discovery_company_materialization_v1(
      '${identity(run)}'::jsonb);`)).split('\n').at(-1);
    const lookup = JSON.stringify({ workspaceId: ws, admissionId: admitted, runId: run,
      queryKey: query, batchOrdinal: 0 });
    const factsOnly = app(`SELECT status FROM lock_discovery_company_materialization_batch_facts_v1(
      '${lookup}'::jsonb);`);
    psql(factsOnly, { rejects: /INCOMPLETE_HOLD/u });
    psql(app(`DO $batch$ DECLARE f record; command jsonb; item_command jsonb;
      item_key text; item_set_sha text;
      BEGIN
        SELECT * INTO STRICT f FROM lock_discovery_company_materialization_batch_facts_v1(
          '${lookup}'::jsonb);
        IF f.facts::text LIKE '%must-not-leak%' THEN RAISE EXCEPTION 'restricted payload leaked'; END IF;
        item_command:=jsonb_build_object('contractSha256','${contract}','queryKey','${query}',
          'outcome','RAW_QUARANTINED','queryItemId','${item}',
          'queryOrdinal',0,'providerKey','public_web','operationId','${operation}',
          'recordIndex',0,'rawRecordId','${raw}',
          'rawGovernedSubjectId',f.facts->0->'qItem'->>'rawGovernedSubjectId',
          'qRelationId',f.facts->0->'qItem'->>'qRelationId','qIngestStatus','QUARANTINED',
          'canonicalCompanyId',NULL,'identityLinkId',NULL,'identityCanonicalType',NULL,
          'canonicalGovernedSubjectId',NULL,'cRelationId',NULL,'cRelationKey',NULL,
          'matchRule',NULL,'confidence',NULL,'mutationClass',NULL,'evidenceCount',NULL,
          'evidenceManifestSha256',NULL,'restrictedDispositionId',NULL,
          'suppressionMatchSha256',NULL,'suppressionMatchCount',NULL,'rawExpiredAt',NULL,
          'notCanonicalizableReasonCode',NULL,'suppressionRecordIds','[]'::jsonb);
        item_key:='public_web:0:${raw}:${item}';
        item_set_sha:=encode(digest(convert_to('['||to_json(item_key)::text||']','UTF8'),'sha256'),'hex');
        command:=jsonb_build_object('schemaVersion','discovery-company-materialization-append/v1',
          'workspaceId','${ws}','admissionId','${admitted}','runId','${run}',
          'queryKey','${query}','batchOrdinal',0,'fenceId',f.fence_id,
          'snapshotSha256',f.snapshot_sha256,'suppressionSnapshotCount',
          f.facts->0->'lockedFacts'->>'suppressionSnapshotCount',
          'suppressionSnapshotSha256',f.snapshot_sha256,'firstItemKey',item_key,
          'lastItemKey',item_key,'itemSetSha256',item_set_sha,
          'items',jsonb_build_array(item_command));
        PERFORM * FROM append_discovery_company_materialization_batch_v1(command);
      END $batch$;`));
    assert.equal(psql(app(`SELECT status FROM append_discovery_company_materialization_batch_v1((
      SELECT jsonb_build_object('schemaVersion','discovery-company-materialization-append/v1',
        'workspaceId',o.workspace_id,'admissionId',o.admission_id,'runId',o.run_id,
        'queryKey',o.query_key,'batchOrdinal',o.batch_ordinal,
        'fenceId','59000000-0000-4000-8000-000000000010',
        'snapshotSha256','${sha}','suppressionSnapshotCount',0,
        'suppressionSnapshotSha256','${sha}','firstItemKey',b.first_item_key,'lastItemKey',b.last_item_key,
        'itemSetSha256',b.item_set_sha256,'items',jsonb_build_array(jsonb_build_object(
          'queryItemId',o.query_item_id,'queryKey',o.query_key,'queryOrdinal',o.query_ordinal,
          'providerKey',o.provider_key,'operationId',o.operation_id,'recordIndex',o.record_index,
          'rawRecordId',o.raw_record_id,'rawGovernedSubjectId',o.raw_governed_subject_id,
          'qRelationId',o.q_relation_id,'qIngestStatus',o.q_ingest_status,'outcome',o.outcome,
          'contractSha256',o.contract_sha256,'canonicalCompanyId',o.canonical_company_id,
          'identityLinkId',o.identity_link_id,'identityCanonicalType',o.identity_canonical_type,
          'canonicalGovernedSubjectId',NULL,'cRelationId',NULL,'cRelationKey',o.c_relation_key,
          'matchRule',o.match_rule,'confidence',o.confidence,'mutationClass',o.mutation_class,
          'evidenceCount',o.evidence_count,'evidenceManifestSha256',o.evidence_manifest_sha256,
          'restrictedDispositionId',o.restricted_disposition_id,
          'suppressionMatchSha256',o.suppression_match_sha256,
          'suppressionMatchCount',o.suppression_match_count,'rawExpiredAt',NULL,
          'notCanonicalizableReasonCode',o.not_canonicalizable_reason_code,
          'suppressionRecordIds','[]'::jsonb)))
      FROM discovery_company_materialization_outcome o
      JOIN discovery_company_materialization_batch_receipt b USING(workspace_id,run_id,query_key,batch_ordinal)
      WHERE o.query_item_id='${item}'));`)).split('\n').at(-1), 'REPLAYED');
    assert.equal(psql(app(`SELECT status FROM finalize_discovery_company_materialization_query_v1(
      '${lookup}'::jsonb);`)).split('\n').at(-1), 'APPLIED');
    assert.equal(psql(app(`SELECT status FROM finalize_discovery_company_materialization_query_v1(
      '${lookup}'::jsonb);`)).split('\n').at(-1), 'REPLAYED');
    psql(`SET session_replication_role=replica;
      UPDATE discovery_company_materialization_query_receipt
        SET outcome_raw_quarantined_count=0,outcome_raw_rejected_count=1
        WHERE workspace_id='${ws}' AND run_id='${run}' AND query_key='${query}';
      SET session_replication_role=origin;`);
    psql(app(`SELECT status FROM finalize_discovery_company_materialization_query_v1(
      '${lookup}'::jsonb);`), { rejects: /INCOMPLETE_HOLD/u });
    psql(`SET session_replication_role=replica;
      UPDATE discovery_company_materialization_query_receipt
        SET outcome_raw_quarantined_count=1,outcome_raw_rejected_count=0
        WHERE workspace_id='${ws}' AND run_id='${run}' AND query_key='${query}';
      SET session_replication_role=origin;`);
    assert.equal(psql(app(`SELECT status||'|'||companies||'|'||suppressed FROM
      finalize_discovery_company_materialization_run_v1(
      '${identity(run, admitted)}'::jsonb);`)).split('\n').at(-1), 'APPLIED|0|0');
    assert.equal(psql(app(`SELECT status FROM inspect_discovery_company_materialization_v1(
      '${identity(run, admitted)}'::jsonb);`)).split('\n').at(-1), 'REPLAYED');
    assert.equal(psql(`SELECT outcome FROM discovery_company_materialization_outcome
      WHERE query_item_id='${item}'`), 'RAW_QUARANTINED');
  });

  it('validates same-transaction Canonical, Identity, Evidence and lets only A allocate C identities', () => {
    const run = '20000000-0000-4000-8000-000000000011';
    const qPlan = '30000000-0000-4000-8000-000000000011';
    const query = 'c'.repeat(64);
    const query2 = 'e'.repeat(64);
    const sha = 'd'.repeat(64);
    const authority = '50000000-0000-4000-8000-000000000010';
    const account = '51000000-0000-4000-8000-000000000010';
    const operation = '52000000-0000-4000-8000-000000000011';
    const operation2 = '52000000-0000-4000-8000-000000000012';
    const raw = '53000000-0000-4000-8000-000000000011';
    const item = '54000000-0000-4000-8000-000000000011';
    const item2 = '54000000-0000-4000-8000-000000000012';
    const company = '56000000-0000-4000-8000-000000000011';
    const link = '57000000-0000-4000-8000-000000000011';
    const evidence = '58000000-0000-4000-8000-000000000011';
    const suppression = '59000000-0000-4000-8000-000000000011';
    psql(`SET session_replication_role=replica;
      INSERT INTO discovery_query_plan(id,workspace_id,icp_id,status,queries,updated_at)
      VALUES('${qPlan}','${ws}','${icp}','READY',
        '[{"source":"public_web"},{"source":"public_web"}]',now());
      INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status,materialization_contract_version)
      VALUES('${run}','${ws}','${qPlan}','${icp}','RUNNING','discovery-company-materialization/v1');
      INSERT INTO raw_source_record(id,workspace_id,run_id,provider_key,source_class,payload,
        source_url,fetched_at,content_hash,parser_version,ingest_key,payload_hash,payload_bytes,
        ingest_version,ingest_status,retention_days,expires_at,source_policy_snapshot)
      VALUES('${raw}','${ws}','${run}','public_web','public_intelligence',
        '{"name":"C3 Pumps","domain":"c3.example"}','https://c3.example',now(),'${sha}',
        'public-web/v1','external:c3-accepted','${sha}',48,'raw-source/v2','ACCEPTED',30,
        now()+interval '30 days','{}');SET session_replication_role=origin;
      DO $seed$ DECLARE base jsonb; projection jsonb; result_digest text; usage jsonb;
      BEGIN base:=jsonb_build_object('schemaVersion','generic-operation-projection/v1','kind','model',
        'schema','discovery-extract-company/v1','data',jsonb_build_object('companies','[]'::jsonb));
        result_digest:=generic_operation_projection_digest(base);
        projection:=base||jsonb_build_object('digest',result_digest);
        usage:=jsonb_build_object('currency','USD','unit','microusd','callCount',1,
          'upperBoundMicrousd','100');
        INSERT INTO tool_budget_operation(id,scope_key,account_id,generation,operation_key,amount_unit,
          reserved_cents,reserved_microusd,observed_microusd,charged_microusd,result_schema_version,
          result_schema,result_digest,result_json,status,receipt_usage,receipt_cost_basis,settled_at,created_at)
        VALUES('${operation}','${ws}','${account}',1,'c3-operation-accepted','microusd',0,100,50,50,
          'generic-operation-projection/v1','discovery-extract-company/v1',result_digest,projection,
          'SETTLED',usage,'estimated_upper_bound',now(),now()),
        ('${operation2}','${ws}','${account}',1,'c3-operation-reuse','microusd',0,100,50,50,
          'generic-operation-projection/v1','discovery-extract-company/v1',result_digest,projection,
          'SETTLED',usage,'estimated_upper_bound',now(),now());END $seed$;`);
    psql(app(`SELECT status FROM apply_execution_domain_ack_v1('${ws}','${operation}',
      'PublicWebDiscoveryProvider.mineDomain','RawSourceRecord','${'8'.repeat(64)}','${'9'.repeat(64)}');`));
    psql(app(`SELECT status FROM apply_execution_domain_ack_v1('${ws}','${operation2}',
      'PublicWebDiscoveryProvider.mineDomain','RawSourceRecord','${'a'.repeat(64)}','${'f'.repeat(64)}');`));
    psql(`DO $q$ DECLARE ack text; result text; relation record;
      BEGIN SELECT a.ack_id,o.result_digest INTO ack,result FROM execution_domain_ack a
        JOIN tool_budget_operation o ON o.id=a.operation_id WHERE a.operation_id='${operation}';
        INSERT INTO discovery_query_receipt(workspace_id,run_id,plan_id,authority_id,account_key,
          purpose,subject_type,subject_id,request_sha256,query_key,query_ordinal,source_class,
          providers,provider_count,record_count,accepted_count,quarantined_count,rejected_count,
          duplicate_count,governance_denied_count,usage_quantity,cost_cents,contract_sha256)
        VALUES('${ws}','${run}','${qPlan}','${authority}',
          'discovery.run:discovery_run:request:${'b'.repeat(64)}:${'b'.repeat(64)}','discovery.run',
          'discovery_run','request:${'b'.repeat(64)}','${'b'.repeat(64)}','${query}',0,
          'public_intelligence','["public_web"]',1,1,1,0,0,0,0,1,0,'${qContract}');
        INSERT INTO discovery_query_execution_outcome VALUES('${ws}','${run}','${query}',false,
          '${qContract}',clock_timestamp());
        INSERT INTO discovery_query_operation_attempt(workspace_id,run_id,query_key,provider_key,
          producer_id,operation_id,scope_key,authority_id,account_id,operation_generation,ack_id,
          consumer,domain_aggregate_type,domain_ack_key,domain_revision,result_digest,result_schema,
          lineage_schema,provider_record_count,covered_item_count,contract_sha256)
        VALUES('${ws}','${run}','${query}','public_web','discovery.extract_company','${operation}',
          '${ws}','${authority}','${account}',1,ack,'PublicWebDiscoveryProvider.mineDomain',
          'RawSourceRecord','${'8'.repeat(64)}','${'9'.repeat(64)}',result,
          'discovery-extract-company/v1','discovery-company-result-lineage/v1',1,1,'${qContract}');
        SET LOCAL SESSION AUTHORIZATION app_user;PERFORM set_config('app.current_workspace_id','${ws}',true);
        SELECT * INTO STRICT relation FROM append_workspace_governed_child_relation_v1(
          '${ws}','${authority}','${account}','${operation}',1,ack,result,'tool_operation',
          '${operation}','NON_PERSONAL',NULL,NULL,NULL,'raw_source_record','${raw}','NON_PERSONAL',
          NULL,NULL,'discovery.raw_source_record:0','MATERIALIZED_CHILD',
          'discovery_query_attempt_item','${item}',NULL,'${aContract}');RESET SESSION AUTHORIZATION;
        INSERT INTO discovery_query_attempt_item(id,workspace_id,run_id,query_key,provider_key,
          operation_id,record_index,resolution_kind,raw_record_id,raw_payload_hash,raw_ingest_status,
          relation_key,operation_subject_id,child_subject_id,relation_id,contract_sha256)
        VALUES('${item}','${ws}','${run}','${query}','public_web','${operation}',0,'INSERTED',
          '${raw}','${sha}','ACCEPTED','discovery.raw_source_record:0',relation.operation_subject_id,
          relation.child_subject_id,relation.relation_id,'${aContract}');END $q$;`);
    psql(`DO $q$ DECLARE ack text; result text; relation record;
      BEGIN SELECT a.ack_id,o.result_digest INTO ack,result FROM execution_domain_ack a
        JOIN tool_budget_operation o ON o.id=a.operation_id WHERE a.operation_id='${operation2}';
        INSERT INTO discovery_query_receipt(workspace_id,run_id,plan_id,authority_id,account_key,
          purpose,subject_type,subject_id,request_sha256,query_key,query_ordinal,source_class,
          providers,provider_count,record_count,accepted_count,quarantined_count,rejected_count,
          duplicate_count,governance_denied_count,usage_quantity,cost_cents,contract_sha256)
        VALUES('${ws}','${run}','${qPlan}','${authority}',
          'discovery.run:discovery_run:request:${'b'.repeat(64)}:${'b'.repeat(64)}','discovery.run',
          'discovery_run','request:${'b'.repeat(64)}','${'b'.repeat(64)}','${query2}',1,
          'public_intelligence','["public_web"]',1,1,0,0,0,1,0,0,0,'${qContract}');
        INSERT INTO discovery_query_execution_outcome VALUES('${ws}','${run}','${query2}',false,
          '${qContract}',clock_timestamp());
        INSERT INTO discovery_query_operation_attempt(workspace_id,run_id,query_key,provider_key,
          producer_id,operation_id,scope_key,authority_id,account_id,operation_generation,ack_id,
          consumer,domain_aggregate_type,domain_ack_key,domain_revision,result_digest,result_schema,
          lineage_schema,provider_record_count,covered_item_count,contract_sha256)
        VALUES('${ws}','${run}','${query2}','public_web','discovery.extract_company','${operation2}',
          '${ws}','${authority}','${account}',1,ack,'PublicWebDiscoveryProvider.mineDomain',
          'RawSourceRecord','${'a'.repeat(64)}','${'f'.repeat(64)}',result,
          'discovery-extract-company/v1','discovery-company-result-lineage/v1',1,1,'${qContract}');
        SET LOCAL SESSION AUTHORIZATION app_user;PERFORM set_config('app.current_workspace_id','${ws}',true);
        SELECT * INTO STRICT relation FROM append_workspace_governed_child_relation_v1(
          '${ws}','${authority}','${account}','${operation2}',1,ack,result,'tool_operation',
          '${operation2}','NON_PERSONAL',NULL,NULL,NULL,'raw_source_record','${raw}','NON_PERSONAL',
          NULL,NULL,'discovery.raw_source_record:0','MATERIALIZED_CHILD',
          'discovery_query_attempt_item','${item2}',NULL,'${aContract}');RESET SESSION AUTHORIZATION;
        INSERT INTO discovery_query_attempt_item(id,workspace_id,run_id,query_key,provider_key,
          operation_id,record_index,resolution_kind,raw_record_id,raw_payload_hash,raw_ingest_status,
          relation_key,operation_subject_id,child_subject_id,relation_id,contract_sha256)
        VALUES('${item2}','${ws}','${run}','${query2}','public_web','${operation2}',0,'EXISTING',
          '${raw}','${sha}','ACCEPTED','discovery.raw_source_record:0',relation.operation_subject_id,
          relation.child_subject_id,relation.relation_id,'${aContract}');END $q$;`);
    const admission = psql(app(`SELECT admission_id::text FROM admit_discovery_company_materialization_v1(
      '${identity(run)}'::jsonb);`)).split('\n').at(-1);
    const lookup = JSON.stringify({ workspaceId: ws, admissionId: admission, runId: run,
      queryKey: query, batchOrdinal: 0 });
    psql(`INSERT INTO suppression_record(id,workspace_id,type,value,reason,protection_class,created_at)
      VALUES('${suppression}','${ws}','domain','https://www.C3.example/path','c3-snapshot','LEGAL',now());
      INSERT INTO suppression_record(id,workspace_id,type,value,reason,protection_class,created_at)
      SELECT gen_random_uuid(),'${ws}','domain','unrelated-'||ordinal||'.example',
        'c3-snapshot','LEGAL',now() FROM generate_series(1,65) ordinal;`);
    psql(`SET SESSION AUTHORIZATION app_user;BEGIN;
      SELECT set_config('app.current_workspace_id','${ws}',true);
      DO $suppressed$ DECLARE f record; command jsonb; item_command jsonb; forged jsonb;
        item_key text; item_set_sha text; suppression_snapshot jsonb;
        suppression_ids jsonb; suppression_sha text;
      BEGIN SELECT * INTO STRICT f FROM lock_discovery_company_materialization_batch_facts_v1(
        '${lookup}'::jsonb);
        suppression_snapshot:=jsonb_build_object('count',
          f.facts->0->'lockedFacts'->'suppressionSnapshotCount','sha256',
          f.facts->0->'lockedFacts'->'suppressionSnapshotSha256');
        IF suppression_snapshot->>'count'<>'66'
          OR suppression_snapshot->>'sha256' !~ '^[0-9a-f]{64}$'
          THEN RAISE EXCEPTION 'suppression exact set mismatch'; END IF;
        SELECT jsonb_agg(id::TEXT ORDER BY id) INTO suppression_ids
          FROM suppression_record WHERE workspace_id='${ws}'
            AND type IN('domain','company_name') AND id='${suppression}';
        suppression_sha:=encode(digest(convert_to(suppression_ids::text,'UTF8'),'sha256'),'hex');
        item_command:=jsonb_build_object('queryItemId','${item}','queryKey','${query}',
          'queryOrdinal',0,'providerKey','public_web','operationId','${operation}','recordIndex',0,
          'rawRecordId','${raw}','rawGovernedSubjectId',f.facts->0->'qItem'->>'rawGovernedSubjectId',
          'qRelationId',f.facts->0->'qItem'->>'qRelationId','qIngestStatus','ACCEPTED',
          'outcome','SUPPRESSED','contractSha256','${contract}','canonicalCompanyId',NULL,
          'identityLinkId',NULL,'identityCanonicalType',NULL,'canonicalGovernedSubjectId',NULL,
          'cRelationId',NULL,'cRelationKey',NULL,'matchRule',NULL,'confidence',NULL,
          'mutationClass',NULL,'evidenceCount',NULL,'evidenceManifestSha256',NULL,
          'restrictedDispositionId',NULL,'suppressionMatchSha256',suppression_sha,
          'suppressionMatchCount',1,'rawExpiredAt',NULL,'notCanonicalizableReasonCode',NULL,
          'suppressionRecordIds',suppression_ids);
        item_key:='public_web:0:${raw}:${item}';
        item_set_sha:=encode(digest(convert_to('['||to_json(item_key)::text||']','UTF8'),'sha256'),'hex');
        command:=jsonb_build_object('schemaVersion','discovery-company-materialization-append/v1',
          'workspaceId','${ws}','admissionId','${admission}','runId','${run}',
          'queryKey','${query}','batchOrdinal',0,'fenceId',f.fence_id,
          'snapshotSha256',f.snapshot_sha256,'suppressionSnapshotCount',
          f.facts->0->'lockedFacts'->>'suppressionSnapshotCount',
          'suppressionSnapshotSha256',f.snapshot_sha256,
          'firstItemKey',item_key,'lastItemKey',item_key,
          'itemSetSha256',item_set_sha,'items',jsonb_build_array(item_command));
        forged:=jsonb_set(command,'{items,0,outcome}','"RESTRICTED_PROCESSING"'::jsonb);
        BEGIN PERFORM * FROM append_discovery_company_materialization_batch_v1(forged);
          RAISE EXCEPTION 'forged restricted accepted' USING ERRCODE='XX000';
        EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL; END;
        forged:=jsonb_set(command,'{items,0,outcome}','"EXPIRED_BEFORE_CANONICALIZATION"'::jsonb);
        BEGIN PERFORM * FROM append_discovery_company_materialization_batch_v1(forged);
          RAISE EXCEPTION 'forged expired accepted' USING ERRCODE='XX000';
        EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL; END;
        PERFORM * FROM append_discovery_company_materialization_batch_v1(command);
      END $suppressed$;ROLLBACK;RESET SESSION AUTHORIZATION;`);
    assert.equal(psql(`SELECT count(*) FROM discovery_company_materialization_outcome
      WHERE query_item_id='${item}'`), '0');
    psql(`DELETE FROM suppression_record WHERE workspace_id='${ws}' AND reason='c3-snapshot';`);
    psql(app(`DO $batch$ DECLARE f record; command jsonb; item_command jsonb;
      item_key text; item_set_sha text; evidence_sha text;
      BEGIN SELECT * INTO STRICT f FROM lock_discovery_company_materialization_batch_facts_v1(
        '${lookup}'::jsonb);
        INSERT INTO canonical_company(id,workspace_id,name,domain,status,dedupe_key,version,created_at,updated_at)
        VALUES('${company}','${ws}','C3 Pumps','c3.example','NEW','domain:c3.example',1,now(),now());
        INSERT INTO identity_link(id,workspace_id,canonical_type,canonical_id,raw_record_id,match_rule,
          confidence,created_at) VALUES('${link}','${ws}','company','${company}','${raw}',
          'domain_exact',1,now());
        INSERT INTO field_evidence(id,workspace_id,entity_type,entity_id,field,value,provider_key,
          raw_record_id,confidence,license,allowed_actions,data_class,fetched_at)
        VALUES('${evidence}','${ws}','company','${company}','name','"C3 Pumps"','public_web',
          '${raw}',1,'public','["display","match"]','green',now());
        SELECT encode(digest(convert_to(coalesce(jsonb_agg(jsonb_build_array(e.field,e.id,
          encode(digest(e.value::text,'sha256'),'hex'),e.provider_key,e.license,
          encode(digest(coalesce(e.allowed_actions,'null'::jsonb)::text,'sha256'),'hex'))
          ORDER BY e.field,e.id),'[]'::jsonb)::text,'UTF8'),'sha256'),'hex') INTO evidence_sha
          FROM field_evidence e WHERE e.workspace_id='${ws}' AND e.entity_type='company'
            AND e.entity_id='${company}' AND e.raw_record_id='${raw}';
        item_command:=jsonb_build_object('queryItemId','${item}','queryKey','${query}',
          'queryOrdinal',0,'providerKey','public_web','operationId','${operation}','recordIndex',0,
          'rawRecordId','${raw}','rawGovernedSubjectId',f.facts->0->'qItem'->>'rawGovernedSubjectId',
          'qRelationId',f.facts->0->'qItem'->>'qRelationId','qIngestStatus','ACCEPTED',
          'outcome','CANONICALIZED','contractSha256','${contract}','canonicalCompanyId','${company}',
          'identityLinkId','${link}','identityCanonicalType','company',
          'canonicalGovernedSubjectId',NULL,'cRelationId',NULL,
          'cRelationKey','discovery.canonical_company:0','matchRule','domain_exact','confidence',1,
          'mutationClass','CREATED','evidenceCount',1,'evidenceManifestSha256',evidence_sha,
          'restrictedDispositionId',NULL,'suppressionMatchSha256',NULL,'suppressionMatchCount',NULL,
          'rawExpiredAt',NULL,'notCanonicalizableReasonCode',NULL,
          'suppressionRecordIds','[]'::jsonb);
        item_key:='public_web:0:${raw}:${item}';
        item_set_sha:=encode(digest(convert_to('['||to_json(item_key)::text||']','UTF8'),'sha256'),'hex');
        command:=jsonb_build_object('schemaVersion','discovery-company-materialization-append/v1',
          'workspaceId','${ws}','admissionId','${admission}','runId','${run}',
          'queryKey','${query}','batchOrdinal',0,'fenceId',f.fence_id,
          'snapshotSha256',f.snapshot_sha256,'suppressionSnapshotCount',
          f.facts->0->'lockedFacts'->>'suppressionSnapshotCount',
          'suppressionSnapshotSha256',f.snapshot_sha256,
          'firstItemKey',item_key,'lastItemKey',item_key,
          'itemSetSha256',item_set_sha,'items',jsonb_build_array(item_command));
        PERFORM * FROM append_discovery_company_materialization_batch_v1(command);END $batch$;`));
    const stored = psql(`SELECT concat_ws('|',outcome,canonical_governed_subject_id,c_relation_id,
      evidence_count,evidence_manifest_sha256) FROM discovery_company_materialization_outcome
      WHERE query_item_id='${item}'`).split('|');
    assert.equal(stored[0], 'CANONICALIZED');
    assert.match(stored[1], /^[0-9a-f-]{36}$/u);
    assert.match(stored[2], /^[0-9a-f-]{36}$/u);
    assert.equal(stored[3], '1');
    assert.match(stored[4], /^[0-9a-f]{64}$/u);
    assert.equal(psql(`SELECT count(*) FROM governed_subject_relation WHERE id='${stored[2]}'
      AND source_ref_uuid='${item}' AND relation_key='discovery.canonical_company:0'`), '1');
    assert.equal(psql(app(`SELECT status FROM finalize_discovery_company_materialization_query_v1(
      '${lookup}'::jsonb);`)).split('\n').at(-1), 'APPLIED');
    psql(`DELETE FROM field_evidence WHERE id='${evidence}';
      SET session_replication_role=replica;
      UPDATE raw_source_record SET ingest_status='EXPIRED',expired_at=now(),
        disposition_code='retention.expired',payload=jsonb_build_object(
          '_rawReceipt','raw-source/expired/v1','previousStatus','ACCEPTED',
          'payloadHash',payload_hash,'payloadBytes',payload_bytes)
      WHERE id='${raw}';SET session_replication_role=origin;`);
    const lookup2 = JSON.stringify({ workspaceId: ws, admissionId: admission, runId: run,
      queryKey: query2, batchOrdinal: 0 });
    psql(app(`DO $reuse$ DECLARE f record; command jsonb; item_command jsonb; forged jsonb;
      item_key text; item_set_sha text; prior record;
      BEGIN SELECT * INTO STRICT f FROM lock_discovery_company_materialization_batch_facts_v1(
        '${lookup2}'::jsonb);
        SELECT * INTO STRICT prior FROM discovery_company_materialization_outcome
          WHERE query_item_id='${item}';
        IF f.facts->0->'lockedFacts'->>'rawStatus'<>'EXPIRED'
          OR jsonb_array_length(f.facts->0->'reusableManifestCandidates')<>1
          THEN RAISE EXCEPTION 'reuse facts missing'; END IF;
        item_command:=jsonb_build_object('queryItemId','${item2}','queryKey','${query2}',
          'queryOrdinal',1,'providerKey','public_web','operationId','${operation2}','recordIndex',0,
          'rawRecordId','${raw}','rawGovernedSubjectId',f.facts->0->'qItem'->>'rawGovernedSubjectId',
          'qRelationId',f.facts->0->'qItem'->>'qRelationId','qIngestStatus','ACCEPTED',
          'outcome','CANONICALIZED','contractSha256','${contract}',
          'canonicalCompanyId',prior.canonical_company_id,'identityLinkId',prior.identity_link_id,
          'identityCanonicalType','company',
          'canonicalGovernedSubjectId',prior.canonical_governed_subject_id,'cRelationId',NULL,
          'cRelationKey','discovery.canonical_company:0','matchRule',prior.match_rule,
          'confidence',prior.confidence,'mutationClass','REUSED','evidenceCount',prior.evidence_count,
          'evidenceManifestSha256',prior.evidence_manifest_sha256,'restrictedDispositionId',NULL,
          'suppressionMatchSha256',NULL,'suppressionMatchCount',NULL,'rawExpiredAt',NULL,
          'notCanonicalizableReasonCode',NULL,'suppressionRecordIds','[]'::jsonb);
        item_key:='public_web:0:${raw}:${item2}';
        item_set_sha:=encode(digest(convert_to('['||to_json(item_key)::text||']','UTF8'),'sha256'),'hex');
        command:=jsonb_build_object('schemaVersion','discovery-company-materialization-append/v1',
          'workspaceId','${ws}','admissionId','${admission}','runId','${run}',
          'queryKey','${query2}','batchOrdinal',0,'fenceId',f.fence_id,
          'snapshotSha256',f.snapshot_sha256,'suppressionSnapshotCount',
          f.facts->0->'lockedFacts'->>'suppressionSnapshotCount',
          'suppressionSnapshotSha256',f.snapshot_sha256,
          'firstItemKey',item_key,'lastItemKey',item_key,
          'itemSetSha256',item_set_sha,'items',jsonb_build_array(item_command));
        forged:=jsonb_set(command,'{items,0,outcome}','"EXPIRED_BEFORE_CANONICALIZATION"'::jsonb);
        BEGIN PERFORM * FROM append_discovery_company_materialization_batch_v1(forged);
          RAISE EXCEPTION 'wrong expired timestamp accepted' USING ERRCODE='XX000';
        EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL; END;
        PERFORM * FROM append_discovery_company_materialization_batch_v1(command);END $reuse$;`));
    const reused = psql(`SELECT concat_ws('|',mutation_class,canonical_governed_subject_id,
      c_relation_id,evidence_count,evidence_manifest_sha256) FROM
      discovery_company_materialization_outcome WHERE query_item_id='${item2}'`).split('|');
    assert.equal(reused[0], 'REUSED');
    assert.equal(reused[1], stored[1]);
    assert.notEqual(reused[2], stored[2]);
    assert.equal(reused[3], stored[3]);
    assert.equal(reused[4], stored[4]);
    assert.equal(psql(`SELECT count(*) FROM field_evidence WHERE id='${evidence}'`), '0');
  });

  it('keeps fence and capability closed across direct, cross-workspace and facts-only attempts', () => {
    psql(app(`SELECT * FROM _discovery_company_materialization_lock_raw_fact_v1(
      '${ws}',gen_random_uuid());`), { rejects: /permission denied/u });
    psql(app(`SELECT * FROM inspect_discovery_company_materialization_v1(
      '${identity(governedRun, '40000000-0000-4000-8000-000000000099')}'::jsonb);`, otherWs),
    { rejects: /INVALID/u });
    for (const table of ['discovery_company_materialization_tx_fence']) {
      for (const verb of [`SELECT * FROM ${table}`, `DELETE FROM ${table}`]) {
        psql(app(`${verb};`), { rejects: /permission denied/u });
      }
    }
    const hostile = {
      schemaVersion: 'discovery-company-materialization-append/v1', workspaceId: 'not-a-uuid',
      admissionId: '40000000-0000-4000-8000-000000000099', runId: governedRun,
      queryKey: 'a'.repeat(64), batchOrdinal: 0,
      fenceId: '50000000-0000-4000-8000-000000000099', snapshotSha256: 'b'.repeat(64),
      suppressionSnapshotCount: 0, suppressionSnapshotSha256: 'b'.repeat(64),
      firstItemKey: 'a', lastItemKey: 'a', itemSetSha256: 'b'.repeat(64), items: [{}],
    };
    for (const command of [hostile, { ...hostile, workspaceId: ws, batchOrdinal: 9_999_999_999 }]) {
      const denied = psql(app(`SELECT * FROM append_discovery_company_materialization_batch_v1(
        '${JSON.stringify(command)}'::jsonb);`), { rejects: /MATERIALIZATION_INVALID/u });
      assert.doesNotMatch(`${denied.stderr}\n${denied.stdout}`, /22P02|22003|invalid input syntax|out of range/iu);
    }
  });
});
