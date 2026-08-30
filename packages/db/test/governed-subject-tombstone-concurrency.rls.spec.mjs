import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { beforeEach, describe, it } from "node:test";
import * as core from "./governed-subject-relation-append-attest.support.mjs";

const {
  ACCOUNT_A, APPEND, AUTH_A, CHILD_A, CHILD_B, OP_A, SOURCE_B, WS_A,
  asApp, canonicalSnapshot, parseRow, psql, resetDatabase, seedAuthority,
  selectCall, state,
} = core;
const TOMBSTONE = "tombstone_workspace_governed_subject_v1";
const REQUEST_A = "73000000-0000-4000-8000-000000000001";
const REQUEST_B = "73000000-0000-4000-8000-000000000002";
const DSR_A = "74000000-0000-4000-8000-000000000001";
const DSR_B = "74000000-0000-4000-8000-000000000002";
const DSR_PREFIX = "generic-operation-artifact-subject:";
const GRAPH_PREFIX = "governed-subject-relation:";
let first;
let second;

function dockerArgs() {
  assert.match(core.CONTAINER ?? "", /^codex-gsr-task2-pg-[a-z0-9-]+$/);
  return ["exec", "-i", core.CONTAINER, "psql", "-U", "global", "-d", "gsr_task2",
    "--no-psqlrc", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
}

function startConnection(sql, interactive = false) {
  const child = spawn("docker", dockerArgs(), { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const listeners = [];
  child.on("error", (error) => { stderr += `${error.message}\n`; });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
    for (const listener of listeners) listener(stdout);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.on("close", (status) => {
    settled = true;
    resolve({ status, stdout: stdout.trim(), stderr });
  }));
  if (interactive) child.stdin.write(sql); else child.stdin.end(sql);
  return {
    done,
    isSettled: () => settled,
    write: (next) => child.stdin.write(next),
    end: () => { if (!child.stdin.destroyed) child.stdin.end(); },
    abort: () => child.kill("SIGTERM"),
    waitFor: (sentinel, timeout = 4000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${sentinel}: ${stderr}`)), timeout);
      const observe = (value) => {
        if (value.includes(sentinel)) {
          clearTimeout(timer);
          resolve(value);
        }
      };
      if (stdout.includes(sentinel)) observe(stdout); else listeners.push(observe);
    }),
  };
}

async function cleanup(connection, applicationName) {
  if (!connection || connection.isSettled()) return;
  connection.end();
  connection.abort();
  await Promise.race([connection.done, new Promise((resolve) => setTimeout(resolve, 700))]);
  if (!connection.isSettled()) {
    psql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE application_name='${applicationName}' AND pid<>pg_backend_pid();`);
  }
}

async function observeExactWait(holderPid, writerName, writer, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (writer.isSettled()) {
      const result = await writer.done;
      assert.equal(result.status, 0, result.stderr);
    }
    const rows = psql(`SELECT count(*) FROM pg_locks held JOIN pg_locks waiting
      ON waiting.locktype=held.locktype
      AND waiting.database IS NOT DISTINCT FROM held.database
      AND waiting.classid IS NOT DISTINCT FROM held.classid
      AND waiting.objid IS NOT DISTINCT FROM held.objid
      AND waiting.objsubid IS NOT DISTINCT FROM held.objsubid
      JOIN pg_stat_activity activity ON activity.pid=waiting.pid
      WHERE held.pid=${holderPid} AND held.locktype='advisory'
        AND waiting.locktype='advisory' AND held.granted AND NOT waiting.granted
        AND activity.application_name='${writerName}';`);
    if (rows === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(`no exact advisory wait observed for ${writerName}`);
}

function key(kind, dsr = DSR_A) {
  return kind === "dsr"
    ? `${DSR_PREFIX}${WS_A}:company:${dsr}`
    : `${GRAPH_PREFIX}${WS_A}:${OP_A}`;
}

function holder(name, lockKey, sentinel) {
  return startConnection(`SET application_name='${name}'; BEGIN;
    SELECT pg_advisory_xact_lock(hashtextextended('${lockKey}',0));
    SELECT pg_backend_pid()::text||'|${sentinel}';\n`, true);
}

function request(id, dsrId) {
  psql(`INSERT INTO deletion_request(id,workspace_id,subject_type,subject_id,status,
      requested_by,reason,created_at,updated_at)
    VALUES ('${id}','${WS_A}','company','${dsrId}','RECEIVED',
      'task3-concurrency','erasure',now(),now());`);
}

function tombstone(subjectId, requestId) {
  return `SELECT governed_subject_id::text,audit_id::text,outcome
    FROM public.${TOMBSTONE}('${WS_A}'::uuid,'${subjectId}'::uuid,'${requestId}'::uuid);`;
}

function replayFirst() {
  return selectCall(APPEND, state.factsA, {
    childDataClass: "PERSONAL", childDsrSubjectType: "company", childDsrSubjectId: DSR_A,
  });
}

function boundedApp(sql) {
  return asApp(`SET LOCAL statement_timeout='8s'; SET LOCAL lock_timeout='5s'; ${sql}`, WS_A);
}

function setup() {
  psql(`DELETE FROM governed_subject_tombstone_audit;
    DELETE FROM governed_subject_tombstone;
    DELETE FROM deletion_request WHERE id IN ('${REQUEST_A}','${REQUEST_B}');`);
  resetDatabase();
  state.factsA = seedAuthority({
    workspaceId: WS_A, authorityId: AUTH_A, accountId: ACCOUNT_A,
    operationId: OP_A, suffix: "01",
  });
  first = parseRow(psql(asApp(selectCall(APPEND, state.factsA, {
    childDataClass: "PERSONAL", childDsrSubjectType: "company", childDsrSubjectId: DSR_A,
  }), WS_A)));
  second = parseRow(psql(asApp(selectCall(APPEND, state.factsA, {
    childId: CHILD_B, childDataClass: "PERSONAL", childDsrSubjectType: "company",
    childDsrSubjectId: DSR_B, relationKey: "record:second", sourceUuid: SOURCE_B,
  }), WS_A)));
  request(REQUEST_A, DSR_A);
  request(REQUEST_B, DSR_B);
}

function snapshot() {
  return `${canonicalSnapshot()}\n${psql(`SELECT jsonb_build_object(
    'requests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM deletion_request r
      WHERE id IN ('${REQUEST_A}','${REQUEST_B}')),
    'fences',(SELECT jsonb_agg(to_jsonb(f) ORDER BY governed_subject_id)
      FROM governed_subject_tombstone f WHERE workspace_id='${WS_A}'),
    'audits',(SELECT jsonb_agg(to_jsonb(a) ORDER BY deletion_request_id)
      FROM governed_subject_tombstone_audit a WHERE workspace_id='${WS_A}')
  )::text;`)}`;
}

function assertLockTrace(trace, expected) {
  assert.deepEqual(trace, expected);
}

describe("governed subject Task 3 tombstone linearization", () => {
  beforeEach(setup);

  it("mutation-proves the exact DSR then graph observation order", () => {
    const expected = [key("dsr"), key("graph")];
    assertLockTrace(expected, expected);
    assert.throws(() => assertLockTrace([key("graph"), key("dsr")], expected));
    assert.throws(() => assertLockTrace([`${DSR_PREFIX}wrong`, key("graph")], expected));
    assert.throws(() => assertLockTrace([key("graph")], expected));
    const artifactBody = psql(`SELECT pg_get_functiondef(
      'public.tombstone_workspace_generic_operation_artifact_subject_v1(uuid,text,uuid,uuid)'::regprocedure);`);
    assert.match(artifactBody, /generic-operation-artifact-subject:/);
  });

  it("observes the exact artifact DSR wait before the graph wait", async () => {
    const dsrName = "task3_order_dsr";
    const graphName = "task3_order_graph";
    const writerName = "task3_order_writer";
    const dsr = holder(dsrName, key("dsr"), "DSR_READY");
    const graph = holder(graphName, key("graph"), "GRAPH_READY");
    let writer;
    try {
      const [d, g] = await Promise.all([dsr.waitFor("DSR_READY"), graph.waitFor("GRAPH_READY")]);
      const dsrPid = Number(d.match(/(\d+)\|DSR_READY/)?.[1]);
      const graphPid = Number(g.match(/(\d+)\|GRAPH_READY/)?.[1]);
      writer = startConnection(`SET application_name='${writerName}';${boundedApp(
        tombstone(first[2], REQUEST_A),
      )}`);
      await observeExactWait(dsrPid, writerName, writer);
      dsr.write("COMMIT;\n"); dsr.end(); await dsr.done;
      await observeExactWait(graphPid, writerName, writer);
      assertLockTrace([key("dsr"), key("graph")], [key("dsr"), key("graph")]);
      graph.write("COMMIT;\n"); graph.end();
      const result = await writer.done;
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /FENCE_CREATED/);
    } finally {
      await Promise.all([
        cleanup(dsr, dsrName), cleanup(graph, graphName), cleanup(writer, writerName),
      ]);
    }
  });

  it("deterministically commits append replay before the waiting tombstone", async () => {
    const appendName = "task3_append_first";
    const tombstoneName = "task3_append_first_tombstone";
    const before = snapshot();
    const relationCount = psql(`SELECT count(*) FROM governed_subject_relation
      WHERE workspace_id='${WS_A}';`);
    const append = startConnection(`SET application_name='${appendName}';
      SET SESSION AUTHORIZATION app_user; BEGIN;
      SELECT set_config('app.current_workspace_id','${WS_A}',true);
      ${replayFirst()}
      SELECT pg_backend_pid()::text||'|APPEND_READY';\n`, true);
    let writer;
    try {
      const ready = await append.waitFor("APPEND_READY");
      const pid = Number(ready.match(/(\d+)\|APPEND_READY/)?.[1]);
      writer = startConnection(`SET application_name='${tombstoneName}';${boundedApp(
        tombstone(first[2], REQUEST_A),
      )}`);
      await observeExactWait(pid, tombstoneName, writer);
      append.write("COMMIT;\n"); append.end();
      const [appendResult, tombstoneResult] = await Promise.all([append.done, writer.done]);
      assert.equal(appendResult.status, 0, appendResult.stderr);
      assert.match(appendResult.stdout, /\|t$/m);
      assert.equal(tombstoneResult.status, 0, tombstoneResult.stderr);
      assert.match(tombstoneResult.stdout, /FENCE_CREATED/);
      assert.notEqual(snapshot(), before);
      assert.equal(psql(`SELECT count(*) FROM governed_subject_tombstone
        WHERE governed_subject_id='${first[2]}';`), "1");
      assert.equal(psql(`SELECT count(*) FROM governed_subject_tombstone_audit
        WHERE deletion_request_id='${REQUEST_A}';`), "1");
      assert.equal(psql(`SELECT count(*) FROM governed_subject_relation
        WHERE workspace_id='${WS_A}';`), relationCount);
    } finally {
      await Promise.all([cleanup(append, appendName), cleanup(writer, tombstoneName)]);
    }
  });

  it("deterministically commits tombstone before the waiting append", async () => {
    const tombstoneName = "task3_tombstone_first";
    const appendName = "task3_tombstone_first_append";
    const relationCount = psql(`SELECT count(*) FROM governed_subject_relation
      WHERE workspace_id='${WS_A}';`);
    const fence = startConnection(`SET application_name='${tombstoneName}';
      SET SESSION AUTHORIZATION app_user; BEGIN;
      SELECT set_config('app.current_workspace_id','${WS_A}',true);
      ${tombstone(first[2], REQUEST_A)}
      SELECT pg_backend_pid()::text||'|TOMBSTONE_READY';\n`, true);
    let writer;
    try {
      const ready = await fence.waitFor("TOMBSTONE_READY");
      const pid = Number(ready.match(/(\d+)\|TOMBSTONE_READY/)?.[1]);
      writer = startConnection(`SET application_name='${appendName}';${boundedApp(
        replayFirst(),
      )}`);
      await observeExactWait(pid, appendName, writer);
      fence.write("COMMIT;\n"); fence.end();
      const fenceResult = await fence.done;
      const appendResult = await writer.done;
      assert.equal(fenceResult.status, 0, fenceResult.stderr);
      assert.match(fenceResult.stdout, /FENCE_CREATED/);
      assert.notEqual(appendResult.status, 0);
      assert.match(appendResult.stderr, /GOVERNED_SUBJECT_TOMBSTONED/);
      assert.equal(psql(`SELECT count(*) FROM governed_subject_tombstone_audit
        WHERE deletion_request_id='${REQUEST_A}';`), "1");
      assert.equal(psql(`SELECT count(*) FROM governed_subject_relation
        WHERE workspace_id='${WS_A}';`), relationCount);
    } finally {
      await Promise.all([cleanup(fence, tombstoneName), cleanup(writer, appendName)]);
    }
  });

  it("bounds dual PERSONAL tombstones and opposite append attempts without deadlock", async () => {
    const names = ["task3_dual_a", "task3_dual_b", "task3_edge_ab", "task3_edge_ba"];
    const relationCount = Number(psql(`SELECT count(*) FROM governed_subject_relation
      WHERE workspace_id='${WS_A}';`));
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const launch = async (name, sql) => {
      await barrier;
      return startConnection(`SET application_name='${name}';${boundedApp(sql)}`).done;
    };
    const jobs = [
      launch(names[0], tombstone(first[2], REQUEST_A)),
      launch(names[1], tombstone(second[2], REQUEST_B)),
      launch(names[2], selectCall(APPEND, state.factsA, {
        parentId: first[2], childId: CHILD_B, childDataClass: "PERSONAL",
        childDsrSubjectType: "company", childDsrSubjectId: DSR_B,
        relationKey: "edge:a-b", relationKind: "DERIVED_FROM", sourceUuid: SOURCE_B,
      })),
      launch(names[3], selectCall(APPEND, state.factsA, {
        parentId: second[2], childId: CHILD_A, childDataClass: "PERSONAL",
        childDsrSubjectType: "company", childDsrSubjectId: DSR_A,
        relationKey: "edge:b-a", relationKind: "DERIVED_FROM", sourceUuid: SOURCE_B,
      })),
    ];
    release();
    const results = await Promise.all(jobs);
    assert.doesNotMatch(results.map((result) => result.stderr).join("\n"),
      /40P01|deadlock detected/i);
    assert.equal(results[0].status, 0, results[0].stderr);
    assert.equal(results[1].status, 0, results[1].stderr);
    assert.match(results[0].stdout, /FENCE_CREATED/);
    assert.match(results[1].stdout, /FENCE_CREATED/);
    const appendResults = results.slice(2);
    assert.ok(appendResults.filter((result) => result.status === 0).length <= 1);
    for (const result of appendResults.filter((candidate) => candidate.status !== 0)) {
      assert.match(result.stderr,
        /GOVERNED_SUBJECT_TOMBSTONED|GOVERNED_SUBJECT_RELATION_INVALID/);
    }
    assert.equal(psql(`SELECT count(*) FROM governed_subject_tombstone
      WHERE workspace_id='${WS_A}';`), "2");
    assert.equal(psql(`SELECT count(*) FROM governed_subject_tombstone_audit
      WHERE workspace_id='${WS_A}';`), "2");
    assert.ok(Number(psql(`SELECT count(*) FROM governed_subject_relation
      WHERE workspace_id='${WS_A}';`)) <= relationCount + 1);
    assert.equal(psql(`SELECT count(*) FROM governed_subject_relation relation
      LEFT JOIN governed_subject parent ON parent.workspace_id=relation.workspace_id
        AND parent.id=relation.parent_subject_id
      LEFT JOIN governed_subject child ON child.workspace_id=relation.workspace_id
        AND child.id=relation.child_subject_id
      WHERE relation.workspace_id='${WS_A}' AND (parent.id IS NULL OR child.id IS NULL);`), "0");
    assert.equal(psql(`WITH RECURSIVE walk(origin,current,path,cycle) AS (
      SELECT parent_subject_id,child_subject_id,ARRAY[parent_subject_id,child_subject_id],false
      FROM governed_subject_relation WHERE workspace_id='${WS_A}' UNION ALL
      SELECT walk.origin,relation.child_subject_id,walk.path||relation.child_subject_id,
        relation.child_subject_id=ANY(walk.path)
      FROM walk JOIN governed_subject_relation relation
        ON relation.workspace_id='${WS_A}' AND relation.parent_subject_id=walk.current
      WHERE NOT walk.cycle AND cardinality(walk.path)<=66
    ) SELECT count(*) FROM walk WHERE cycle;`), "0");
  });
});
