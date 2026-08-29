import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { before, beforeEach, describe, it } from "node:test";

const CONTAINER = process.env.GOVERNED_RELATION_TASK2_PG_CONTAINER;
const DATABASE = process.env.GOVERNED_RELATION_TASK2_PG_DATABASE ?? "gsr_task2";
const APPEND = "append_workspace_governed_child_relation_v1";
const ATTEST = "attest_workspace_governed_child_relation_v1";
const WS = "12000000-0000-4000-8000-000000000001";
const AUTH = "22000000-0000-4000-8000-000000000001";
const ACCOUNT = "32000000-0000-4000-8000-000000000001";
const OP = "42000000-0000-4000-8000-000000000001";
const OP2 = "42000000-0000-4000-8000-000000000002";
const CHILD = "52000000-0000-4000-8000-000000000001";
const SOURCE = "62000000-0000-4000-8000-000000000001";
const CONTRACT = "a".repeat(64);
const INDEXES = [
  "governed_subject_workspace_dsr_idx",
  "tool_operation_subject_authority_operation_idx",
  "governed_subject_relation_operation_parent_idx",
  "governed_subject_relation_operation_child_idx",
  "governed_subject_tombstone_workspace_time_idx",
];

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

function asApp(sql, workspaceId = WS, readOnly = false) {
  return `SET SESSION AUTHORIZATION app_user;
    BEGIN${readOnly ? " READ ONLY" : ""};
    SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='3s';
    SELECT set_config('app.current_workspace_id','${workspaceId}',true);
    ${sql}
    COMMIT;`;
}

function reset() {
  psql(`DELETE FROM governed_subject_tombstone_audit;
    DELETE FROM governed_subject_tombstone;
    DELETE FROM governed_subject_relation;
    DELETE FROM tool_operation_subject;
    DELETE FROM governed_subject;
    DELETE FROM generic_operation_artifact_subject_tombstone_audit;
    DELETE FROM generic_operation_artifact_subject_tombstone;
    DELETE FROM execution_domain_ack;
    DELETE FROM tool_budget_operation;
    DELETE FROM tool_budget_account;
    DELETE FROM execution_budget_authority_revocation;
    DELETE FROM execution_budget_authority;
    DELETE FROM workspace WHERE id='${WS}';`);
}

function seedOperation() {
  const output = psql(`INSERT INTO workspace(id,name,created_at,updated_at)
      VALUES ('${WS}','Task2 graph',now(),now());
    INSERT INTO execution_budget_authority(
      id,scope_key,authority_kind,workspace_id,issuer,audience,jti,token_sha256,
      schema_version,purpose,subject_type,subject_id,request_sha256,currency,unit,
      cap_microusd,runs_consumed,issued_at,not_before,expires_at,consumed_at
    ) VALUES ('${AUTH}','${WS}','WORKSPACE_GRANT','${WS}','https://graph.test',
      'global-backend:execution-budget','22100000-0000-4000-8000-000000000001',
      repeat('1',64),'execution-budget-grant/v1','icp.design','company',
      '23100000-0000-4000-8000-000000000001',repeat('2',64),'USD','microusd',
      1000,1,now()-interval '30 seconds',now()-interval '20 seconds',
      now()+interval '4 minutes',now()-interval '10 seconds');
    INSERT INTO tool_budget_account(id,scope_key,account_key,generation,cap_cents,
      reserved_cents,charged_cents,exhausted,ref_count,authority_id,
      authorized_cap_microusd,reserved_microusd,charged_microusd,created_at,updated_at)
    VALUES ('${ACCOUNT}','${WS}','graph-account',1,0,0,0,false,1,'${AUTH}',
      1000,0,0,now(),now());
    DO $seed$ DECLARE base jsonb; projection jsonb; digest text; usage jsonb;
    BEGIN base:=jsonb_build_object('schemaVersion','generic-operation-projection/v1',
      'kind','tool','schema','graph-result/v1','data',jsonb_build_object('ok',true));
      digest:=generic_operation_projection_digest(base);
      projection:=base||jsonb_build_object('digest',digest);
      usage:=jsonb_build_object('currency','USD','unit','microusd','callCount',1,
        'inputTokens',1,'outputTokens',1,'chargedMicrousd','50','upperBoundMicrousd','100');
      INSERT INTO tool_budget_operation(id,scope_key,account_id,generation,operation_key,
        amount_unit,reserved_cents,reserved_microusd,observed_microusd,charged_microusd,
        result_schema_version,result_schema,result_digest,result_json,status,receipt_usage,
        receipt_cost_basis,settled_at,created_at)
      VALUES ('${OP}','${WS}','${ACCOUNT}',1,'graph-operation','microusd',0,100,50,50,
        'generic-operation-projection/v1','graph-result/v1',digest,projection,'SETTLED',
        usage,'token_pricing',now(),now());
      UPDATE tool_budget_account SET charged_microusd=50 WHERE id='${ACCOUNT}';
    END $seed$;
    SET SESSION AUTHORIZATION app_user; BEGIN;
    SELECT set_config('app.current_workspace_id','${WS}',true);
    SELECT ack_json::text FROM apply_execution_domain_ack_v1('${WS}','${OP}',
      'GraphConsumer','GraphAggregate',repeat('3',64),repeat('4',64)); COMMIT;`)
    .split("\n").findLast((line) => line.startsWith("{"));
  const ack = JSON.parse(output);
  return { ackId: ack.ackId, resultDigest: ack.resultDigest };
}

