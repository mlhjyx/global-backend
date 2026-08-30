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
});
