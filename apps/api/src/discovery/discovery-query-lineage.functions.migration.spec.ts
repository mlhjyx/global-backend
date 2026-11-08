import {readFile} from 'node:fs/promises';import{describe,expect,it}from'vitest';
const url=new URL('../../../../packages/db/prisma/migrations/20260830130100_discovery_query_lineage_functions/migration.sql',import.meta.url);
function validate(sql){for(const fn of ['append_discovery_query_lineage_v1','attest_discovery_query_lineage_v1']){
  expect(sql).toMatch(new RegExp(`CREATE FUNCTION public\\.${fn}\\([^]*?RETURNS TABLE`,'i'));
  const block=sql.slice(sql.search(new RegExp(`CREATE FUNCTION public\\.${fn}`,'i')));
  expect(block).toMatch(/VOLATILE[\s\S]*SECURITY DEFINER[\s\S]*SET search_path\s*=\s*pg_catalog,\s*public/i);}
  expect(sql).toContain('append_workspace_governed_child_relation_v1');expect(sql).toContain('attest_workspace_governed_child_relation_v1');
  expect(sql).not.toMatch(/FROM\s+public\.(?:governed_subject|tool_operation_subject|governed_subject_relation)/i);
  const attest=sql.slice(sql.indexOf('CREATE FUNCTION public.attest_discovery_query_lineage_v1'));
  expect(attest).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/);expect(attest).toContain('attest_workspace_governed_child_relation_v1');
  expect(sql).toMatch(/execution_domain_ack[\s\S]*RawSourceRecord[\s\S]*CanonicalCompany/);
}
describe('Discovery query lineage functions migration',()=>{
 it('mutation-proves A ownership and read-only attest boundaries',()=>{const f=`CREATE FUNCTION public.append_discovery_query_lineage_v1(jsonb) RETURNS TABLE(x text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN PERFORM append_workspace_governed_child_relation_v1(); END $$;
 CREATE FUNCTION public.attest_discovery_query_lineage_v1(jsonb) RETURNS TABLE(x text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN PERFORM attest_workspace_governed_child_relation_v1(); END $$; -- execution_domain_ack RawSourceRecord CanonicalCompany`;
 expect(()=>validate(f)).not.toThrow();expect(()=>validate(f.replace('attest_workspace','append_workspace'))).toThrow();});
 it('requires additive functions migration only',async()=>{let sql;try{sql=await readFile(url,'utf8');}catch{throw new Error('DISCOVERY_QUERY_LINEAGE_FUNCTIONS_MIGRATION_MISSING');}validate(sql);});
 it('widens the v1 provider allowlist to the lineage v3 sources without changing its pins',async()=>{
  const allowlistUrl=new URL('../../../../packages/db/prisma/migrations/20261108160000_discovery_query_lineage_provider_allowlist/migration.sql',import.meta.url);
  const sql=await readFile(allowlistUrl,'utf8');
  expect(sql).toMatch(/^BEGIN;[\s\S]*COMMIT;\s*$/u);
  expect(sql).toContain('CREATE OR REPLACE FUNCTION public.append_discovery_query_lineage_v1');
  // 冻结的 v1 合同哈希与原三源仍在（对既有回执纯 widen，不重写历史语义）。
  expect(sql).toContain('eb5f6f09da3e68694b43070eabf2f76340d2c84c8ff6712486495aa64d1630c0');
  expect(sql).toContain("'public_web','directory','trade_fair'");
  expect(sql).toContain("provider NOT IN ('public_web','directory','trade_fair','wikidata','openstreetmap','ted','openfda')");
  // 每条 attempt 的 producerId/consumer/resultSchema 与 PROVIDER_CONTRACT、消费绑定一致。
  for(const [producerId,consumer,schema] of[
    ['wikidata.sparql','WikidataDiscoveryProvider','wikidata-sparql/v1'],
    ['osm.overpass','OsmDiscoveryProvider','osm-overpass/v1'],
    ['ted.search','TedDiscoveryProvider','ted-search/v1'],
    ['openfda.search','OpenFdaDiscoveryProvider','openfda-search/v1'],
  ]){
    expect(sql).toContain(`attempt_value->>'producerId'='${producerId}'`);
    expect(sql).toContain(`attempt_consumer='${consumer}'`);
    expect(sql).toContain(`attempt_result_schema='${schema}'`);
  }
  // 加固门：加固迁移之后创建的例程必须以 pg_temp 收尾。
  expect(sql).toMatch(/SET search_path = pg_catalog, public, pg_temp/);
  // 本迁移只碰 append（attest 仍只读且不在此文件）。
  expect(sql).not.toContain('attest_discovery_query_lineage_v1');
 });
});