function invocation(fn, override = {}) {
  const input = {
    workspaceId: WS, authorityId: AUTH, accountId: ACCOUNT, operationId: OP,
    generation: 1, ackId: facts.ackId, resultDigest: facts.resultDigest,
    rootType: "tool_operation", rootExternalId: OP, rootData: "NON_PERSONAL",
    rootDsrType: null, rootDsrId: null, parentId: null,
    childType: "materialized_record", childId: CHILD, childData: "NON_PERSONAL",
    childDsrType: null, childDsrId: null, relationKey: "graph:final",
    relationKind: "MATERIALIZED_CHILD", sourceNamespace: "source_record",
    sourceUuid: SOURCE, sourceSha: null, contractSha: CONTRACT, ...override,
  };
  const uuid = (value) => value === null ? "NULL::uuid" : `'${value}'::uuid`;
  const text = (value, type) => value === null ? `NULL::${type}` : `'${value}'::${type}`;
  return `SELECT operation_subject_id::text,parent_subject_id::text,
    child_subject_id::text,relation_id::text,replay FROM public.${fn}(
    ${uuid(input.workspaceId)},${uuid(input.authorityId)},${uuid(input.accountId)},
    ${uuid(input.operationId)},${input.generation},${text(input.ackId,"char(64)")},
    ${text(input.resultDigest,"char(64)")},${text(input.rootType,"varchar(191)")},
    ${uuid(input.rootExternalId)},${text(input.rootData,"varchar(16)")},
    ${text(input.rootDsrType,"varchar(191)")},${uuid(input.rootDsrId)},${uuid(input.parentId)},
    ${text(input.childType,"varchar(191)")},${uuid(input.childId)},
    ${text(input.childData,"varchar(16)")},${text(input.childDsrType,"varchar(191)")},
    ${uuid(input.childDsrId)},${text(input.relationKey,"varchar(200)")},
    ${text(input.relationKind,"varchar(32)")},${text(input.sourceNamespace,"varchar(64)")},
    ${uuid(input.sourceUuid)},${text(input.sourceSha,"char(64)")},
    ${text(input.contractSha,"char(64)")});`;
}

function graphSnapshot() {
  return psql(`SELECT jsonb_build_object(
    'subjects',(SELECT count(*) FROM governed_subject WHERE workspace_id='${WS}'),
    'operationSubjects',(SELECT count(*) FROM tool_operation_subject WHERE workspace_id='${WS}'),
    'relations',(SELECT count(*) FROM governed_subject_relation WHERE workspace_id='${WS}'),
    'digest',(SELECT encode(digest(convert_to(
      COALESCE(string_agg(row_data,'|' ORDER BY row_data),''),'UTF8'),'sha256'),'hex')
      FROM (SELECT to_jsonb(s)::text row_data FROM governed_subject s WHERE workspace_id='${WS}'
        UNION ALL SELECT to_jsonb(o)::text FROM tool_operation_subject o WHERE workspace_id='${WS}'
        UNION ALL SELECT to_jsonb(r)::text FROM governed_subject_relation r WHERE workspace_id='${WS}') q)
  )::text;`);
}

