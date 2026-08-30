import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { before, beforeEach, describe, it } from "node:test";

const CONTAINER = process.env.GOVERNED_RELATION_TASK2_PG_CONTAINER;
const DATABASE = process.env.GOVERNED_RELATION_TASK2_PG_DATABASE ?? "gsr_task2";
const APPEND = "append_workspace_governed_child_relation_v1";
const ATTEST = "attest_workspace_governed_child_relation_v1";
const WS = "13000000-0000-4000-8000-000000000001";
const AUTH = "23000000-0000-4000-8000-000000000001";
const ACCOUNT = "33000000-0000-4000-8000-000000000001";
const OP = "43000000-0000-4000-8000-000000000001";
const OP2 = "43000000-0000-4000-8000-000000000002";
const CONTRACT = "c".repeat(64);
let facts;
let rootId;

function dockerArgs() {
  assert.match(CONTAINER ?? "", /^codex-gsr-task2-pg-[a-z0-9-]+$/);
  assert.equal(DATABASE, "gsr_task2");
  return ["exec", "-i", CONTAINER, "psql", "-U", "global", "-d", DATABASE,
    "--no-psqlrc", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
}

function raw(sql) {
  return spawnSync("docker", dockerArgs(), {
    input: sql, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
}

function psql(sql) {
  const result = raw(sql);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

function asApp(sql, readOnly = false) {
  return `SET SESSION AUTHORIZATION app_user; BEGIN${readOnly ? " READ ONLY" : ""};
    SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='3s';
    SELECT set_config('app.current_workspace_id','${WS}',true); ${sql} COMMIT;`;
}

function deterministicUuid(namespace, value) {
  return `(substr(md5('${namespace}:'||(${value})::text),1,8)||'-'||
    substr(md5('${namespace}:'||(${value})::text),9,4)||'-4'||
    substr(md5('${namespace}:'||(${value})::text),14,3)||'-8'||
    substr(md5('${namespace}:'||(${value})::text),18,3)||'-'||
    substr(md5('${namespace}:'||(${value})::text),21,12))::uuid`;
}

function reset() {
  psql(`DELETE FROM governed_subject_tombstone_audit;
    DELETE FROM governed_subject_tombstone; DELETE FROM governed_subject_relation;
    DELETE FROM tool_operation_subject; DELETE FROM governed_subject;
    DELETE FROM generic_operation_artifact_subject_tombstone_audit;
    DELETE FROM generic_operation_artifact_subject_tombstone;
    DELETE FROM execution_domain_ack; DELETE FROM tool_budget_operation;
    DELETE FROM tool_budget_account; DELETE FROM execution_budget_authority_revocation;
    DELETE FROM execution_budget_authority; DELETE FROM workspace WHERE id='${WS}';`);
}

function seedOperation() {
  const output = psql(`INSERT INTO workspace(id,name,created_at,updated_at)
      VALUES ('${WS}','RoundB',now(),now());
    INSERT INTO execution_budget_authority(id,scope_key,authority_kind,workspace_id,
      issuer,audience,jti,token_sha256,schema_version,purpose,subject_type,subject_id,
      request_sha256,currency,unit,cap_microusd,runs_consumed,issued_at,not_before,
      expires_at,consumed_at)
    VALUES ('${AUTH}','${WS}','WORKSPACE_GRANT','${WS}','https://roundb.test',
      'global-backend:execution-budget','23100000-0000-4000-8000-000000000001',
      repeat('1',64),'execution-budget-grant/v1','icp.design','company',
      '23100000-0000-4000-8000-000000000002',repeat('2',64),'USD','microusd',
      1000,1,now()-interval '30 seconds',now()-interval '20 seconds',
      now()+interval '4 minutes',now()-interval '10 seconds');
    INSERT INTO tool_budget_account(id,scope_key,account_key,generation,cap_cents,
      reserved_cents,charged_cents,exhausted,ref_count,authority_id,
      authorized_cap_microusd,reserved_microusd,charged_microusd,created_at,updated_at)
    VALUES ('${ACCOUNT}','${WS}','roundb-account',1,0,0,0,false,1,'${AUTH}',
      1000,0,0,now(),now());
    DO $seed$ DECLARE base jsonb; projection jsonb; digest text; usage jsonb;
    BEGIN base:=jsonb_build_object('schemaVersion','generic-operation-projection/v1',
      'kind','tool','schema','roundb-result/v1','data',jsonb_build_object('ok',true));
      digest:=generic_operation_projection_digest(base);
      projection:=base||jsonb_build_object('digest',digest);
      usage:=jsonb_build_object('currency','USD','unit','microusd','callCount',1,
        'inputTokens',1,'outputTokens',1,'chargedMicrousd','50','upperBoundMicrousd','100');
      INSERT INTO tool_budget_operation(id,scope_key,account_id,generation,operation_key,
        amount_unit,reserved_cents,reserved_microusd,observed_microusd,charged_microusd,
        result_schema_version,result_schema,result_digest,result_json,status,receipt_usage,
        receipt_cost_basis,settled_at,created_at)
      VALUES ('${OP}','${WS}','${ACCOUNT}',1,'roundb-operation','microusd',0,100,50,50,
        'generic-operation-projection/v1','roundb-result/v1',digest,projection,'SETTLED',
        usage,'token_pricing',now(),now());
      UPDATE tool_budget_account SET charged_microusd=50 WHERE id='${ACCOUNT}'; END $seed$;
    SET SESSION AUTHORIZATION app_user; BEGIN;
    SELECT set_config('app.current_workspace_id','${WS}',true);
    SELECT ack_json::text FROM apply_execution_domain_ack_v1('${WS}','${OP}',
      'RoundBConsumer','RoundBAggregate',repeat('3',64),repeat('4',64)); COMMIT;`)
    .split("\n").findLast((line) => line.startsWith("{"));
  const ack = JSON.parse(output);
  return { ackId: ack.ackId, resultDigest: ack.resultDigest };
}

function seedRoot() {
  rootId = psql(`INSERT INTO governed_subject(scope_key,workspace_id,subject_type,
    subject_id,data_class) VALUES ('${WS}','${WS}','tool_operation','${OP}','NON_PERSONAL')
    RETURNING id::text;`);
  psql(`INSERT INTO tool_operation_subject(subject_id,scope_key,workspace_id,authority_id,
    account_id,operation_id,operation_generation,root_subject_id,ack_id,result_digest)
    VALUES ('${rootId}','${WS}','${WS}','${AUTH}','${ACCOUNT}','${OP}',1,'${rootId}',
      '${facts.ackId}','${facts.resultDigest}');`);
}

function seedPath({ diamond = false } = {}) {
  const low = "73000000-0000-4000-8000-000000000011";
  const high = "73000000-0000-4000-8000-000000000012";
  seedRoot();
  const a = deterministicUuid("roundb-node", "1");
  const b = deterministicUuid("roundb-node", "2");
  const parent = deterministicUuid("roundb-node", "3");
  psql(`INSERT INTO governed_subject(id,scope_key,workspace_id,subject_type,subject_id,
      data_class,dsr_subject_type,dsr_subject_id)
    VALUES (${a},'${WS}','${WS}','materialized_record',${deterministicUuid("roundb-ext","1")},
      'PERSONAL','company','${low}'),
      (${b},'${WS}','${WS}','materialized_record',${deterministicUuid("roundb-ext","2")},
      'PERSONAL','company','${high}'),
      (${parent},'${WS}','${WS}','materialized_record',${deterministicUuid("roundb-ext","3")},
      'NON_PERSONAL',NULL,NULL);
    INSERT INTO governed_subject_relation(id,scope_key,workspace_id,authority_id,account_id,
      operation_id,operation_generation,ack_id,operation_subject_id,parent_subject_id,
      child_subject_id,relation_key,relation_kind,source_ref_namespace,source_ref_uuid,contract_sha256)
    VALUES ('83000000-0000-4000-8000-000000000001','${WS}','${WS}','${AUTH}','${ACCOUNT}','${OP}',1,'${facts.ackId}','${rootId}',
      '${rootId}',${a},'roundb:root-a','DERIVED_FROM','source_record',
      ${deterministicUuid("roundb-src","1")},'${CONTRACT}'),
      ('83000000-0000-4000-8000-000000000002','${WS}','${WS}','${AUTH}','${ACCOUNT}','${OP}',1,'${facts.ackId}','${rootId}',
      ${a},${parent},'roundb:a-parent','DERIVED_FROM','source_record',
      ${deterministicUuid("roundb-src","2")},'${CONTRACT}'),
      ('83000000-0000-4000-8000-000000000003','${WS}','${WS}','${AUTH}','${ACCOUNT}','${OP}',1,'${facts.ackId}','${rootId}',
      '${rootId}',${b},'roundb:root-b','DERIVED_FROM','source_record',
      ${deterministicUuid("roundb-src","3")},'${CONTRACT}');
    ${diamond ? `INSERT INTO governed_subject_relation(id,scope_key,workspace_id,authority_id,
      account_id,operation_id,operation_generation,ack_id,operation_subject_id,parent_subject_id,
      child_subject_id,relation_key,relation_kind,source_ref_namespace,source_ref_uuid,contract_sha256)
      VALUES ('83000000-0000-4000-8000-000000000004','${WS}','${WS}','${AUTH}','${ACCOUNT}','${OP}',1,'${facts.ackId}','${rootId}',
      ${b},${parent},'roundb:b-parent','DERIVED_FROM','source_record',
      ${deterministicUuid("roundb-src","4")},'${CONTRACT}');` : ""}`);
  return { low, high, a: psql(`SELECT ${a}::text;`), b: psql(`SELECT ${b}::text;`),
    parent: psql(`SELECT ${parent}::text;`) };
}

function seedOtherPersonalParent() {
  const dsr = "73000000-0000-4000-8000-000000000099";
  psql(`INSERT INTO tool_budget_operation(id,scope_key,account_id,generation,operation_key,
      amount_unit,reserved_cents,observed_cents,charged_cents,reserved_microusd,
      observed_microusd,charged_microusd,result_schema_version,result_schema,result_digest,
      result_json,status,settled_at,created_at,receipt_usage,receipt_cost_basis)
    SELECT '${OP2}',scope_key,account_id,generation,'roundb-operation-2',amount_unit,
      reserved_cents,observed_cents,charged_cents,reserved_microusd,observed_microusd,
      charged_microusd,result_schema_version,result_schema,result_digest,result_json,status,
      settled_at,created_at,receipt_usage,receipt_cost_basis
    FROM tool_budget_operation WHERE id='${OP}';
    SET SESSION AUTHORIZATION app_user; BEGIN;
    SELECT set_config('app.current_workspace_id','${WS}',true);
    SELECT ack_json::text FROM apply_execution_domain_ack_v1('${WS}','${OP2}',
      'RoundBConsumer2','RoundBAggregate',repeat('5',64),repeat('6',64)); COMMIT;`);
  const ack=JSON.parse(psql(`SELECT ack_json::text FROM execution_domain_ack
    WHERE operation_id='${OP2}';`));
  const otherRoot=psql(`INSERT INTO governed_subject(scope_key,workspace_id,subject_type,
    subject_id,data_class) VALUES ('${WS}','${WS}','tool_operation','${OP2}','NON_PERSONAL')
    RETURNING id::text;`);
  const child=psql(`INSERT INTO governed_subject(scope_key,workspace_id,subject_type,subject_id,
    data_class,dsr_subject_type,dsr_subject_id) VALUES ('${WS}','${WS}','materialized_record',
    ${deterministicUuid("roundb-other-ext","1")},'PERSONAL','company','${dsr}') RETURNING id::text;`);
  psql(`INSERT INTO tool_operation_subject(subject_id,scope_key,workspace_id,authority_id,
      account_id,operation_id,operation_generation,root_subject_id,ack_id,result_digest)
    VALUES ('${otherRoot}','${WS}','${WS}','${AUTH}','${ACCOUNT}','${OP2}',1,'${otherRoot}',
      '${ack.ackId}','${ack.resultDigest}');
    INSERT INTO governed_subject_relation(scope_key,workspace_id,authority_id,account_id,
      operation_id,operation_generation,ack_id,operation_subject_id,parent_subject_id,
      child_subject_id,relation_key,relation_kind,source_ref_namespace,source_ref_uuid,contract_sha256)
    VALUES ('${WS}','${WS}','${AUTH}','${ACCOUNT}','${OP2}',1,'${ack.ackId}','${otherRoot}',
      '${otherRoot}','${child}','roundb:other-parent','DERIVED_FROM','source_record',
      ${deterministicUuid("roundb-other-src","1")},'${CONTRACT}');`);
  return { child, dsr };
}

function invocation(fn, override = {}) {
  const input = { parentId: null, childId: "53000000-0000-4000-8000-000000000001",
    relationKey: "roundb:final", ...override };
  const uuid = (value) => value === null ? "NULL::uuid" : `'${value}'::uuid`;
  return `SELECT * FROM public.${fn}('${WS}'::uuid,'${AUTH}'::uuid,'${ACCOUNT}'::uuid,
    '${OP}'::uuid,1,'${facts.ackId}'::char(64),'${facts.resultDigest}'::char(64),
    'tool_operation'::varchar(191),'${OP}'::uuid,'NON_PERSONAL'::varchar(16),
    NULL::varchar(191),NULL::uuid,${uuid(input.parentId)},'materialized_record'::varchar(191),
    '${input.childId}'::uuid,'NON_PERSONAL'::varchar(16),NULL::varchar(191),NULL::uuid,
    '${input.relationKey}'::varchar(200),'MATERIALIZED_CHILD'::varchar(32),
    'source_record'::varchar(64),'63000000-0000-4000-8000-000000000001'::uuid,
    NULL::char(64),'${CONTRACT}'::char(64));`;
}

function canonicalSnapshot() {
  return psql(`SELECT encode(digest(convert_to(jsonb_build_object(
    'subjects',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM governed_subject s WHERE workspace_id='${WS}'),
    'operations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY subject_id) FROM tool_operation_subject o WHERE workspace_id='${WS}'),
    'relations',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM governed_subject_relation r WHERE workspace_id='${WS}'),
    'tombstones',(SELECT jsonb_agg(to_jsonb(t) ORDER BY governed_subject_id) FROM governed_subject_tombstone t WHERE workspace_id='${WS}'),
    'artifactTombstones',(SELECT jsonb_agg(to_jsonb(t) ORDER BY subject_type,subject_id)
      FROM generic_operation_artifact_subject_tombstone t WHERE workspace_id='${WS}')
  )::text,'UTF8'),'sha256'),'hex');`);
}

function startConnection(sql, interactive = false) {
  const child = spawn("docker", dockerArgs(), { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; let settled = false;
  const listeners = [];
  child.on("error", (error) => { stderr += `${error.message}\n`; });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk; for (const listener of listeners) listener(stdout);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.on("close", (status) => {
    settled = true; resolve({ status, stdout: stdout.trim(), stderr });
  }));
  if (interactive) child.stdin.write(sql); else child.stdin.end(sql);
  return { done, isSettled: () => settled,
    write: (next) => child.stdin.write(next),
    end: () => { if (!child.stdin.destroyed) child.stdin.end(); },
    abort: () => child.kill("SIGTERM"),
    waitFor: (sentinel, timeout = 3000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${sentinel}: ${stderr}`)), timeout);
      const observe = (value) => { if (value.includes(sentinel)) { clearTimeout(timer); resolve(value); } };
      if (stdout.includes(sentinel)) observe(stdout); else listeners.push(observe);
    }) };
}

async function cleanup(connection, name) {
  if (!connection || connection.isSettled()) return;
  connection.end(); connection.abort();
  await Promise.race([connection.done, new Promise((resolve) => setTimeout(resolve, 700))]);
  if (!connection.isSettled()) psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE application_name='${name}' AND pid<>pg_backend_pid();`);
}

async function observeWait(holderPid, writerName, writer, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (writer.isSettled()) {
      const result = await writer.done; assert.equal(result.status, 0, result.stderr);
    }
    const count = psql(`SELECT count(*) FROM pg_locks h JOIN pg_locks w
      ON w.locktype=h.locktype AND w.database IS NOT DISTINCT FROM h.database
      AND w.classid IS NOT DISTINCT FROM h.classid AND w.objid IS NOT DISTINCT FROM h.objid
      AND w.objsubid IS NOT DISTINCT FROM h.objsubid JOIN pg_stat_activity a ON a.pid=w.pid
      WHERE h.pid=${holderPid} AND h.granted AND NOT w.granted
      AND a.application_name='${writerName}';`);
    if (count === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(`no exact wait observed for ${writerName}`);
}

function holder(name, key, sentinel) {
  return startConnection(`SET application_name='${name}'; SET SESSION AUTHORIZATION app_user;
    BEGIN; SELECT set_config('app.current_workspace_id','${WS}',true);
    SELECT pg_advisory_xact_lock(hashtextextended('${key}',0));
    SELECT pg_backend_pid()::text||'|${sentinel}';\n`, true);
}

describe("governed relation exact path lock ordering", () => {
  before(() => assert.equal(psql("SELECT current_database()||':'||current_user;"), "gsr_task2:global"));
  beforeEach(() => { reset(); facts = seedOperation(); rootId = null; });

  it("builds exact main, unrelated and diamond reference paths", () => {
    let path = seedPath();
    assert.equal(psql(`SELECT count(*) FROM governed_subject_relation
      WHERE operation_id='${OP}';`), "3");
    assert.notEqual(path.a, path.b); assert.notEqual(path.parent, path.b);
    reset(); facts = seedOperation(); path = seedPath({ diamond: true });
    assert.equal(psql(`SELECT count(*) FROM governed_subject_relation
      WHERE operation_id='${OP}';`), "4");
    assert.equal(psql(`SELECT count(*) FROM governed_subject_relation
      WHERE operation_id='${OP}' AND child_subject_id='${path.parent}';`), "2");
  });

  it("lets an ACK replay transaction callback append before a standalone append", async () => {
    const callbackName="roundb_ack_callback"; const standaloneName="roundb_ack_standalone";
    const callback=startConnection(`SET application_name='${callbackName}';
      SET SESSION AUTHORIZATION app_user; BEGIN;
      SELECT set_config('app.current_workspace_id','${WS}',true);
      SELECT status FROM apply_execution_domain_ack_v1('${WS}','${OP}','RoundBConsumer',
        'RoundBAggregate',repeat('3',64),repeat('4',64));
      SELECT pg_backend_pid()::text||'|ACK_READY';\n`,true);
    let standalone; try {
      await callback.waitFor("ACK_READY");
      standalone=startConnection(`SET application_name='${standaloneName}';${asApp(invocation(APPEND))}`);
      await new Promise((resolve)=>setTimeout(resolve,150));
      assert.equal(standalone.isSettled(),false);
      callback.write(`${invocation(APPEND)} COMMIT;\n`); callback.end();
      const [callbackResult,standaloneResult]=await Promise.all([callback.done,standalone.done]);
      assert.equal(callbackResult.status,0,callbackResult.stderr);
      assert.equal(standaloneResult.status,0,standaloneResult.stderr);
      assert.match(callbackResult.stdout,/REPLAYED/); assert.match(callbackResult.stdout,/\|f$/m);
      assert.match(standaloneResult.stdout,/\|t$/m);
      assert.equal(psql(`SELECT count(*) FROM execution_domain_ack WHERE operation_id='${OP}';`),"1");
      assert.equal(psql(`SELECT count(*) FROM governed_subject_relation WHERE operation_id='${OP}';`),"1");
    } finally { await Promise.all([cleanup(callback,callbackName),cleanup(standalone,standaloneName)]); }
  });

  it("rejects another operation PERSONAL parent before waiting on its DSR key", async () => {
    const foreign=seedOtherPersonalParent();
    const lockName="roundb_foreign_dsr"; const lock=holder(lockName,
      `generic-operation-artifact-subject:${WS}:company:${foreign.dsr}`,"READY");
    try {
      const ready=await lock.waitFor("READY"); const pid=Number(ready.match(/(\d+)\|READY/)?.[1]);
      for(const fn of [APPEND,ATTEST]) {
        if(fn===ATTEST) psql(asApp(invocation(APPEND)));
        const writerName=`roundb_foreign_${fn===APPEND?"append":"attest"}`;
        const writer=startConnection(`SET application_name='${writerName}';${asApp(invocation(fn,{parentId:foreign.child}),fn===ATTEST)}`);
        await new Promise((resolve)=>setTimeout(resolve,150));
        const waits=psql(`SELECT count(*) FROM pg_locks h JOIN pg_locks w ON w.locktype=h.locktype
          AND w.classid=h.classid AND w.objid=h.objid AND w.objsubid=h.objsubid
          JOIN pg_stat_activity a ON a.pid=w.pid WHERE h.pid=${pid} AND h.granted AND NOT w.granted
          AND a.application_name='${writerName}';`);
        assert.equal(waits,"0"); const result=await writer.done;
        assert.notEqual(result.status,0); assert.match(result.stderr,/GOVERNED_SUBJECT_RELATION_INVALID/);
        await cleanup(writer,writerName);
      }
    } finally { await cleanup(lock,lockName); }
  });

  it("waits on DSR before graph", async () => {
    const path = seedPath();
    const graph = holder("roundb_graph",`governed-subject-relation:${WS}:${OP}`,"GRAPH");
    const dsr = holder("roundb_dsr",`generic-operation-artifact-subject:${WS}:company:${path.low}`,"DSR");
    let writer; try {
      const [g,d] = await Promise.all([graph.waitFor("GRAPH"),dsr.waitFor("DSR")]);
      const graphPid=Number(g.match(/(\d+)\|GRAPH/)?.[1]); const dsrPid=Number(d.match(/(\d+)\|DSR/)?.[1]);
      writer=startConnection(`SET application_name='roundb_writer';${asApp(invocation(APPEND,{parentId:path.parent}))}`);
      await observeWait(dsrPid,"roundb_writer",writer); dsr.write("COMMIT;\n"); dsr.end(); await dsr.done;
      await observeWait(graphPid,"roundb_writer",writer); graph.write("COMMIT;\n"); graph.end();
      assert.equal((await writer.done).status,0);
    } finally { await Promise.all([cleanup(graph,"roundb_graph"),cleanup(dsr,"roundb_dsr"),cleanup(writer,"roundb_writer")]); }
  });

  it("attest READ ONLY waits on DSR before graph and preserves its snapshot", async () => {
    const path=seedPath(); const input={parentId:path.parent,relationKey:"roundb:attest-order"};
    psql(asApp(invocation(APPEND,input))); const before=canonicalSnapshot();
    const graph=holder("roundb_attest_graph",`governed-subject-relation:${WS}:${OP}`,"GRAPH");
    const dsr=holder("roundb_attest_dsr",`generic-operation-artifact-subject:${WS}:company:${path.low}`,"DSR");
    let writer; try {
      const [g,d]=await Promise.all([graph.waitFor("GRAPH"),dsr.waitFor("DSR")]);
      const graphPid=Number(g.match(/(\d+)\|GRAPH/)?.[1]); const dsrPid=Number(d.match(/(\d+)\|DSR/)?.[1]);
      writer=startConnection(`SET application_name='roundb_attest_writer';${asApp(invocation(ATTEST,input),true)}`);
      await observeWait(dsrPid,"roundb_attest_writer",writer); dsr.write("COMMIT;\n"); dsr.end(); await dsr.done;
      await observeWait(graphPid,"roundb_attest_writer",writer); graph.write("COMMIT;\n"); graph.end();
      const result=await writer.done; assert.equal(result.status,0,result.stderr);
      assert.match(result.stdout,/\|t$/m); assert.equal(canonicalSnapshot(),before);
    } finally { await Promise.all([cleanup(graph,"roundb_attest_graph"),cleanup(dsr,"roundb_attest_dsr"),cleanup(writer,"roundb_attest_writer")]); }
  });

  it("does not fence or lock an unrelated branch", async () => {
    let path=seedPath(); psql(`INSERT INTO governed_subject_tombstone VALUES ('${WS}','${path.b}',now());`);
    psql(asApp(invocation(APPEND,{parentId:path.parent,relationKey:"roundb:unrelated-governed"})));
    reset(); facts=seedOperation(); path=seedPath();
    const unrelated=holder("roundb_unrelated",`generic-operation-artifact-subject:${WS}:company:${path.high}`,"READY");
    let writer; try {
      const ready=await unrelated.waitFor("READY"); const pid=Number(ready.match(/(\d+)\|READY/)?.[1]);
      writer=startConnection(`SET application_name='roundb_exact';${asApp(invocation(APPEND,{parentId:path.parent,relationKey:"roundb:exact"}))}`);
      await new Promise((resolve)=>setTimeout(resolve,150));
      const waits=psql(`SELECT count(*) FROM pg_locks h JOIN pg_locks w ON w.locktype=h.locktype
        AND w.classid=h.classid AND w.objid=h.objid AND w.objsubid=h.objsubid
        JOIN pg_stat_activity a ON a.pid=w.pid WHERE h.pid=${pid} AND h.granted AND NOT w.granted
        AND a.application_name='roundb_exact';`);
      assert.equal(waits,"0");
      const result=await Promise.race([writer.done,new Promise((_,reject)=>setTimeout(()=>reject(new Error("extra lock")),1500))]);
      assert.equal(result.status,0,result.stderr);
    } finally { await Promise.all([cleanup(unrelated,"roundb_unrelated"),cleanup(writer,"roundb_exact")]); }
  });

  it("attest ignores unrelated governed tombstones and DSR locks", async () => {
    let path=seedPath(); const input={parentId:path.parent,relationKey:"roundb:attest-unrelated"};
    psql(asApp(invocation(APPEND,input)));
    psql(`INSERT INTO governed_subject_tombstone VALUES ('${WS}','${path.b}',now());`);
    let before=canonicalSnapshot(); let result=raw(asApp(invocation(ATTEST,input),true));
    assert.equal(result.status,0,result.stderr); assert.equal(canonicalSnapshot(),before);

    reset(); facts=seedOperation(); path=seedPath(); psql(asApp(invocation(APPEND,input)));
    before=canonicalSnapshot(); const lock=holder("roundb_attest_unrelated",
      `generic-operation-artifact-subject:${WS}:company:${path.high}`,"READY");
    let writer; try {
      const ready=await lock.waitFor("READY"); const pid=Number(ready.match(/(\d+)\|READY/)?.[1]);
      writer=startConnection(`SET application_name='roundb_attest_exact';${asApp(invocation(ATTEST,input),true)}`);
      await new Promise((resolve)=>setTimeout(resolve,150));
      const waits=psql(`SELECT count(*) FROM pg_locks h JOIN pg_locks w ON w.locktype=h.locktype
        AND w.classid=h.classid AND w.objid=h.objid AND w.objsubid=h.objsubid
        JOIN pg_stat_activity a ON a.pid=w.pid WHERE h.pid=${pid} AND h.granted AND NOT w.granted
        AND a.application_name='roundb_attest_exact';`);
      assert.equal(waits,"0");
      result=await Promise.race([writer.done,new Promise((_,reject)=>setTimeout(()=>reject(new Error("extra attest lock")),1500))]);
      assert.equal(result.status,0,result.stderr); assert.equal(canonicalSnapshot(),before);
    } finally { await Promise.all([cleanup(lock,"roundb_attest_unrelated"),cleanup(writer,"roundb_attest_exact")]); }
  });

  it("fences every ancestor in a diamond", () => {
    for (const [kind,key] of [["governed","a"],["governed","b"],["artifact","low"],["artifact","high"]]) {
      reset(); facts=seedOperation(); const path=seedPath({diamond:true});
      const input={parentId:path.parent,relationKey:"roundb:diamond"}; psql(asApp(invocation(APPEND,input)));
      if(kind==="governed") psql(`INSERT INTO governed_subject_tombstone VALUES ('${WS}','${path[key]}',now());`);
      else psql(`INSERT INTO generic_operation_artifact_subject_tombstone VALUES ('${WS}','company','${path[key]}',now());`);
      const before=canonicalSnapshot();
      for(const fn of [APPEND,ATTEST]) { const denied=raw(asApp(invocation(fn,input),fn===ATTEST)); assert.notEqual(denied.status,0); assert.match(denied.stderr,/GOVERNED_SUBJECT_TOMBSTONED/); assert.equal(canonicalSnapshot(),before); }
    }
  });

  it("fails when the ancestor set drifts before graph lock", async () => {
    const path=seedPath(); const graph=holder("roundb_drift_graph",`governed-subject-relation:${WS}:${OP}`,"READY");
    let writer; try {
      const ready=await graph.waitFor("READY"); const pid=Number(ready.match(/(\d+)\|READY/)?.[1]);
      writer=startConnection(`SET application_name='roundb_drift';${asApp(invocation(APPEND,{parentId:path.parent,relationKey:"roundb:drift"}))}`);
      await observeWait(pid,"roundb_drift",writer);
      psql(`INSERT INTO governed_subject_relation(scope_key,workspace_id,authority_id,account_id,
        operation_id,operation_generation,ack_id,operation_subject_id,parent_subject_id,child_subject_id,
        relation_key,relation_kind,source_ref_namespace,source_ref_uuid,contract_sha256)
      VALUES ('${WS}','${WS}','${AUTH}','${ACCOUNT}','${OP}',1,'${facts.ackId}','${rootId}',
        '${path.b}','${path.parent}','roundb:drift-edge','DERIVED_FROM','source_record',
        ${deterministicUuid("roundb-src","99")},'${CONTRACT}');`);
      graph.write("COMMIT;\n"); graph.end(); const result=await writer.done;
      assert.notEqual(result.status,0); assert.match(result.stderr,/GOVERNED_SUBJECT_RELATION_INVALID/);
      assert.equal(psql(`SELECT count(*) FROM governed_subject_relation WHERE relation_key='roundb:drift';`),"0");
    } finally { await Promise.all([cleanup(graph,"roundb_drift_graph"),cleanup(writer,"roundb_drift")]); }
  });

  it("reports a governed fence committed between append snapshots as tombstoned", async () => {
    const path=seedPath(); const graph=holder("roundb_fence_graph",
      `governed-subject-relation:${WS}:${OP}`,"READY");
    let writer; try {
      const ready=await graph.waitFor("READY"); const pid=Number(ready.match(/(\d+)\|READY/)?.[1]);
      writer=startConnection(`SET application_name='roundb_fence_writer';${asApp(invocation(APPEND,
        {parentId:path.parent,relationKey:"roundb:fence-drift"}))}`);
      await observeWait(pid,"roundb_fence_writer",writer);
      psql(`INSERT INTO governed_subject_tombstone(workspace_id,governed_subject_id)
        VALUES ('${WS}','${path.a}');`);
      graph.write("COMMIT;\n"); graph.end(); const result=await writer.done;
      assert.notEqual(result.status,0); assert.match(result.stderr,/GOVERNED_SUBJECT_TOMBSTONED/);
      assert.equal(psql(`SELECT count(*) FROM governed_subject_relation
        WHERE relation_key='roundb:fence-drift';`),"0");
    } finally { await Promise.all([cleanup(graph,"roundb_fence_graph"),
      cleanup(writer,"roundb_fence_writer")]); }
  });

  it("reports an artifact fence committed during the DSR wait as tombstoned", async () => {
    const path=seedPath(); const dsr=holder("roundb_artifact_fence_dsr",
      `generic-operation-artifact-subject:${WS}:company:${path.low}`,"READY");
    let writer; try {
      const ready=await dsr.waitFor("READY"); const pid=Number(ready.match(/(\d+)\|READY/)?.[1]);
      writer=startConnection(`SET application_name='roundb_artifact_fence_writer';${asApp(
        invocation(APPEND,{parentId:path.parent,relationKey:"roundb:artifact-fence-drift"}))}`);
      await observeWait(pid,"roundb_artifact_fence_writer",writer);
      psql(`INSERT INTO generic_operation_artifact_subject_tombstone(
        workspace_id,subject_type,subject_id) VALUES ('${WS}','company','${path.low}');`);
      dsr.write("COMMIT;\n"); dsr.end(); const result=await writer.done;
      assert.notEqual(result.status,0); assert.match(result.stderr,/GOVERNED_SUBJECT_TOMBSTONED/);
      assert.equal(psql(`SELECT count(*) FROM governed_subject_relation
        WHERE relation_key='roundb:artifact-fence-drift';`),"0");
    } finally { await Promise.all([cleanup(dsr,"roundb_artifact_fence_dsr"),
      cleanup(writer,"roundb_artifact_fence_writer")]); }
  });

  it("attest fails with zero writes when ancestors drift before graph lock", async () => {
    const path=seedPath(); const input={parentId:path.parent,relationKey:"roundb:attest-drift"};
    psql(asApp(invocation(APPEND,input)));
    const graph=holder("roundb_attest_drift_graph",`governed-subject-relation:${WS}:${OP}`,"READY");
    let writer; try {
      const ready=await graph.waitFor("READY"); const pid=Number(ready.match(/(\d+)\|READY/)?.[1]);
      writer=startConnection(`SET application_name='roundb_attest_drift';${asApp(invocation(ATTEST,input),true)}`);
      await observeWait(pid,"roundb_attest_drift",writer);
      psql(`INSERT INTO governed_subject_relation(id,scope_key,workspace_id,authority_id,account_id,
        operation_id,operation_generation,ack_id,operation_subject_id,parent_subject_id,child_subject_id,
        relation_key,relation_kind,source_ref_namespace,source_ref_uuid,contract_sha256)
      VALUES ('83000000-0000-4000-8000-000000000099','${WS}','${WS}','${AUTH}','${ACCOUNT}',
        '${OP}',1,'${facts.ackId}','${rootId}','${path.b}','${path.parent}',
        'roundb:attest-drift-edge','DERIVED_FROM','source_record',
        ${deterministicUuid("roundb-src","98")},'${CONTRACT}');`);
      const afterDrift=canonicalSnapshot(); graph.write("COMMIT;\n"); graph.end();
      const result=await writer.done; assert.notEqual(result.status,0);
      assert.match(result.stderr,/GOVERNED_SUBJECT_RELATION_INVALID/);
      assert.equal(canonicalSnapshot(),afterDrift);
    } finally { await Promise.all([cleanup(graph,"roundb_attest_drift_graph"),cleanup(writer,"roundb_attest_drift")]); }
  });

  it("rejects nonpersonal ancestor drift for a pre-existing relation", async () => {
    for(const fn of [APPEND,ATTEST]) {
      reset(); facts=seedOperation(); const path=seedPath();
      const input={parentId:path.parent,relationKey:"roundb:nonpersonal-drift"};
      psql(asApp(invocation(APPEND,input)));
      const holderName=`roundb_nonpersonal_holder_${fn===APPEND?"a":"t"}`;
      const writerName=`roundb_nonpersonal_writer_${fn===APPEND?"a":"t"}`;
      const graph=holder(holderName,`governed-subject-relation:${WS}:${OP}`,"READY");
      let writer; try {
        const ready=await graph.waitFor("READY"); const pid=Number(ready.match(/(\d+)\|READY/)?.[1]);
        writer=startConnection(`SET application_name='${writerName}';${asApp(invocation(fn,input),fn===ATTEST)}`);
        await observeWait(pid,writerName,writer);
        const c=deterministicUuid("roundb-nonpersonal","1");
        psql(`INSERT INTO governed_subject(id,scope_key,workspace_id,subject_type,subject_id,data_class)
          VALUES (${c},'${WS}','${WS}','materialized_record',
            ${deterministicUuid("roundb-nonpersonal-ext","1")},'NON_PERSONAL');
          INSERT INTO governed_subject_relation(id,scope_key,workspace_id,authority_id,account_id,
            operation_id,operation_generation,ack_id,operation_subject_id,parent_subject_id,
            child_subject_id,relation_key,relation_kind,source_ref_namespace,source_ref_uuid,contract_sha256)
          VALUES ('83000000-0000-4000-8000-000000000091','${WS}','${WS}','${AUTH}','${ACCOUNT}',
            '${OP}',1,'${facts.ackId}','${rootId}','${rootId}',${c},'roundb:nonpersonal-root',
            'DERIVED_FROM','source_record',${deterministicUuid("roundb-nonpersonal-src","1")},'${CONTRACT}'),
            ('83000000-0000-4000-8000-000000000092','${WS}','${WS}','${AUTH}','${ACCOUNT}',
            '${OP}',1,'${facts.ackId}','${rootId}',${c},'${path.parent}','roundb:nonpersonal-parent',
            'DERIVED_FROM','source_record',${deterministicUuid("roundb-nonpersonal-src","2")},'${CONTRACT}');`);
        const afterDrift=canonicalSnapshot(); graph.write("COMMIT;\n"); graph.end();
        const result=await writer.done; assert.notEqual(result.status,0);
        assert.match(result.stderr,/GOVERNED_SUBJECT_RELATION_INVALID/);
        assert.equal(canonicalSnapshot(),afterDrift);
      } finally { await Promise.all([cleanup(graph,holderName),cleanup(writer,writerName)]); }
    }
  });
});
