import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export const CONTAINER = process.env.GOVERNED_RELATION_TASK2_PG_CONTAINER;
export const DATABASE = process.env.GOVERNED_RELATION_TASK2_PG_DATABASE ?? "gsr_task2";
export const APPEND = "append_workspace_governed_child_relation_v1";
export const ATTEST = "attest_workspace_governed_child_relation_v1";
export const WS_A = "11000000-0000-4000-8000-000000000001";
export const WS_B = "11000000-0000-4000-8000-000000000002";
export const AUTH_A = "21000000-0000-4000-8000-000000000001";
export const AUTH_B = "21000000-0000-4000-8000-000000000002";
export const ACCOUNT_A = "31000000-0000-4000-8000-000000000001";
export const ACCOUNT_B = "31000000-0000-4000-8000-000000000002";
export const OP_A = "41000000-0000-4000-8000-000000000001";
export const OP_A2 = "41000000-0000-4000-8000-000000000011";
export const OP_B = "41000000-0000-4000-8000-000000000002";
export const AUTH_H = "21000000-0000-4000-8000-000000000003";
export const ACCOUNT_H = "31000000-0000-4000-8000-000000000003";
export const OP_H = "41000000-0000-4000-8000-000000000003";
export const OP_RESERVED = "41000000-0000-4000-8000-000000000004";
export const OP_RECEIPT = "41000000-0000-4000-8000-000000000005";
export const OP_ARTIFACT = "41000000-0000-4000-8000-000000000006";
export const ARTIFACT_ID = "51000000-0000-4000-8000-0000000000a6";
export const CHILD_A = "51000000-0000-4000-8000-000000000001";
export const CHILD_B = "51000000-0000-4000-8000-000000000002";
export const SOURCE_A = "61000000-0000-4000-8000-000000000001";
export const SOURCE_B = "61000000-0000-4000-8000-000000000002";
export const CONTRACT_A = "a".repeat(64);
export const CONTRACT_B = "b".repeat(64);
export const MANAGED_ROLES = [
  "app_user", "execution_budget_platform_writer", "runtime_api",
  "runtime_worker", "runtime_outbox_relay",
];
export const TABLES = [
  "governed_subject", "tool_operation_subject", "governed_subject_relation",
  "governed_subject_tombstone", "governed_subject_tombstone_audit",
];
export const ARGUMENTS = [
  "p_workspace_id uuid", "p_authority_id uuid", "p_account_id uuid",
  "p_operation_id uuid", "p_operation_generation integer",
  "p_ack_id character", "p_result_digest character",
  "p_root_subject_type character varying", "p_root_subject_id uuid",
  "p_root_data_class character varying",
  "p_root_dsr_subject_type character varying", "p_root_dsr_subject_id uuid",
  "p_parent_governed_subject_id uuid",
  "p_child_subject_type character varying", "p_child_subject_id uuid",
  "p_child_data_class character varying",
  "p_child_dsr_subject_type character varying", "p_child_dsr_subject_id uuid",
  "p_relation_key character varying", "p_relation_kind character varying",
  "p_source_ref_namespace character varying", "p_source_ref_uuid uuid",
  "p_source_ref_sha256 character", "p_contract_sha256 character",
].join(", ");
export const IDENTITY_TYPES = ARGUMENTS.split(",")
  .map((argument) => argument.trim().split(" ").slice(1).join(" ")).join(",");

export const state = { factsA: undefined, factsB: undefined };

export function requireContainer() {
  assert.match(CONTAINER ?? "", /^codex-gsr-task2-pg-[a-z0-9-]+$/);
  return CONTAINER;
}