function deterministicUuid(namespace, value) {
  return `(substr(md5('${namespace}:'||(${value})::text),1,8)||'-'||
    substr(md5('${namespace}:'||(${value})::text),9,4)||'-4'||
    substr(md5('${namespace}:'||(${value})::text),14,3)||'-8'||
    substr(md5('${namespace}:'||(${value})::text),18,3)||'-'||
    substr(md5('${namespace}:'||(${value})::text),21,12))::uuid`;
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

function seedStar(subjectCount, relationCount = subjectCount - 1) {
  seedRoot();
  if (subjectCount > 1) psql(`INSERT INTO governed_subject(id,scope_key,workspace_id,
    subject_type,subject_id,data_class)
    SELECT ${deterministicUuid("node","n")},'${WS}','${WS}','materialized_record',
      ${deterministicUuid("external","n")},'NON_PERSONAL' FROM generate_series(1,${subjectCount - 1}) n;`);
  if (relationCount > 0) psql(`INSERT INTO governed_subject_relation(id,scope_key,workspace_id,
    authority_id,account_id,operation_id,operation_generation,ack_id,operation_subject_id,
    parent_subject_id,child_subject_id,relation_key,relation_kind,source_ref_namespace,
    source_ref_uuid,contract_sha256)
    SELECT ${deterministicUuid("edge","n")},'${WS}','${WS}','${AUTH}','${ACCOUNT}','${OP}',1,
      '${facts.ackId}','${rootId}','${rootId}',${deterministicUuid("node",`((n-1)%GREATEST(1,${subjectCount - 1}))+1`)},
      'bulk:'||n,'MATERIALIZED_CHILD','source_record',${deterministicUuid("source","n")},
      '${CONTRACT}' FROM generate_series(1,${relationCount}) n;`);
}

function seedDepth(edgeCount) {
  seedRoot();
  if (edgeCount === 0) return;
  psql(`INSERT INTO governed_subject(id,scope_key,workspace_id,subject_type,subject_id,data_class)
    SELECT ${deterministicUuid("depth-node","n")},'${WS}','${WS}','materialized_record',
      ${deterministicUuid("depth-external","n")},'NON_PERSONAL' FROM generate_series(1,${edgeCount}) n;
    INSERT INTO governed_subject_relation(id,scope_key,workspace_id,authority_id,account_id,
      operation_id,operation_generation,ack_id,operation_subject_id,parent_subject_id,
      child_subject_id,relation_key,relation_kind,source_ref_namespace,source_ref_uuid,contract_sha256)
    SELECT ${deterministicUuid("depth-edge","n")},'${WS}','${WS}','${AUTH}','${ACCOUNT}','${OP}',1,
      '${facts.ackId}','${rootId}',CASE WHEN n=1 THEN '${rootId}'::uuid
        ELSE ${deterministicUuid("depth-node","n-1")} END,${deterministicUuid("depth-node","n")},
      'depth:'||n,'DERIVED_FROM','source_record',${deterministicUuid("depth-source","n")},
      '${CONTRACT}' FROM generate_series(1,${edgeCount}) n;`);
}

function seedOtherOperation() {
  const ackOutput = psql(`DO $seed$ DECLARE base jsonb; projection jsonb; digest text; usage jsonb;
    BEGIN base:=jsonb_build_object('schemaVersion','generic-operation-projection/v1',
      'kind','tool','schema','graph-result/v1','data',jsonb_build_object('other',true));
      digest:=generic_operation_projection_digest(base);
      projection:=base||jsonb_build_object('digest',digest);
      usage:=jsonb_build_object('currency','USD','unit','microusd','callCount',1,
        'inputTokens',1,'outputTokens',1,'chargedMicrousd','50','upperBoundMicrousd','100');
      INSERT INTO tool_budget_operation(id,scope_key,account_id,generation,operation_key,
        amount_unit,reserved_cents,reserved_microusd,observed_microusd,charged_microusd,
        result_schema_version,result_schema,result_digest,result_json,status,receipt_usage,
        receipt_cost_basis,settled_at,created_at)
      VALUES ('${OP2}','${WS}','${ACCOUNT}',1,'graph-operation-2','microusd',0,100,50,50,
        'generic-operation-projection/v1','graph-result/v1',digest,projection,'SETTLED',
        usage,'token_pricing',now(),now());
      UPDATE tool_budget_account SET charged_microusd=100 WHERE id='${ACCOUNT}'; END $seed$;
    SET SESSION AUTHORIZATION app_user; BEGIN;
    SELECT set_config('app.current_workspace_id','${WS}',true);
    SELECT ack_json::text FROM apply_execution_domain_ack_v1('${WS}','${OP2}',
      'GraphConsumer2','GraphAggregate',repeat('5',64),repeat('6',64)); COMMIT;`)
    .split("\n").findLast((line) => line.startsWith("{"));
  const ack = JSON.parse(ackOutput);
  const otherRoot = psql(`INSERT INTO governed_subject(scope_key,workspace_id,subject_type,
    subject_id,data_class) VALUES ('${WS}','${WS}','tool_operation','${OP2}','NON_PERSONAL')
    RETURNING id::text;`);
  psql(`INSERT INTO tool_operation_subject(subject_id,scope_key,workspace_id,authority_id,
      account_id,operation_id,operation_generation,root_subject_id,ack_id,result_digest)
    VALUES ('${otherRoot}','${WS}','${WS}','${AUTH}','${ACCOUNT}','${OP2}',1,
      '${otherRoot}','${ack.ackId}','${ack.resultDigest}');
    INSERT INTO governed_subject(id,scope_key,workspace_id,subject_type,subject_id,data_class)
    VALUES (${deterministicUuid("other-node","1")},'${WS}','${WS}','materialized_record',
      ${deterministicUuid("other-external","1")},'NON_PERSONAL');
    INSERT INTO governed_subject_relation(scope_key,workspace_id,authority_id,account_id,
      operation_id,operation_generation,ack_id,operation_subject_id,parent_subject_id,
      child_subject_id,relation_key,relation_kind,source_ref_namespace,source_ref_uuid,contract_sha256)
    VALUES ('${WS}','${WS}','${AUTH}','${ACCOUNT}','${OP2}',1,'${ack.ackId}','${otherRoot}',
      '${otherRoot}',${deterministicUuid("other-node","1")},'other:child','MATERIALIZED_CHILD',
      'source_record',${deterministicUuid("other-source","1")},'${CONTRACT}');`);
  return psql(`SELECT child_subject_id::text FROM governed_subject_relation
    WHERE operation_id='${OP2}' AND relation_key='other:child';`);
}

function seedPersonalPath(low, high) {
  seedRoot();
  const highId = psql(`INSERT INTO governed_subject(scope_key,workspace_id,subject_type,
    subject_id,data_class,dsr_subject_type,dsr_subject_id)
    VALUES ('${WS}','${WS}','materialized_record',${deterministicUuid("personal-external","1")},
      'PERSONAL','company','${high}') RETURNING id::text;`);
  const lowId = psql(`INSERT INTO governed_subject(scope_key,workspace_id,subject_type,
    subject_id,data_class,dsr_subject_type,dsr_subject_id)
    VALUES ('${WS}','${WS}','materialized_record',${deterministicUuid("personal-external","2")},
      'PERSONAL','company','${low}') RETURNING id::text;`);
  psql(`INSERT INTO governed_subject_relation(scope_key,workspace_id,authority_id,account_id,
    operation_id,operation_generation,ack_id,operation_subject_id,parent_subject_id,
    child_subject_id,relation_key,relation_kind,source_ref_namespace,source_ref_uuid,contract_sha256)
    VALUES ('${WS}','${WS}','${AUTH}','${ACCOUNT}','${OP}',1,'${facts.ackId}','${rootId}',
      '${rootId}','${highId}','personal:path:high','DERIVED_FROM','source_record',
      ${deterministicUuid("personal-source","1")},'${CONTRACT}'),
      ('${WS}','${WS}','${AUTH}','${ACCOUNT}','${OP}',1,'${facts.ackId}','${rootId}',
      '${highId}','${lowId}','personal:path:low','DERIVED_FROM','source_record',
      ${deterministicUuid("personal-source","2")},'${CONTRACT}');`);
  return lowId;
}

function concurrent(sqlStatements) {
  return Promise.all(sqlStatements.map((sql) => new Promise((resolve) => {
    const child = spawn("docker", dockerArgs(), { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout: stdout.trim(), stderr }));
    child.stdin.end(sql);
  })));
}

