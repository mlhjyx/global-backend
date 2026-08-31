import assert from'node:assert/strict';import{createHash}from'node:crypto';import{spawn,spawnSync}from'node:child_process';import{before,describe,it}from'node:test';
const C=process.env.DISCOVERY_QUERY_LINEAGE_FUNCTIONS_PG_CONTAINER,D=process.env.DISCOVERY_QUERY_LINEAGE_FUNCTIONS_PG_DATABASE??'dql_functions';
const A='append_discovery_query_lineage_v2',T='attest_discovery_query_lineage_v2';
const WS='10000000-0000-4000-8000-000000000001',RUN='20000000-0000-4000-8000-000000000002',PLAN='30000000-0000-4000-8000-000000000001';
const AUTH='40000000-0000-4000-8000-000000000001',ACCOUNT='50000000-0000-4000-8000-000000000001',SHA='b'.repeat(64),QUERY='c'.repeat(64);
const SHA_ITEM='3'.repeat(64);
const RUN_ITEM='20000000-0000-4000-8000-000000000003',AUTH_ITEM='40000000-0000-4000-8000-000000000002',ACCOUNT_ITEM='50000000-0000-4000-8000-000000000002';
const OP_ITEM='60000000-0000-4000-8000-000000000002',RAW_ITEM='70000000-0000-4000-8000-000000000001',RAW_BAD='70000000-0000-4000-8000-000000000002',QUERY_ITEM='e'.repeat(64);
function args(){assert.match(C??'',/^codex-dql-functions-pg-[a-z0-9-]+$/);return['exec','-i',C,'psql','-U','global','-d',D,'-X','-qAt','-v','ON_ERROR_STOP=1'];}
function raw(sql){return spawnSync('docker',args(),{input:sql,encoding:'utf8',maxBuffer:16*1024*1024});}
function psql(sql){const r=raw(sql);assert.equal(r.status,0,`${r.stderr}\n${r.stdout}`);return r.stdout.trim();}
function asyncRaw(sql){return new Promise(resolve=>{const child=spawn('docker',args(),{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);child.on('close',status=>resolve({status,stdout,stderr}));child.stdin.end(sql);});}
function app(sql,ro=false){return`SET SESSION AUTHORIZATION app_user;BEGIN${ro?' READ ONLY':''};SET LOCAL app.current_workspace_id='10000000-0000-4000-8000-000000000001';${sql}COMMIT;`;}
function canonical(value){if(value===null||typeof value==='boolean'||typeof value==='number')return JSON.stringify(value);if(typeof value==='string')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;}
function sha(value){return createHash('sha256').update(value).digest('hex');}
function seedZeroAuthority(){psql(`INSERT INTO workspace(id,name,created_at,updated_at)
  VALUES('${WS}','QTX zero workspace',now(),now()) ON CONFLICT DO NOTHING;
  INSERT INTO execution_budget_authority(id,scope_key,authority_kind,workspace_id,issuer,audience,jti,
    token_sha256,schema_version,purpose,subject_type,subject_id,request_sha256,currency,unit,
    cap_microusd,runs_consumed,issued_at,not_before,expires_at,consumed_at)
  VALUES('${AUTH}','${WS}','WORKSPACE_GRANT','${WS}','https://qtx-zero.test',
    'global-backend:execution-budget','41000000-0000-4000-8000-000000000001',repeat('7',64),
    'execution-budget-grant/v1','discovery.run','discovery_run','request:${SHA}','${SHA}',
    'USD','microusd',1000,1,now()-interval '5 minutes',now()-interval '4 minutes',
    now()-interval '1 minute',now()-interval '2 minutes');`);}
function seedZeroAccount(){psql(`INSERT INTO tool_budget_account(id,scope_key,account_key,generation,
  cap_cents,reserved_cents,charged_cents,exhausted,ref_count,authority_id,
  authorized_cap_microusd,reserved_microusd,charged_microusd,closed_at,created_at,updated_at)
  VALUES('${ACCOUNT}','${WS}','discovery.run:discovery_run:request:${SHA}:${SHA}',1,
    0,0,0,true,0,'${AUTH}',1000,0,0,now()-interval '30 seconds',now(),now());`);}
function seedCompanyOperation(){
 const fetchedAt=new Date().toISOString();const payload={externalId:'qtx.example',name:'QTX Pumps GmbH',
  domain:'qtx.example',attributes:{products:['pump'],keywords:['industrial'],
    extraction_evidence_digest:'e'.repeat(64),extraction_confidence:0.9,
    source_class:'public_intelligence'},provenance:{sourceUrl:'https://qtx.example/company',
    fetchedAt,contentHash:'a'.repeat(64),parserVersion:'public-web/v1'}};
 const policyId='71000000-0000-4000-8000-000000000001';
 psql(`INSERT INTO workspace(id,name,created_at,updated_at) VALUES('${WS}','QTX workspace',now(),now()) ON CONFLICT DO NOTHING;
  INSERT INTO data_provider(id,key,class,status,cost_per_call_cents,created_at)
    VALUES(gen_random_uuid(),'public_web','public_intelligence','ENABLED',0,now());
  INSERT INTO source_policy(id,domain,source_type,access_mode,robots_status,terms_status,
    personal_data,allowed_purpose,crawl_delay_ms,retention_days,review_status,owner,created_at,updated_at)
    VALUES('${policyId}','qtx.example','official_website','crawl','ALLOWS','REVIEWED_OK',
      false,'["discovery"]',0,30,'APPROVED','backend',now(),now());
  INSERT INTO execution_budget_authority(id,scope_key,authority_kind,workspace_id,issuer,audience,jti,
    token_sha256,schema_version,purpose,subject_type,subject_id,request_sha256,currency,unit,
    cap_microusd,runs_consumed,issued_at,not_before,expires_at,consumed_at)
  VALUES('${AUTH_ITEM}','${WS}','WORKSPACE_GRANT','${WS}','https://qtx.test',
    'global-backend:execution-budget','41000000-0000-4000-8000-000000000002',repeat('1',64),
    'execution-budget-grant/v1','discovery.run','discovery_run','request:${SHA_ITEM}','${SHA_ITEM}',
    'USD','microusd',1000,1,now()-interval '30 seconds',now()-interval '20 seconds',
    now()+interval '4 minutes',now()-interval '10 seconds');
  INSERT INTO tool_budget_account(id,scope_key,account_key,generation,cap_cents,reserved_cents,
    charged_cents,exhausted,ref_count,authority_id,authorized_cap_microusd,reserved_microusd,
    charged_microusd,created_at,updated_at)
  VALUES('${ACCOUNT_ITEM}','${WS}','discovery.run:discovery_run:request:${SHA_ITEM}:${SHA_ITEM}',1,
    0,0,0,false,1,'${AUTH_ITEM}',1000,0,50,now(),now());
  DO $seed$ DECLARE base jsonb; projection jsonb; result_digest text; usage jsonb;
  BEGIN base:=jsonb_build_object('schemaVersion','generic-operation-projection/v1','kind','model',
    'schema','discovery-extract-company/v1','data',jsonb_build_object('companies',jsonb_build_array()));
    result_digest:=generic_operation_projection_digest(base);
    projection:=base||jsonb_build_object('digest',result_digest);
    usage:=jsonb_build_object('currency','USD','unit','microusd','callCount',1,
      'upperBoundMicrousd','100');
    INSERT INTO tool_budget_operation(id,scope_key,account_id,generation,operation_key,amount_unit,
      reserved_cents,reserved_microusd,observed_microusd,charged_microusd,result_schema_version,
      result_schema,result_digest,result_json,status,receipt_usage,receipt_cost_basis,settled_at,created_at)
    VALUES('${OP_ITEM}','${WS}','${ACCOUNT_ITEM}',1,'qtx-company-operation','microusd',0,100,50,50,
      'generic-operation-projection/v1','discovery-extract-company/v1',result_digest,projection,
      'SETTLED',usage,'estimated_upper_bound',now(),now());
  END $seed$;
  SET session_replication_role=replica;
  INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status)
    VALUES('${RUN_ITEM}','${WS}','${PLAN}','61000000-0000-4000-8000-000000000001','RUNNING')
    ON CONFLICT DO NOTHING;
  SET session_replication_role=origin;
  SET session_replication_role=replica;
  INSERT INTO raw_source_record(id,workspace_id,run_id,provider_key,source_class,payload,
    ingest_version) VALUES('${RAW_BAD}','${WS}','${RUN_ITEM}','public_web',
    'public_intelligence','{}','fixture/v1');SET session_replication_role=origin;`);
 const writer={schemaVersion:'raw-source-writer/v2',recordId:RAW_ITEM,workspaceId:WS,runId:RUN_ITEM,
  sourceEntityId:null,providerKey:'public_web',sourceClass:'public_intelligence',externalId:payload.externalId,
  payload,sourceUrl:payload.provenance.sourceUrl,fetchedAt,contentHash:payload.provenance.contentHash,
  parserVersion:payload.provenance.parserVersion,ingestKey:`external:${sha(payload.externalId)}`,
  ingestStatus:'ACCEPTED',dispositionCode:null,sourcePolicyId:policyId,retentionDays:30,costCents:0};
 const rawOutput=psql(app(`SELECT raw_record_id::text||'|'||payload_hash FROM
   write_raw_source_record_v2('${JSON.stringify(writer)}'::jsonb);`)).split('\n').at(-1);
 const rawHash=rawOutput.split('|')[1];assert.equal(rawOutput.split('|')[0],RAW_ITEM);
 const domainKey=psql(`SELECT encode(digest(convert_to('${RUN_ITEM}:public_web:${OP_ITEM}','UTF8'),'sha256'),'hex');`);
 const operationDigest=psql(`SELECT result_digest FROM tool_budget_operation WHERE id='${OP_ITEM}';`);
 const revision=psql(`SELECT encode(digest(convert_to('${operationDigest}','UTF8'),'sha256'),'hex');`);
 const ackId=sha(canonical({operationId:OP_ITEM,consumer:'PublicWebDiscoveryProvider.mineDomain',
   domainAggregateType:'RawSourceRecord',domainAckKey:domainKey,domainRevision:revision,
   resultDigest:operationDigest}));
 return{domainKey,operationDigest,revision,ackId,rawHash};
}
describe('Discovery query lineage append and attest database contract',()=>{
 before(()=>{assert.equal(psql(`SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;`),'122');
  assert.equal(psql(`SELECT count(*) FROM information_schema.tables WHERE table_name IN('discovery_query_receipt','discovery_query_operation_attempt','discovery_query_attempt_item','discovery_query_execution_outcome');`),'4');
  assert.equal(psql(`SELECT count(*) FROM _prisma_migrations WHERE migration_name='20260830130200_discovery_query_lineage_execution_outcome' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;`),'1');});
 it('installs exact public signatures, security and app-only execute ACL',()=>{const rows=psql(`SELECT proname||'|'||pg_get_function_identity_arguments(oid)||'|'||provolatile::text||'|'||prosecdef::text||'|'||array_to_string(proconfig,',') FROM pg_proc WHERE proname IN('${A}','${T}') ORDER BY proname;`).split('\n');
  assert.deepEqual(rows,[`${A}|p_append_command jsonb|v|true|search_path=pg_catalog, public`,`${T}|p_attestation_key jsonb|v|true|search_path=pg_catalog, public`]);});
 it('rejects open, oversized and hostile JSON with stable bounded P0001 errors',()=>{for(const fn of[A,T])for(const value of[`'{}'::jsonb`,`'{"extra":true}'::jsonb`,`jsonb_build_object('attempts',to_jsonb(ARRAY(SELECT '{}'::jsonb FROM generate_series(1,129))))`]){
   const r=raw(app(`SELECT * FROM ${fn}(${value});`,fn===T));assert.notEqual(r.status,0);assert.match(r.stderr,/P0001|DISCOVERY_QUERY_LINEAGE/);assert.doesNotMatch(r.stderr,/payload|company name|secret@example/i);}});
 it('returns NOT_FOUND from identity-only attest without mutation',()=>{const before=psql(`SELECT count(*) FROM discovery_query_receipt;`);const key=JSON.stringify({schemaVersion:'discovery-query-lineage-lookup/v1',workspaceId:'10000000-0000-4000-8000-000000000001',runId:'20000000-0000-4000-8000-000000000001',planId:'30000000-0000-4000-8000-000000000001',queryKey:'a'.repeat(64),queryOrdinal:0,authorityId:'40000000-0000-4000-8000-000000000001',accountKey:`discovery.run:discovery_run:request:${'b'.repeat(64)}:${'b'.repeat(64)}`,purpose:'discovery.run',subjectType:'discovery_run',subjectId:`request:${'b'.repeat(64)}`,requestSha256:'b'.repeat(64)});
  const out=psql(app(`SELECT status,replay FROM ${T}('${key}'::jsonb);`,true));assert.equal(out,'NOT_FOUND|f');assert.equal(psql(`SELECT count(*) FROM discovery_query_receipt;`),before);});
 it('appends a fresh zero-company receipt, replays read-only and rejects a second append',()=>{
  psql(`SET session_replication_role=replica;INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status)
    VALUES('${RUN}','${WS}','${PLAN}','60000000-0000-4000-8000-000000000001','RUNNING')
    ON CONFLICT DO NOTHING;SET session_replication_role=origin;`);
  const key={schemaVersion:'discovery-query-lineage-lookup/v1',workspaceId:WS,runId:RUN,
    planId:PLAN,queryKey:QUERY,queryOrdinal:0,authorityId:AUTH,
    accountKey:`discovery.run:discovery_run:request:${SHA}:${SHA}`,purpose:'discovery.run',
    subjectType:'discovery_run',subjectId:`request:${SHA}`,requestSha256:SHA};
  const command={schemaVersion:'discovery-query-lineage-command/v2',contractSha256:'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c',
    lookup:{...key,sourceClass:'public_intelligence'},queryReceipt:{schemaVersion:'discovery-query-receipt/v1',
      queryKey:QUERY,queryOrdinal:0,sourceClass:'public_intelligence',providers:[],accepted:0,
      quarantined:0,rejected:0,governanceDenied:0,duplicate:0,usageQuantity:0,costCents:0},
    queryReceiptContractSha256:'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c',rawRelationContractSha256:'dd2f4144f58de22f7415dfc11be56c4828c137e52d34e916852e64cfde38a2e1',
    budgetTruncated:true,attempts:[],items:[],authorization:{accountId:ACCOUNT,authorityId:AUTH,generation:1}};
  const missingAuthority=raw(app(`SELECT * FROM ${A}('${JSON.stringify(command)}'::jsonb);`));
  assert.notEqual(missingAuthority.status,0);assert.match(missingAuthority.stderr,/QUERY_LINEAGE_INVALID/);
  seedZeroAuthority();
  const missingAccount=raw(app(`SELECT * FROM ${A}('${JSON.stringify(command)}'::jsonb);`));
  assert.notEqual(missingAccount.status,0);assert.match(missingAccount.stderr,/QUERY_LINEAGE_INVALID/);
  seedZeroAccount();
  const wrongAccount=raw(app(`SELECT * FROM ${A}('${JSON.stringify({...command,
    lookup:{...command.lookup,accountKey:'discovery.run:discovery_run:request:'+SHA+':0'.repeat(64)}})}'::jsonb);`));
  assert.notEqual(wrongAccount.status,0);assert.match(wrongAccount.stderr,/QUERY_LINEAGE_INVALID/);
  const badDigest=raw(app(`SELECT * FROM ${A}('${JSON.stringify({...command,contractSha256:'0'.repeat(64)})}'::jsonb);`));
  assert.notEqual(badDigest.status,0);assert.match(badDigest.stderr,/QUERY_LINEAGE_INVALID/);
  for(const providers of [['legacy'],['directory']]){const invalid={...command,
    queryReceipt:{...command.queryReceipt,providers}};const denied=raw(app(`SELECT * FROM ${A}('${JSON.stringify(invalid)}'::jsonb);`));
    assert.notEqual(denied.status,0);assert.match(denied.stderr,/QUERY_LINEAGE_INVALID/);}
  assert.equal(psql(app(`SELECT status,attempt_count,item_count,query_key FROM ${A}('${JSON.stringify(command)}'::jsonb);`)),`APPLIED|0|0|${QUERY}`);
  assert.equal(psql(`SELECT budget_truncated::text FROM discovery_query_execution_outcome WHERE run_id='${RUN}';`),'true');
  assert.equal(psql(app(`SELECT status,replay FROM ${T}('${JSON.stringify(key)}'::jsonb);`,true)),'REPLAYED|t');
  const collision=raw(app(`SELECT * FROM ${T}('${JSON.stringify({...key,queryKey:'d'.repeat(64)})}'::jsonb);`,true));
  assert.notEqual(collision.status,0);assert.match(collision.stderr,/REPLAY_INTEGRITY_HOLD/);
  const replay=raw(app(`SELECT * FROM ${A}('${JSON.stringify(command)}'::jsonb);`));
  assert.notEqual(replay.status,0);assert.match(replay.stderr,/REPLAY_INTEGRITY_HOLD/);
 });
 it('preserves historical v1 attest but holds v2 when no execution outcome exists',()=>{
  const run='20000000-0000-4000-8000-000000000006',query='6'.repeat(64),ordinal=6;
  psql(`SET session_replication_role=replica;INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status)
    VALUES('${run}','${WS}','${PLAN}','61000000-0000-4000-8000-000000000006','RUNNING');
    SET session_replication_role=origin;`);
  const key={schemaVersion:'discovery-query-lineage-lookup/v1',workspaceId:WS,runId:run,
    planId:PLAN,queryKey:query,queryOrdinal:ordinal,authorityId:AUTH,
    accountKey:`discovery.run:discovery_run:request:${SHA}:${SHA}`,purpose:'discovery.run',
    subjectType:'discovery_run',subjectId:`request:${SHA}`,requestSha256:SHA};
  const command={schemaVersion:'discovery-query-lineage-command/v1',
    contractSha256:'eb5f6f09da3e68694b43070eabf2f76340d2c84c8ff6712486495aa64d1630c0',
    lookup:{...key,sourceClass:'public_intelligence'},queryReceipt:{schemaVersion:'discovery-query-receipt/v1',
      queryKey:query,queryOrdinal:ordinal,sourceClass:'public_intelligence',providers:[],accepted:0,
      quarantined:0,rejected:0,governanceDenied:0,duplicate:0,usageQuantity:0,costCents:0},
    queryReceiptContractSha256:'eb5f6f09da3e68694b43070eabf2f76340d2c84c8ff6712486495aa64d1630c0',
    rawRelationContractSha256:'dd2f4144f58de22f7415dfc11be56c4828c137e52d34e916852e64cfde38a2e1',
    attempts:[],items:[],authorization:{accountId:ACCOUNT,authorityId:AUTH,generation:1}};
  assert.equal(psql(app(`SELECT status FROM append_discovery_query_lineage_v1('${JSON.stringify(command)}'::jsonb);`)),'APPLIED');
  assert.equal(psql(app(`SELECT status,replay FROM attest_discovery_query_lineage_v1('${JSON.stringify(key)}'::jsonb);`,true)),'REPLAYED|t');
  assert.equal(psql(`SELECT count(*) FROM discovery_query_execution_outcome WHERE run_id='${run}';`),'0');
  for(const sql of[`SELECT * FROM ${T}('${JSON.stringify(key)}'::jsonb);`,
    `SELECT * FROM ${A}('${JSON.stringify({...command,schemaVersion:'discovery-query-lineage-command/v2',
      contractSha256:'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c',
      queryReceiptContractSha256:'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c',budgetTruncated:false})}'::jsonb);`]){
    const denied=raw(app(sql,sql.includes(T)));assert.notEqual(denied.status,0);assert.match(denied.stderr,/REPLAY_INTEGRITY_HOLD/);
  }
  assert.equal(psql(`SELECT count(*) FROM discovery_query_execution_outcome WHERE run_id='${run}';`),'0');
 });
 it('atomically materializes one Raw v2 relation and attests it read-only',()=>{
  const facts=seedCompanyOperation();
  const key={schemaVersion:'discovery-query-lineage-lookup/v1',workspaceId:WS,runId:RUN_ITEM,
    planId:PLAN,queryKey:QUERY_ITEM,queryOrdinal:1,authorityId:AUTH_ITEM,
    accountKey:`discovery.run:discovery_run:request:${SHA_ITEM}:${SHA_ITEM}`,purpose:'discovery.run',
    subjectType:'discovery_run',subjectId:`request:${SHA_ITEM}`,requestSha256:SHA_ITEM};
  const command={schemaVersion:'discovery-query-lineage-command/v2',
    contractSha256:'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c',
    lookup:{...key,sourceClass:'public_intelligence'},queryReceipt:{schemaVersion:'discovery-query-receipt/v1',
      queryKey:QUERY_ITEM,queryOrdinal:1,sourceClass:'public_intelligence',providers:['public_web'],
      accepted:1,quarantined:0,rejected:0,governanceDenied:0,duplicate:0,usageQuantity:1,costCents:0},
    queryReceiptContractSha256:'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c',
    rawRelationContractSha256:'dd2f4144f58de22f7415dfc11be56c4828c137e52d34e916852e64cfde38a2e1',
    attempts:[{providerKey:'public_web',producerId:'discovery.extract_company',operationId:OP_ITEM,
      authorityId:AUTH_ITEM,accountId:ACCOUNT_ITEM,operationGeneration:1,ackId:facts.ackId,
      consumer:'PublicWebDiscoveryProvider.mineDomain',domainAggregateType:'RawSourceRecord',
      domainAckKey:facts.domainKey,domainRevision:facts.revision,resultDigest:facts.operationDigest,
      resultSchema:'discovery-extract-company/v1',lineageSchema:'discovery-company-result-lineage/v1',
      providerRecordCount:1,coveredItemCount:1,
      contractSha256:'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c'}],
    items:[{id:'80000000-0000-4000-8000-000000000010',providerKey:'public_web',operationId:OP_ITEM,
      recordIndex:0,resolutionKind:'INSERTED',sourceRecordIndex:null,rawRecordId:RAW_ITEM,
      rawPayloadHash:facts.rawHash,rawIngestStatus:'ACCEPTED',relationKey:'discovery.raw_source_record:0',
      sourceRefNamespace:'discovery_query_attempt_item',sourceRefUuid:'80000000-0000-4000-8000-000000000010',
      ackId:facts.ackId,contractSha256:'dd2f4144f58de22f7415dfc11be56c4828c137e52d34e916852e64cfde38a2e1'}],
    budgetTruncated:false,authorization:{accountId:ACCOUNT_ITEM,authorityId:AUTH_ITEM,generation:1}};
  const ackSql=`SELECT status FROM apply_execution_domain_ack_v1('${WS}','${OP_ITEM}',
    'PublicWebDiscoveryProvider.mineDomain','RawSourceRecord','${facts.domainKey}','${facts.revision}');`;
  psql(app(ackSql));
  const historicalAck=raw(app(`SELECT * FROM ${A}('${JSON.stringify(command)}'::jsonb);`));
  assert.notEqual(historicalAck.status,0);assert.match(historicalAck.stderr,/REPLAY_INTEGRITY_HOLD/);
  assert.equal(psql(`SELECT count(*) FROM discovery_query_receipt WHERE run_id='${RUN_ITEM}';`),'0');
  psql(`DELETE FROM execution_domain_ack WHERE ack_id='${facts.ackId}';`);
  for(const invalid of [
    {...command,attempts:[{...command.attempts[0],producerId:'discovery.extract_list'}]},
    {...command,attempts:[{...command.attempts[0],domainAckKey:'0'.repeat(64)}]},
    {...command,attempts:[{...command.attempts[0],coveredItemCount:0}]},
    {...command,attempts:[{...command.attempts[0],contractSha256:'0'.repeat(64)}]},
    {...command,items:[{...command.items[0],recordIndex:1,relationKey:'discovery.raw_source_record:1'}]},
    {...command,items:[{...command.items[0],rawRecordId:RAW_BAD}]},
  ]){const denied=raw(app(`${ackSql}SELECT * FROM ${A}('${JSON.stringify(invalid)}'::jsonb);`));
    assert.notEqual(denied.status,0);assert.match(denied.stderr,/QUERY_LINEAGE/);}
  assert.equal(psql(`SELECT count(*) FROM discovery_query_receipt WHERE run_id='${RUN_ITEM}';`),'0');
  assert.equal(psql(app(`${ackSql}SELECT status,attempt_count,item_count FROM ${A}('${JSON.stringify(command)}'::jsonb);`)).split('\n').at(-1),'APPLIED|1|1');
  assert.equal(psql(`SELECT budget_truncated::text FROM discovery_query_execution_outcome WHERE run_id='${RUN_ITEM}';`),'false');
  assert.equal(psql(`SELECT (SELECT count(*) FROM discovery_query_operation_attempt WHERE operation_id='${OP_ITEM}')||'|'||
    (SELECT count(*) FROM discovery_query_attempt_item WHERE operation_id='${OP_ITEM}')||'|'||
    (SELECT count(*) FROM governed_subject_relation WHERE operation_id='${OP_ITEM}');`),'1|1|1');
  assert.equal(psql(app(`SELECT status,attempt_count,item_count,replay FROM ${T}('${JSON.stringify(key)}'::jsonb);`,true)),'REPLAYED|1|1|t');
  psql(app(`SELECT status FROM apply_execution_domain_ack_v1('${WS}','${OP_ITEM}',
    'PublicWebDiscoveryProvider.mineDomain','CanonicalCompany','${'1'.repeat(64)}','${'2'.repeat(64)}');`));
  const historical=raw(app(`SELECT * FROM ${T}('${JSON.stringify(key)}'::jsonb);`,true));
  assert.notEqual(historical.status,0);assert.match(historical.stderr,/REPLAY_INTEGRITY_HOLD/);
 });
 it('linearizes concurrent same-query append without duplicate rows or deadlock',async()=>{
  const run='20000000-0000-4000-8000-000000000004',query='9'.repeat(64),ordinal=2;
  psql(`SET session_replication_role=replica;INSERT INTO discovery_run(id,workspace_id,plan_id,icp_id,status)
    VALUES('${run}','${WS}','${PLAN}','61000000-0000-4000-8000-000000000004','RUNNING');
    SET session_replication_role=origin;`);
  const key={schemaVersion:'discovery-query-lineage-lookup/v1',workspaceId:WS,runId:run,
    planId:PLAN,queryKey:query,queryOrdinal:ordinal,authorityId:AUTH,
    accountKey:`discovery.run:discovery_run:request:${SHA}:${SHA}`,purpose:'discovery.run',
    subjectType:'discovery_run',subjectId:`request:${SHA}`,requestSha256:SHA};
  const command={schemaVersion:'discovery-query-lineage-command/v2',
    contractSha256:'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c',
    lookup:{...key,sourceClass:'public_intelligence'},queryReceipt:{schemaVersion:'discovery-query-receipt/v1',
      queryKey:query,queryOrdinal:ordinal,sourceClass:'public_intelligence',providers:[],accepted:0,
      quarantined:0,rejected:0,governanceDenied:0,duplicate:0,usageQuantity:0,costCents:0},
    queryReceiptContractSha256:'c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c',
    rawRelationContractSha256:'dd2f4144f58de22f7415dfc11be56c4828c137e52d34e916852e64cfde38a2e1',
    budgetTruncated:false,attempts:[],items:[],authorization:{accountId:ACCOUNT,authorityId:AUTH,generation:1}};
  const sql=app(`SET LOCAL statement_timeout='8s';SELECT status FROM ${A}('${JSON.stringify(command)}'::jsonb);`);
  const results=await Promise.all([asyncRaw(sql),asyncRaw(sql)]);
  assert.deepEqual(results.map(result=>result.status).sort(),[0,3]);
  assert.doesNotMatch(results.map(result=>result.stderr).join('\n'),/40P01|deadlock detected/i);
  assert.equal(psql(`SELECT count(*) FROM discovery_query_receipt WHERE run_id='${run}';`),'1');
 });
 it('blocks zero-item read-only replay after explicit authority revocation',()=>{
  psql(app(`INSERT INTO execution_budget_authority_revocation(scope_key,authority_id,reason)
    VALUES('${WS}','${AUTH}','task4-explicit-revocation');`));
  const key={schemaVersion:'discovery-query-lineage-lookup/v1',workspaceId:WS,runId:RUN,
    planId:PLAN,queryKey:QUERY,queryOrdinal:0,authorityId:AUTH,
    accountKey:`discovery.run:discovery_run:request:${SHA}:${SHA}`,purpose:'discovery.run',
    subjectType:'discovery_run',subjectId:`request:${SHA}`,requestSha256:SHA};
  const before=psql(`SELECT count(*) FROM discovery_query_receipt WHERE run_id='${RUN}';`);
  const denied=raw(app(`SELECT * FROM ${T}('${JSON.stringify(key)}'::jsonb);`,true));
  assert.notEqual(denied.status,0);assert.match(denied.stderr,/REPLAY_INTEGRITY_HOLD/);
  assert.equal(psql(`SELECT count(*) FROM discovery_query_receipt WHERE run_id='${RUN}';`),before);
 });
 it('fails closed for cross-workspace callers and never exposes direct DML',()=>{for(const fn of[A,T]){const r=raw(app(`SELECT * FROM ${fn}('{}'::jsonb);`));assert.notEqual(r.status,0);}for(const table of['discovery_query_receipt','discovery_query_operation_attempt','discovery_query_attempt_item','discovery_query_execution_outcome']){const r=raw(app(`DELETE FROM ${table};`));assert.notEqual(r.status,0);assert.match(r.stderr,/permission denied/);}});
 it('enforces outcome FORCE RLS, SELECT-only ACL and owner immutability',()=>{
  assert.equal(psql(`SELECT relrowsecurity::text||'|'||relforcerowsecurity::text FROM pg_class WHERE relname='discovery_query_execution_outcome';`),'true|true');
  assert.equal(psql(`SELECT string_agg(CASE WHEN grantee=0 THEN 'PUBLIC' ELSE grantee::regrole::text END||':'||privilege_type,',' ORDER BY grantee,privilege_type) FROM aclexplode((SELECT relacl FROM pg_class WHERE relname='discovery_query_execution_outcome')) WHERE grantee=0 OR grantee::regrole::text IN('app_user','execution_budget_platform_writer','runtime_api','runtime_worker','runtime_outbox_relay');`),'app_user:SELECT');
  const ownerUpdate=raw(`UPDATE discovery_query_execution_outcome SET budget_truncated=NOT budget_truncated WHERE run_id='${RUN}';`);
  assert.notEqual(ownerUpdate.status,0);assert.match(ownerUpdate.stderr,/DISCOVERY_QUERY_LINEAGE_IMMUTABLE/);
  const cross=raw(`SET SESSION AUTHORIZATION app_user;BEGIN READ ONLY;SET LOCAL app.current_workspace_id='10000000-0000-4000-8000-000000000002';SELECT count(*) FROM discovery_query_execution_outcome;COMMIT;`);
  assert.equal(cross.status,0);assert.equal(cross.stdout.trim(),'0');
 });
 it('keeps attest persistently read-only and delegates to the frozen v1 graph attest',()=>{const def=psql(`SELECT pg_get_functiondef('${T}(jsonb)'::regprocedure);`);assert.doesNotMatch(def,/\bINSERT\b|\bUPDATE\b|\bDELETE\b/);assert.match(def,/attest_discovery_query_lineage_v1/);assert.doesNotMatch(def,/FROM\s+(?:public\.)?(?:governed_subject|governed_subject_relation|tool_operation_subject)/i);});
});