export function dockerArgs() {
  assert.equal(DATABASE, "gsr_task2");
  return ["exec", "-i", requireContainer(), "psql", "-U", "global", "-d",
    DATABASE, "--no-psqlrc", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"];
}

export function rawPsql(sql) {
  return spawnSync("docker", dockerArgs(), {
    encoding: "utf8", input: sql, maxBuffer: 16 * 1024 * 1024,
  });
}

export function psql(sql) {
  const result = rawPsql(sql);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

export function asApp(sql, workspaceId, readOnly = false) {
  return `SET SESSION AUTHORIZATION app_user;
    BEGIN${readOnly ? " READ ONLY" : ""};
    SELECT set_config('app.current_workspace_id','${workspaceId}',true);
    ${sql}
    COMMIT;`;
}

export function compact(value) {
  return value.replaceAll('"', "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function functionCatalog(schema, names = [APPEND, ATTEST]) {
  const list = names.map((name) => `'${name}'`).join(",");
  const output = psql(`SELECT jsonb_build_object(
    'name',p.proname,'args',pg_get_function_identity_arguments(p.oid),
    'result',pg_get_function_result(p.oid),'volatility',p.provolatile::text,
    'security',p.prosecdef,'owner',pg_get_userbyid(p.proowner),
    'config',COALESCE(to_jsonb(p.proconfig),'[]'::jsonb),
    'acl',COALESCE((SELECT jsonb_agg(jsonb_build_array(
      x.grantor::regrole::text,CASE WHEN x.grantee=0 THEN 'PUBLIC'
        ELSE x.grantee::regrole::text END,x.privilege_type,x.is_grantable)
      ORDER BY x.grantee,x.privilege_type)
      FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x),'[]')
    )::text FROM pg_proc p
    WHERE p.pronamespace='${schema}'::regnamespace AND p.proname IN (${list})
    ORDER BY p.proname;`);
  return output ? output.split("\n").map(JSON.parse) : [];
}

export function assertExactFunctionCatalog(rows) {
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(compact(row.args), compact(ARGUMENTS));
    assert.equal(compact(row.result), "table(operation_subject_id uuid, parent_subject_id uuid, child_subject_id uuid, relation_id uuid, replay boolean)");
    assert.equal(row.volatility, "v");
    assert.equal(row.security, true);
    assert.equal(row.owner, "global");
    assert.deepEqual(row.config, ["search_path=pg_catalog, public"]);
    assert.deepEqual(row.acl, [
      ["global", "global", "EXECUTE", false],
      ["global", "app_user", "EXECUTE", false],
    ]);
  }
}

export function assertExactHelperPolicy(schema) {
  const output = psql(`SELECT jsonb_build_object(
    'name',p.proname,'owner',pg_get_userbyid(p.proowner),
    'definition',pg_get_functiondef(p.oid),
    'acl',COALESCE((SELECT jsonb_agg(jsonb_build_array(
      x.grantor::regrole::text,CASE WHEN x.grantee=0 THEN 'PUBLIC'
        ELSE x.grantee::regrole::text END,x.privilege_type,x.is_grantable)
      ORDER BY x.grantee,x.privilege_type)
      FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x),'[]')
    )::text FROM pg_proc p WHERE p.pronamespace='${schema}'::regnamespace
      AND p.proname LIKE '\\_%' ORDER BY p.proname;`);
  const helpers = output ? output.split("\n").map(JSON.parse) : [];
  const byName = new Map(helpers.map((helper) => [helper.name, helper]));
  const roots = JSON.parse(psql(`SELECT jsonb_object_agg(p.proname,pg_get_functiondef(p.oid))::text
    FROM pg_proc p WHERE p.pronamespace='${schema}'::regnamespace
      AND p.proname IN ('${APPEND}','${ATTEST}');`));
  const collectReachable = (rootName, readOnly) => {
    const pending = [roots[rootName]];
    const visited = new Set();
    while (pending.length > 0) {
      const definition = pending.pop();
      for (const match of definition.matchAll(/\b(_[a-z0-9_]+)\s*\(/gi)) {
        const name = match[1];
        if (visited.has(name)) continue;
        visited.add(name);
        const helper = byName.get(name);
        assert.ok(helper, `${rootName} helper ${name} must be schema-local and inspectable`);
        assert.equal(helper.owner, "global");
        assert.deepEqual(helper.acl, [["global", "global", "EXECUTE", false]]);
        if (readOnly) {
          assert.doesNotMatch(helper.definition,
            /\b(insert|update|delete|merge|truncate|execute|nextval|setval)\b/i);
        }
        pending.push(helper.definition);
      }
    }
  };
  collectReachable(APPEND, false);
  collectReachable(ATTEST, true);
}

export function createExactMutationBaseline(label) {
  const schema = `task2_mutation_${label}`;
  const returns = `TABLE(operation_subject_id uuid,parent_subject_id uuid,
    child_subject_id uuid,relation_id uuid,replay boolean)`;
  psql(`DROP SCHEMA IF EXISTS ${schema} CASCADE;
    CREATE SCHEMA ${schema};
    CREATE FUNCTION ${schema}._append_writer() RETURNS void LANGUAGE plpgsql
      VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $writer$
      BEGIN DELETE FROM public.governed_subject WHERE false; END $writer$;
    CREATE FUNCTION ${schema}._attest_reader() RETURNS void LANGUAGE sql
      STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $reader$
      SELECT NULL::void $reader$;
    CREATE FUNCTION ${schema}.${APPEND}(${ARGUMENTS}) RETURNS ${returns}
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER
      SET search_path=pg_catalog,public AS $append$ BEGIN
        PERFORM ${schema}._append_writer(); RETURN; END $append$;
    CREATE FUNCTION ${schema}.${ATTEST}(${ARGUMENTS}) RETURNS ${returns}
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public
      AS $attest$ BEGIN PERFORM ${schema}._attest_reader(); RETURN; END $attest$;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC,
      ${MANAGED_ROLES.join(",")};
    GRANT EXECUTE ON FUNCTION ${schema}.${APPEND}(${IDENTITY_TYPES}),
      ${schema}.${ATTEST}(${IDENTITY_TYPES}) TO app_user;`);
  assertExactFunctionCatalog(functionCatalog(schema));
  assertExactHelperPolicy(schema);
  return schema;
}

export function probeInvalidFunctionCatalog(label, mutationSql, helperMutation = false) {
  const schema = createExactMutationBaseline(label);
  try {
    psql(mutationSql(schema));
    if (helperMutation) assert.throws(() => assertExactHelperPolicy(schema));
    else assert.throws(() => assertExactFunctionCatalog(functionCatalog(schema)));
  } finally {
    psql(`DROP SCHEMA ${schema} CASCADE;`);
  }
}

export function resetDatabase() {
  psql(`
    DELETE FROM governed_subject_tombstone_audit;
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
    DELETE FROM workspace WHERE id IN ('${WS_A}','${WS_B}');
  `);
}

export function seedAuthority({
  workspaceId, authorityId, accountId, operationId, suffix,
  expired = false, closed = false, insertWorkspace = true, consumed = true,
}) {
  psql(`
    ${insertWorkspace ? `INSERT INTO workspace(id,name,created_at,updated_at)
      VALUES ('${workspaceId}','Task2 ${suffix}',now(),now());` : ""}
    INSERT INTO execution_budget_authority(
      id,scope_key,authority_kind,workspace_id,issuer,audience,jti,token_sha256,
      schema_version,purpose,subject_type,subject_id,request_sha256,currency,unit,
      cap_microusd,runs_consumed,issued_at,not_before,expires_at,consumed_at
    ) VALUES (
      '${authorityId}','${workspaceId}','WORKSPACE_GRANT','${workspaceId}',
      'https://task2-${suffix}.test','global-backend:execution-budget',
      '22000000-0000-4000-8000-0000000000${suffix}',repeat(right('${suffix}',1),64),
      'execution-budget-grant/v1','icp.design','company',
      '23000000-0000-4000-8000-0000000000${suffix}',repeat('2',64),
      'USD','microusd',1000,1,
      statement_timestamp()-interval '${expired ? "10 minutes" : "30 seconds"}',
      statement_timestamp()-interval '${expired ? "9 minutes" : "20 seconds"}',
      statement_timestamp()${expired ? "-interval '5 minutes'" : "+interval '4 minutes'"},
      ${consumed ? `statement_timestamp()-interval '${expired ? "8 minutes" : "30 seconds"}'` : "NULL"}
    );
    INSERT INTO tool_budget_account(
      id,scope_key,account_key,generation,cap_cents,reserved_cents,charged_cents,
      exhausted,ref_count,authority_id,authorized_cap_microusd,
      reserved_microusd,charged_microusd,created_at,updated_at
    ) VALUES (
      '${accountId}','${workspaceId}','task2-account-${suffix}',1,0,0,0,false,1,
      '${authorityId}',1000,0,0,now(),now()
    );
  `);
  const facts = seedOperation({ workspaceId, authorityId, accountId, operationId, suffix });
  if (closed) {
    psql(`UPDATE tool_budget_account SET exhausted=true,ref_count=0,closed_at=now()
      WHERE id='${accountId}';`);
  }
  return facts;
}

export function seedOperation({ workspaceId, authorityId, accountId, operationId, suffix }) {
  const result = psql(`
    DO $seed$
    DECLARE base jsonb; projection jsonb; digest text; usage jsonb;
    BEGIN
      base := jsonb_build_object(
        'schemaVersion','generic-operation-projection/v1','kind','tool',
        'schema','task2-result/v1','data',jsonb_build_object('status','ok-${suffix}')
      );
      digest := generic_operation_projection_digest(base);
      projection := base || jsonb_build_object('digest',digest);
      usage := jsonb_build_object(
        'currency','USD','unit','microusd','callCount',1,'inputTokens',1,
        'outputTokens',1,'chargedMicrousd','50','upperBoundMicrousd','100'
      );
      INSERT INTO tool_budget_operation(
        id,scope_key,account_id,generation,operation_key,amount_unit,
        reserved_cents,reserved_microusd,observed_microusd,charged_microusd,
        result_schema_version,result_schema,result_digest,result_json,status,
        receipt_usage,receipt_cost_basis,settled_at,created_at
      ) VALUES (
        '${operationId}','${workspaceId}','${accountId}',1,'task2-operation-${suffix}',
        'microusd',0,100,50,50,'generic-operation-projection/v1',
        'task2-result/v1',digest,projection,'SETTLED',usage,'token_pricing',now(),now()
      );
      UPDATE tool_budget_account SET charged_microusd=charged_microusd+50
        WHERE id='${accountId}';
    END $seed$;
    SET SESSION AUTHORIZATION app_user;
    BEGIN;
    SELECT set_config('app.current_workspace_id','${workspaceId}',true);
    SELECT ack_json::text FROM apply_execution_domain_ack_v1(
      '${workspaceId}','${operationId}','Task2Consumer${suffix}','Task2Aggregate',
      repeat('3',64),repeat('4',64)
    );
    COMMIT;
  `).split("\n").filter((line) => line.startsWith("{"));
  const ack = JSON.parse(result.at(-1));
  return {
    workspaceId, authorityId, accountId, operationId, generation: 1,
    ackId: ack.ackId, resultDigest: ack.resultDigest,
  };
}

export function seedReservedOperation() {
  psql(`INSERT INTO tool_budget_operation(
    id,scope_key,account_id,generation,operation_key,amount_unit,
    reserved_cents,reserved_microusd,status,created_at
  ) VALUES ('${OP_RESERVED}','${WS_A}','${ACCOUNT_A}',1,
    'task2-operation-reserved','microusd',0,100,'RESERVED',now());`);
  return { ...state.factsA, operationId: OP_RESERVED };
}

export function seedArtifactOperation() {
  const digest = "d".repeat(64);
  const ackOutput = psql(`DO $artifact$
    DECLARE reference jsonb; usage jsonb;
    BEGIN
      reference := jsonb_build_object(
        'schemaVersion','generic-operation-artifact-ref/v1','artifactId','${ARTIFACT_ID}',
        'operationId','${OP_ARTIFACT}','resultSchema','artifact-result/v1',
        'sha256','${digest}','sizeBytes','128','mediaType','application/json',
        'expiresAt','2036-08-31T00:00:00.000Z');
      usage := jsonb_build_object('currency','USD','unit','microusd','callCount',1,
        'inputTokens',1,'outputTokens',1,'chargedMicrousd','50','upperBoundMicrousd','100');
      INSERT INTO tool_budget_operation(id,scope_key,account_id,generation,operation_key,
        amount_unit,reserved_cents,reserved_microusd,observed_microusd,charged_microusd,
        result_schema_version,result_schema,result_digest,result_json,status,receipt_usage,
        receipt_cost_basis,settled_at,created_at)
      VALUES ('${OP_ARTIFACT}','${WS_A}','${ACCOUNT_A}',1,'artifact-operation','microusd',
        0,100,50,50,'generic-operation-artifact-ref/v1','artifact-result/v1','${digest}',
        reference,'SETTLED',usage,'token_pricing',now(),now());
      UPDATE tool_budget_account SET charged_microusd=charged_microusd+50
        WHERE id='${ACCOUNT_A}';
    END $artifact$;
    SET SESSION AUTHORIZATION app_user; BEGIN;
    SELECT set_config('app.current_workspace_id','${WS_A}',true);
    SELECT ack_json::text FROM apply_execution_domain_ack_v1(
      '${WS_A}','${OP_ARTIFACT}','ArtifactConsumer','ArtifactAggregate',
      repeat('c',64),repeat('d',64)); COMMIT;`)
    .split("\n").findLast((line) => line.startsWith("{"));
  const ack = JSON.parse(ackOutput);
  return { workspaceId: WS_A, authorityId: AUTH_A, accountId: ACCOUNT_A,
    operationId: OP_ARTIFACT, generation: 1, ackId: ack.ackId,
    resultDigest: ack.resultDigest, artifactId: ARTIFACT_ID };
}

export function cloneAckWithDrift(kind, suffix, sourceAckId = state.factsA.ackId) {
  const ackId = suffix.repeat(64);
  const expressions = {
    operationKey: ["'drift-operation-key'", "source.result_strategy", "source.artifact_id", "source.result_schema", "source.usage", "source.cost_basis",
      "jsonb_build_object('operationKey','drift-operation-key')"],
    resultSchema: ["source.operation_key", "source.result_strategy", "source.artifact_id", "'drift-result/v1'", "source.usage", "source.cost_basis",
      "jsonb_build_object('resultSchema','drift-result/v1')"],
    usage: ["source.operation_key", "source.result_strategy", "source.artifact_id", "source.result_schema",
      "jsonb_set(source.usage,'{inputTokens}','2'::jsonb)", "source.cost_basis",
      "jsonb_build_object('usage',jsonb_set(source.usage,'{inputTokens}','2'::jsonb))"],
    costBasis: ["source.operation_key", "source.result_strategy", "source.artifact_id", "source.result_schema", "source.usage", "'provider_reported'",
      "jsonb_build_object('costBasis','provider_reported')"],
    strategy: ["source.operation_key", "'artifact_reference'", "'artifact://drift'", "source.result_schema", "source.usage", "source.cost_basis",
      "jsonb_build_object('resultStrategy','artifact_reference','artifactId','artifact://drift')"],
    artifactId: ["source.operation_key", "source.result_strategy",
      "'51000000-0000-4000-8000-0000000000b6'", "source.result_schema", "source.usage",
      "source.cost_basis", "jsonb_build_object('artifactId','51000000-0000-4000-8000-0000000000b6')"],
  }[kind];
  assert.ok(expressions);
  const [operationKey, strategy, artifact, schema, usage, cost, jsonDrift] = expressions;
  psql(`INSERT INTO execution_domain_ack(
    ack_id,operation_id,operation_key,authority_id,account_id,scope_key,consumer,
    domain_aggregate_type,domain_ack_key,domain_revision,result_strategy,result_schema,
    result_digest,artifact_id,usage,cost_basis,ack_json,created_at
  ) SELECT '${ackId}',source.operation_id,${operationKey},source.authority_id,
    source.account_id,source.scope_key,'Task2Drift${suffix}',source.domain_aggregate_type,
    source.domain_ack_key,source.domain_revision,${strategy},${schema},source.result_digest,
    ${artifact},${usage},${cost},source.ack_json || jsonb_build_object(
      'ackId','${ackId}','consumer','Task2Drift${suffix}') || ${jsonDrift},clock_timestamp()
  FROM execution_domain_ack source WHERE source.ack_id='${sourceAckId}';`);
  return ackId;
}

export function seedDirectRelationForAck(ackId, operationFacts = state.factsA) {
  const rootId = "81000000-0000-4000-8000-000000000001";
  const childId = "81000000-0000-4000-8000-000000000002";
  psql(`INSERT INTO governed_subject(id,scope_key,workspace_id,subject_type,subject_id,data_class)
    VALUES ('${rootId}','${operationFacts.workspaceId}','${operationFacts.workspaceId}',
      'tool_operation','${operationFacts.operationId}','NON_PERSONAL'),
      ('${childId}','${operationFacts.workspaceId}','${operationFacts.workspaceId}',
      'materialized_record','${CHILD_A}','NON_PERSONAL');
    INSERT INTO tool_operation_subject(subject_id,scope_key,workspace_id,authority_id,
      account_id,operation_id,operation_generation,root_subject_id,ack_id,result_digest)
    VALUES ('${rootId}','${operationFacts.workspaceId}','${operationFacts.workspaceId}',
      '${operationFacts.authorityId}','${operationFacts.accountId}',
      '${operationFacts.operationId}',${operationFacts.generation},'${rootId}','${ackId}',
      '${operationFacts.resultDigest}');
    INSERT INTO governed_subject_relation(scope_key,workspace_id,authority_id,account_id,
      operation_id,operation_generation,ack_id,operation_subject_id,parent_subject_id,
      child_subject_id,relation_key,relation_kind,source_ref_namespace,source_ref_uuid,
      contract_sha256)
    VALUES ('${operationFacts.workspaceId}','${operationFacts.workspaceId}',
      '${operationFacts.authorityId}','${operationFacts.accountId}',
      '${operationFacts.operationId}',${operationFacts.generation},'${ackId}',
      '${rootId}','${rootId}','${childId}','record:0','MATERIALIZED_CHILD','source_record',
      '${SOURCE_A}','${CONTRACT_A}');`);
}

export function invocation(functionName, facts, overrides = {}) {
  const input = {
    ...facts,
    rootSubjectType: "tool_operation", rootSubjectId: facts.operationId,
    rootDataClass: "NON_PERSONAL", rootDsrSubjectType: null,
    rootDsrSubjectId: null, parentId: null,
    childType: "materialized_record", childId: CHILD_A,
    childDataClass: "NON_PERSONAL", childDsrSubjectType: null,
    childDsrSubjectId: null, relationKey: "record:0",
    relationKind: "MATERIALIZED_CHILD", sourceNamespace: "source_record",
    sourceUuid: SOURCE_A, sourceSha256: null, contractSha256: CONTRACT_A,
    ...overrides,
  };
  const uuid = (value) => value === null ? "NULL::uuid" : `'${value}'::uuid`;
  const text = (value, type) => value === null ? `NULL::${type}` : `'${value}'::${type}`;
  return `public.${functionName}(
    ${uuid(input.workspaceId)},${uuid(input.authorityId)},${uuid(input.accountId)},
    ${uuid(input.operationId)},${input.generation},${text(input.ackId,"char(64)")},
    ${text(input.resultDigest,"char(64)")},${text(input.rootSubjectType,"varchar(191)")},
    ${uuid(input.rootSubjectId)},${text(input.rootDataClass,"varchar(16)")},
    ${text(input.rootDsrSubjectType,"varchar(191)")},${uuid(input.rootDsrSubjectId)},
    ${uuid(input.parentId)},${text(input.childType,"varchar(191)")},${uuid(input.childId)},
    ${text(input.childDataClass,"varchar(16)")},
    ${text(input.childDsrSubjectType,"varchar(191)")},${uuid(input.childDsrSubjectId)},
    ${text(input.relationKey,"varchar(200)")},${text(input.relationKind,"varchar(32)")},
    ${text(input.sourceNamespace,"varchar(64)")},${uuid(input.sourceUuid)},
    ${text(input.sourceSha256,"char(64)")},${text(input.contractSha256,"char(64)")}
  )`;
}

export function selectCall(functionName, facts, overrides = {}) {
  return `SELECT operation_subject_id::text,parent_subject_id::text,
    child_subject_id::text,relation_id::text,replay
    FROM ${invocation(functionName, facts, overrides)};`;
}

export function canonicalSnapshot() {
  return psql(`
    SELECT jsonb_build_object(
      'authority',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id)
        FROM execution_budget_authority a WHERE workspace_id IN ('${WS_A}','${WS_B}')),
      'revocations',(SELECT jsonb_agg(to_jsonb(r) ORDER BY authority_id)
        FROM execution_budget_authority_revocation r
        WHERE scope_key IN ('${WS_A}','${WS_B}')),
      'accounts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id)
        FROM tool_budget_account a WHERE scope_key IN ('${WS_A}','${WS_B}')),
      'operations',(SELECT jsonb_agg(to_jsonb(o) ORDER BY id)
        FROM tool_budget_operation o WHERE scope_key IN ('${WS_A}','${WS_B}')),
      'acks',(SELECT jsonb_agg(to_jsonb(a) ORDER BY ack_id) FROM execution_domain_ack a
        WHERE scope_key IN ('${WS_A}','${WS_B}')),
      'subjects',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id)
        FROM governed_subject s),
      'operationSubjects',(SELECT jsonb_agg(to_jsonb(s) ORDER BY subject_id)
        FROM tool_operation_subject s),
      'relations',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id)
        FROM governed_subject_relation r),
      'tombstones',(SELECT jsonb_agg(to_jsonb(t) ORDER BY governed_subject_id)
        FROM governed_subject_tombstone t),
      'tombstoneAudit',(SELECT jsonb_agg(to_jsonb(a)
        ORDER BY deletion_request_id,workspace_id,governed_subject_id)
        FROM governed_subject_tombstone_audit a),
      'artifactTombstones',(SELECT jsonb_agg(to_jsonb(t)
        ORDER BY workspace_id,subject_type,subject_id)
        FROM generic_operation_artifact_subject_tombstone t),
      'artifactTombstoneAudit',(SELECT jsonb_agg(to_jsonb(a)
        ORDER BY deletion_request_id,workspace_id,subject_type,subject_id)
        FROM generic_operation_artifact_subject_tombstone_audit a)
    )::text;
  `);
}

export function lifecycleSnapshot(authorityId, accountId, operationId, ackId) {
  return psql(`SELECT jsonb_build_object(
    'authority',(SELECT to_jsonb(a) FROM execution_budget_authority a WHERE id='${authorityId}'),
    'account',(SELECT to_jsonb(a) FROM tool_budget_account a WHERE id='${accountId}'),
    'operation',(SELECT to_jsonb(o) FROM tool_budget_operation o WHERE id='${operationId}'),
    'ack',(SELECT to_jsonb(a) FROM execution_domain_ack a WHERE ack_id='${ackId}')
  )::text;`);
}

export function governedGraphSnapshot() {
  return psql(`SELECT jsonb_build_object(
    'subjects',(SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM governed_subject s),
    'operationSubjects',(SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY subject_id),'[]') FROM tool_operation_subject s),
    'relations',(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM governed_subject_relation r)
  )::text;`);
}

export function captureFailure(functionName, facts, overrides, expectedCode, callerWorkspace = facts.workspaceId) {
  const before = canonicalSnapshot();
  const captured = psql(asApp(`
    CREATE TEMP TABLE error_capture(state text,message text) ON COMMIT DROP;
    DO $capture$
    DECLARE state text; message text;
    BEGIN
      BEGIN
        PERFORM * FROM ${invocation(functionName, facts, overrides)};
        INSERT INTO error_capture VALUES ('00000','NO_ERROR');
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
        INSERT INTO error_capture VALUES (state,message);
      END;
    END $capture$;
    SELECT state||'|'||message FROM error_capture;
  `, callerWorkspace)).split("\n").at(-1);
  assert.equal(captured, `P0001|${expectedCode}`);
  assert.ok(captured.length <= 96);
  assert.doesNotMatch(captured, /@|email|phone|token|secret|prompt|response/i);
  assert.equal(canonicalSnapshot(), before);
}

export function parseRow(output) {
  const row = output.split("\n").at(-1)?.split("|");
  assert.equal(row?.length, 5);
  return row;
}