function startConnection(sql) {
  const child = spawn("docker", dockerArgs(), { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; let settled = false;
  const listeners = [];
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    for (const listener of listeners) listener(stdout);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.on("close", (status) => {
    settled = true; resolve({ status, stdout: stdout.trim(), stderr });
  }));
  child.stdin.end(sql);
  return {
    done, isSettled: () => settled,
    waitFor: (sentinel) => new Promise((resolve) => {
      if (stdout.includes(sentinel)) resolve();
      else listeners.push((current) => current.includes(sentinel) && resolve());
    }),
  };
}

function startInteractiveConnection(sql) {
  const child = spawn("docker", dockerArgs(), { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = ""; let stderr = ""; let settled = false;
  const listeners = [];
  child.on("error", (error) => { stderr += `${error.message}\n`; });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    for (const listener of listeners) listener(stdout);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.on("close", (status) => {
    settled = true; resolve({ status, stdout: stdout.trim(), stderr });
  }));
  child.stdin.write(sql);
  return {
    done, isSettled: () => settled, output: () => stdout,
    write: (nextSql) => child.stdin.write(nextSql),
    end: () => child.stdin.end(),
    abort: () => child.kill("SIGTERM"),
    waitFor: (sentinel, timeoutMs = 3000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${sentinel}: ${stderr}`)), timeoutMs);
      const observe = (current) => {
        if (!current.includes(sentinel)) return;
        clearTimeout(timer); resolve(current);
      };
      if (stdout.includes(sentinel)) observe(stdout);
      else listeners.push(observe);
    }),
  };
}

async function observeExactAdvisoryWait(holderPid, applicationName, writer, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (writer.isSettled()) {
      const early = await writer.done;
      assert.equal(early.status, 0, early.stderr);
      assert.fail("writer exited before the exact advisory wait was observed");
    }
    const observed = psql(`SELECT count(*) FROM pg_locks holder
      JOIN pg_locks waiter ON waiter.locktype=holder.locktype
        AND waiter.database IS NOT DISTINCT FROM holder.database
        AND waiter.classid IS NOT DISTINCT FROM holder.classid
        AND waiter.objid IS NOT DISTINCT FROM holder.objid
        AND waiter.objsubid IS NOT DISTINCT FROM holder.objsubid
      JOIN pg_stat_activity activity ON activity.pid=waiter.pid
      WHERE holder.pid=${holderPid} AND holder.locktype='advisory' AND holder.granted
        AND NOT waiter.granted AND activity.application_name='${applicationName}';`);
    if (observed === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(`no exact advisory wait observed for ${applicationName}`);
}

async function observeAnyAdvisoryWait(applicationNames, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = psql(`SELECT count(*) FROM pg_locks locks JOIN pg_stat_activity activity
      ON activity.pid=locks.pid WHERE locks.locktype='advisory' AND NOT locks.granted
      AND activity.application_name IN (${applicationNames.map((name) => `'${name}'`).join(",")});`);
    if (Number(observed) >= 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("wrong-order mutant never produced an observed advisory wait");
}

function assertSortedLockKeys(keys) {
  assert.deepEqual(keys, [...keys].sort());
}

describe("governed relation graph concurrency and DSR contract", () => {
  before(() => assert.equal(psql("SELECT current_database()||':'||current_user;"), "gsr_task2:global"));
  beforeEach(() => { reset(); facts = seedOperation(); rootId = null; });

  it("locks the Task1 graph and DSR index support", () => {
    const indexes = psql(`SELECT indexname FROM pg_indexes WHERE schemaname='public'
      AND indexname IN (${INDEXES.map((name) => `'${name}'`).join(",")}) ORDER BY indexname;`).split("\n");
    assert.deepEqual(indexes, [...INDEXES].sort());
    const artifactLockDefinition = psql(`SELECT pg_get_functiondef(p.oid) FROM pg_proc p
      WHERE p.pronamespace='public'::regnamespace
        AND p.proname='bind_workspace_generic_operation_artifact_subject_v1';`);
    assert.match(artifactLockDefinition,
      /generic-operation-artifact-subject:' \|\| p_workspace_id::text/);
  });

  it("accepts depth 64 and rejects depth 65 before any write", () => {
    seedDepth(63);
    const parent = psql(`SELECT child_subject_id::text FROM governed_subject_relation
      WHERE relation_key='depth:63';`);
    psql(asApp(invocation(APPEND, { parentId: parent, relationKey: "depth:64" })));
    const before = graphSnapshot();
    const denied = raw(asApp(invocation(APPEND, {
      parentId: psql(`SELECT child_subject_id::text FROM governed_subject_relation WHERE relation_key='depth:64';`),
      childId: "52000000-0000-4000-8000-000000000065", relationKey: "depth:65",
    })));
    assert.notEqual(denied.status, 0); assert.match(denied.stderr, /GOVERNED_SUBJECT_RELATION_INVALID/);
    assert.equal(graphSnapshot(), before);
  });

  for (const [label, subjects, relations] of [
    ["subjects", 4095, 4094],
    ["relations", 2, 8191],
  ]) {
    it(`accepts the ${label} boundary and rejects the next item pre-write`, () => {
      seedStar(subjects, relations);
      psql(asApp(invocation(APPEND, { relationKey: `${label}:boundary` })));
      const before = graphSnapshot();
      const boundary = JSON.parse(before);
      assert.equal(boundary.subjects, label === "subjects" ? 4096 : 3);
      assert.equal(boundary.relations, label === "relations" ? 8192 : 4095);
      const denied = raw(asApp(invocation(APPEND, {
        childId: label === "subjects" ? "52000000-0000-4000-8000-000000004097" : CHILD,
        relationKey: `${label}:overflow`, sourceUuid: "62000000-0000-4000-8000-000000009999",
      })));
      assert.notEqual(denied.status, 0); assert.match(denied.stderr, /GOVERNED_SUBJECT_RELATION_INVALID/);
      assert.equal(graphSnapshot(), before);
    });
  }

  it("linearizes the same tuple and same-key conflicting tuples", async () => {
    const same = await concurrent([asApp(invocation(APPEND)), asApp(invocation(APPEND))]);
    assert.deepEqual(same.map((result) => result.status), [0, 0]);
    const rows = same.map((result) => result.stdout.split("\n").findLast((line) => line.includes("|")));
    assert.equal(new Set(rows.map((row) => row.split("|").slice(0, 4).join("|"))).size, 1);
    assert.deepEqual(rows.map((row) => row.split("|")[4]).sort(), ["f", "t"]);
    const sameSnapshot = JSON.parse(graphSnapshot());
    assert.equal(sameSnapshot.subjects, 2); assert.equal(sameSnapshot.relations, 1);
    assert.match(sameSnapshot.digest, /^[0-9a-f]{64}$/);
    reset(); facts = seedOperation();
    const conflict = await concurrent([
      asApp(invocation(APPEND)),
      asApp(invocation(APPEND, { sourceUuid: "62000000-0000-4000-8000-000000000002" })),
    ]);
    assert.deepEqual(conflict.map((result) => result.status).sort(), [0, 3]);
    const rejected = conflict.find((result) => result.status !== 0);
    assert.match(rejected.stderr, /GOVERNED_SUBJECT_RELATION_CONFLICT/);
    const snapshot = JSON.parse(graphSnapshot());
    assert.equal(snapshot.subjects, 2);
    assert.equal(snapshot.relations, 1);
    assert.match(snapshot.digest, /^[0-9a-f]{64}$/);
  });

  it("serializes opposite edges without deadlock and leaves an acyclic graph", async () => {
    seedStar(3, 2);
    const [a, b] = psql(`SELECT id::text||'|'||subject_id::text FROM governed_subject
      WHERE subject_type='materialized_record' ORDER BY id;`).split("\n").map((row) => row.split("|"));
    const results = await concurrent([
      asApp(invocation(APPEND, { parentId: a[0], childId: b[1], relationKey: "opposite:a" })),
      asApp(invocation(APPEND, { parentId: b[0], childId: a[1], relationKey: "opposite:b" })),
    ]);
    assert.doesNotMatch(results.map((result) => result.stderr).join("\n"), /deadlock|40P01/i);
    assert.equal(results.filter((result) => result.status === 0).length, 1);
    assert.match(results.find((result) => result.status !== 0).stderr,
      /GOVERNED_SUBJECT_RELATION_INVALID/);
    const cycleCount = psql(`WITH RECURSIVE walk(start_id,node,path,cycle) AS (
      SELECT parent_subject_id,child_subject_id,ARRAY[parent_subject_id,child_subject_id],false
      FROM governed_subject_relation UNION ALL SELECT w.start_id,r.child_subject_id,
      w.path||r.child_subject_id,r.child_subject_id=ANY(w.path) FROM walk w
      JOIN governed_subject_relation r ON r.parent_subject_id=w.node WHERE NOT w.cycle)
      SELECT count(*) FROM walk WHERE cycle;`);
    assert.equal(cycleCount, "0");
    const snapshot = JSON.parse(graphSnapshot());
    assert.equal(snapshot.subjects, 3); assert.equal(snapshot.relations, 3);
    assert.match(snapshot.digest, /^[0-9a-f]{64}$/);
  });

  it("rejects a real parent owned by another operation", () => {
    const parent = seedOtherOperation();
    const denied = raw(asApp(invocation(APPEND, { parentId: parent })));
    assert.notEqual(denied.status, 0); assert.match(denied.stderr, /GOVERNED_SUBJECT_RELATION_INVALID/);
  });

  it("fences every tombstoned node on the root-to-child path for append and attest", () => {
    seedDepth(3);
    const parent = psql(`SELECT child_subject_id::text FROM governed_subject_relation
      WHERE relation_key='depth:3';`);
    const final = psql(asApp(invocation(APPEND, { parentId: parent })));
    const finalChild = final.split("\n").findLast((line) => line.includes("|")).split("|")[2];
    const path = [rootId, ...psql(`SELECT child_subject_id::text FROM governed_subject_relation
      WHERE relation_key LIKE 'depth:%' ORDER BY relation_key;`).split("\n"), finalChild];
    for (const subjectId of path) {
      psql(`INSERT INTO governed_subject_tombstone(workspace_id,governed_subject_id)
        VALUES ('${WS}','${subjectId}');`);
      for (const fn of [APPEND, ATTEST]) {
        const denied = raw(asApp(invocation(fn, { parentId: parent })));
        assert.notEqual(denied.status, 0); assert.match(denied.stderr, /GOVERNED_SUBJECT_TOMBSTONED/);
      }
      psql(`DELETE FROM governed_subject_tombstone WHERE workspace_id='${WS}' AND governed_subject_id='${subjectId}';`);
    }
  });

  it("applies the exact PERSONAL artifact fence but not unrelated or NON_PERSONAL subjects", () => {
    const dsrId = "72000000-0000-4000-8000-000000000001";
    const personal = { childData: "PERSONAL", childDsrType: "company", childDsrId: dsrId };
    psql(asApp(invocation(APPEND, personal)));
    const exactSnapshot = graphSnapshot();
    psql(`INSERT INTO generic_operation_artifact_subject_tombstone(workspace_id,subject_type,subject_id,tombstoned_at)
      VALUES ('${WS}','company','${dsrId}',now()),('${WS}','company',
      '72000000-0000-4000-8000-000000000099',now());`);
    for (const fn of [APPEND, ATTEST]) {
      const denied = raw(asApp(invocation(fn, personal)));
      assert.notEqual(denied.status, 0); assert.match(denied.stderr, /GOVERNED_SUBJECT_TOMBSTONED/);
    }
    assert.equal(graphSnapshot(), exactSnapshot);
    const unrelated = { ...personal, childId: "52000000-0000-4000-8000-000000000002",
      childDsrId: "72000000-0000-4000-8000-000000000002", relationKey: "personal:unrelated" };
    psql(asApp(invocation(APPEND, unrelated)));
    psql(asApp(invocation(ATTEST, unrelated), WS, true));
    const nonpersonal = { childId: dsrId, relationKey: "nonpersonal:unrelated" };
    psql(asApp(invocation(APPEND, nonpersonal)));
    psql(asApp(invocation(ATTEST, nonpersonal), WS, true));
    const snapshot = JSON.parse(graphSnapshot());
    assert.equal(snapshot.subjects, 4); assert.equal(snapshot.relations, 3);
    assert.match(snapshot.digest, /^[0-9a-f]{64}$/);
  });

  it("orders multiple PERSONAL locks with the artifact namespace and never deadlocks", async () => {
    const low = "72000000-0000-4000-8000-000000000001";
    const high = "72000000-0000-4000-8000-000000000002";
    const parent = seedPersonalPath(low, high);
    assertSortedLockKeys([low, high]);
    assert.throws(() => assertSortedLockKeys([high, low]));
    const holder = startInteractiveConnection(`SET application_name='gsr_dsr_holder';
      SET SESSION AUTHORIZATION app_user; BEGIN;
      SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='3s';
      SELECT set_config('app.current_workspace_id','${WS}',true);
      SELECT pg_advisory_xact_lock(hashtextextended(
      'generic-operation-artifact-subject:${WS}:company:${low}',0));
      SELECT pg_backend_pid()::text||'|LOW_LOCK_READY';\n`);
    let writerConnection;
    try {
      const ready = await holder.waitFor("LOW_LOCK_READY");
      const holderPid = Number(ready.match(/(\d+)\|LOW_LOCK_READY/)?.[1]);
      assert.ok(Number.isInteger(holderPid));
      const writerName = "gsr_dsr_writer_exact";
      const writer = `SET application_name='${writerName}';\n${asApp(invocation(APPEND, {
        parentId: parent, childId: "52000000-0000-4000-8000-000000000002",
        relationKey: "personal:final",
      }))}`;
      writerConnection = startConnection(writer);
      await observeExactAdvisoryWait(holderPid, writerName, writerConnection);
      holder.write(`SELECT pg_advisory_xact_lock(hashtextextended(
        'generic-operation-artifact-subject:${WS}:company:${high}',0)); COMMIT;\n`);
      holder.end();
      const results = await Promise.all([holder.done, writerConnection.done]);
      assert.doesNotMatch(results.map((result) => result.stderr).join("\n"), /deadlock|40P01/i);
      assert.ok(results.every((result) => result.status === 0));
    } finally {
      if (!holder.isSettled()) { holder.abort(); holder.end(); }
      if (writerConnection && !writerConnection.isSettled()) writerConnection.abort();
    }
    const snapshot = JSON.parse(graphSnapshot());
    assert.equal(snapshot.subjects, 4); assert.equal(snapshot.relations, 3);
    assert.match(snapshot.digest, /^[0-9a-f]{64}$/);
    assert.equal(psql(`SELECT count(*) FROM governed_subject s LEFT JOIN governed_subject_relation r
      ON r.child_subject_id=s.id WHERE s.workspace_id='${WS}' AND s.id<>'${rootId}' AND r.id IS NULL;`), "0");
    assert.equal(psql(`WITH RECURSIVE walk(node,path,cycle) AS (
      SELECT child_subject_id,ARRAY[parent_subject_id,child_subject_id],false
      FROM governed_subject_relation UNION ALL SELECT r.child_subject_id,
      w.path||r.child_subject_id,r.child_subject_id=ANY(w.path) FROM walk w
      JOIN governed_subject_relation r ON r.parent_subject_id=w.node WHERE NOT w.cycle)
      SELECT count(*) FROM walk WHERE cycle;`), "0");
  });

  it("bounds a controlled wrong-order artifact lock mutant", async () => {
    const low = "72000000-0000-4000-8000-000000000001";
    const high = "72000000-0000-4000-8000-000000000002";
    const beginLock = (name, first) => `SET application_name='${name}';
      SET SESSION AUTHORIZATION app_user; BEGIN; SET LOCAL statement_timeout='4s';
      SET LOCAL lock_timeout='700ms'; SELECT set_config('app.current_workspace_id','${WS}',true);
      SELECT pg_advisory_xact_lock(hashtextextended(
        'generic-operation-artifact-subject:${WS}:company:${first}',0));
      SELECT pg_backend_pid()::text||'|${name}_READY';\n`;
    const lowName = "gsr_wrong_low"; const highName = "gsr_wrong_high";
    const lowConnection = startInteractiveConnection(beginLock(lowName, low));
    const highConnection = startInteractiveConnection(beginLock(highName, high));
    const started = Date.now();
    try {
      await Promise.all([
        lowConnection.waitFor(`${lowName}_READY`),
        highConnection.waitFor(`${highName}_READY`),
      ]);
      lowConnection.write(`SELECT pg_advisory_xact_lock(hashtextextended(
        'generic-operation-artifact-subject:${WS}:company:${high}',0)); COMMIT;\n`);
      highConnection.write(`SELECT pg_advisory_xact_lock(hashtextextended(
        'generic-operation-artifact-subject:${WS}:company:${low}',0)); COMMIT;\n`);
      lowConnection.end(); highConnection.end();
      await observeAnyAdvisoryWait([lowName, highName]);
      const results = await Promise.all([lowConnection.done, highConnection.done]);
      assert.ok(Date.now() - started < 5000);
      assert.ok(results.some((result) => result.status !== 0));
      assert.match(results.map((result) => result.stderr).join("\n"), /deadlock|lock timeout|40P01|55P03/i);
    } finally {
      if (!lowConnection.isSettled()) lowConnection.abort();
      if (!highConnection.isSettled()) highConnection.abort();
    }
  });
});
