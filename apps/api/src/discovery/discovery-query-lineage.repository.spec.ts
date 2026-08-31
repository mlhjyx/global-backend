import { types } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

const moduleUrl = new URL('./discovery-query-lineage.repository.ts', import.meta.url);
const IDS = { workspace:'10000000-0000-4000-8000-000000000001', run:'20000000-0000-4000-8000-000000000001',
  plan:'30000000-0000-4000-8000-000000000001', operation:'40000000-0000-4000-8000-000000000001' };
const SHA='a'.repeat(64), QUERY='b'.repeat(64);
const LINEAGE='c665fc06432925532b3caa20824f9b9a310ce0bdfc497b3c0e688527badcbe0c';
const RAW='dd2f4144f58de22f7415dfc11be56c4828c137e52d34e916852e64cfde38a2e1';

async function load() {
  try {
    const module=await import(moduleUrl.href);
    if(typeof module.appendQueryLineageV2!=='function'||typeof module.attestQueryLineageV2!=='function') throw new Error();
    return module;
  } catch { throw new Error('DISCOVERY_QUERY_LINEAGE_REPOSITORY_MISSING'); }
}
function key(extra={}) { return {schemaVersion:'discovery-query-lineage-lookup/v1',workspaceId:IDS.workspace,
  runId:IDS.run,planId:IDS.plan,queryKey:QUERY,queryOrdinal:0,authorityId:'50000000-0000-4000-8000-000000000001',
  accountKey:`discovery.run:discovery_run:request:${SHA}:${SHA}`,purpose:'discovery.run',subjectType:'discovery_run',
  subjectId:`request:${SHA}`,requestSha256:SHA,...extra}; }
function command(extra={}) { return {schemaVersion:'discovery-query-lineage-command/v2',contractSha256:LINEAGE,
  lookup:{...key(),sourceClass:'public_intelligence'},queryReceipt:{schemaVersion:'discovery-query-receipt/v1',
    queryKey:QUERY,queryOrdinal:0,sourceClass:'public_intelligence',providers:['public_web'],accepted:0,
    quarantined:0,rejected:0,governanceDenied:0,duplicate:0,usageQuantity:0,costCents:0},
  queryReceiptContractSha256:LINEAGE,rawRelationContractSha256:RAW,budgetTruncated:true,attempts:[],items:[],
  authorization:{accountId:'60000000-0000-4000-8000-000000000001',
    authorityId:'50000000-0000-4000-8000-000000000001',generation:1},...extra}; }
function itemCommand(){return command({queryReceipt:{...command().queryReceipt,accepted:1,usageQuantity:1},
  attempts:[{operationId:IDS.operation}],items:[{id:'70000000-0000-4000-8000-000000000001',
    providerKey:'public_web',operationId:IDS.operation,recordIndex:0,resolutionKind:'INSERTED',
    sourceRecordIndex:null,rawRecordId:'80000000-0000-4000-8000-000000000001',
    rawPayloadHash:SHA,rawIngestStatus:'ACCEPTED',relationKey:'discovery.raw_source_record:0'}]});}
function tx(rows){const q=vi.fn(async()=>rows);return {value:{$queryRaw:q,$executeRaw:vi.fn(),$queryRawUnsafe:vi.fn()},q};}
function closed(v,keys){try{if(!v||typeof v!=='object'||Array.isArray(v)||types.isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)return false;
  const d=Object.getOwnPropertyDescriptors(v),k=Reflect.ownKeys(v);return k.length===keys.length&&k.every(x=>typeof x==='string'&&keys.includes(x)&&d[x]?.enumerable&&Object.hasOwn(d[x],'value'));}catch{return false;}}

describe('Discovery query lineage SQL repository',()=>{
  it('preserves the frozen v1 repository surface for historical callers',async()=>{
    const m=await load();
    const v1={...command(),schemaVersion:'discovery-query-lineage-command/v1',
      contractSha256:'eb5f6f09da3e68694b43070eabf2f76340d2c84c8ff6712486495aa64d1630c0',
      queryReceiptContractSha256:'eb5f6f09da3e68694b43070eabf2f76340d2c84c8ff6712486495aa64d1630c0'};
    delete v1.budgetTruncated;
    const append=tx([{status:'APPLIED',attempt_count:0,item_count:0,query_key:QUERY}]);
    await expect(m.appendQueryLineageV1(append.value,v1)).resolves.toMatchObject({status:'APPLIED'});
    expect(append.q.mock.calls[0][0].strings.join('?')).toContain('append_discovery_query_lineage_v1');
    const attest=tx([{status:'NOT_FOUND',query_receipt:null,attempt_count:0,item_count:0,replay:false}]);
    await expect(m.attestQueryLineageV1(attest.value,key())).resolves.toMatchObject({status:'NOT_FOUND'});
    expect(attest.q.mock.calls[0][0].strings.join('?')).toContain('attest_discovery_query_lineage_v1');
  });
  it('mutation-proves closed append and identity-only attest inputs',()=>{
    expect(closed(key(),Object.keys(key()))).toBe(true); expect(closed(command(),Object.keys(command()))).toBe(true);
    expect(closed({...key(),attempts:[]},Object.keys(key()))).toBe(false);
    expect(closed(new Proxy(command(),{}),Object.keys(command()))).toBe(false);
    const a=command();Object.defineProperty(a,'items',{enumerable:true,get:()=>[]});expect(closed(a,Object.keys(command()))).toBe(false);
  });
  it('calls one exact append SQL with the full fresh-only command',async()=>{
    const m=await load(),db=tx([{status:'APPLIED',attempt_count:0,item_count:0,query_key:QUERY}]);
    await expect(m.appendQueryLineageV2(db.value,command())).resolves.toMatchObject({status:'APPLIED'});
    expect(db.q).toHaveBeenCalledOnce();const q=db.q.mock.calls[0][0];expect(q.values).toHaveLength(1);
    expect(q.strings.join('?').replace(/\s+/g,' ').trim()).toBe('SELECT * FROM public.append_discovery_query_lineage_v2(?::jsonb)');
  });
  it('accepts a dense one-item command and exact authorization projection',async()=>{
    const m=await load(),db=tx([{status:'APPLIED',attempt_count:1,item_count:1,query_key:QUERY}]);
    await expect(m.appendQueryLineageV2(db.value,itemCommand())).resolves.toEqual({
      status:'APPLIED',attemptCount:1,itemCount:1,queryKey:QUERY});
    await expect(m.appendQueryLineageV2(tx([]).value,command({authorization:{
      accountId:IDS.workspace,authorityId:IDS.workspace,generation:0}}))).rejects.toThrow();
    await expect(m.appendQueryLineageV2(tx([]).value,command({authorization:{
      accountId:IDS.workspace,authorityId:IDS.workspace,generation:1,extra:true}}))).rejects.toThrow();
  });
  it('attests with identity only and preserves NOT_FOUND and REPLAYED',async()=>{
    const m=await load();for(const row of [{status:'NOT_FOUND',query_receipt:null,budget_truncated:null,attempt_count:0,item_count:0,replay:false},
      {status:'REPLAYED',query_receipt:command().queryReceipt,budget_truncated:true,attempt_count:1,item_count:1,replay:true}]){
      const db=tx([row]);await expect(m.attestQueryLineageV2(db.value,key())).resolves.toMatchObject({
        status:row.status,budgetTruncated:row.budget_truncated,
      });
      expect(db.q.mock.calls[0][0].strings.join('?').replace(/\s+/g,' ').trim())
        .toBe('SELECT * FROM public.attest_discovery_query_lineage_v2(?::jsonb)');}
  });
  it('maps only trusted P0001 integrity HOLD and never leaks SQL or payload',async()=>{
    const m=await load();const hostile=new Error('raw company payload secret@example.test');
    await expect(m.appendQueryLineageV2(tx(hostile).value,command())).rejects.not.toThrow(/secret@example|payload/);
  });
  it('rejects limits, count drift, holes, duplicate indexes and materialization in attest keys',async()=>{
    const m=await load();for(const value of [command({attempts:Array(129).fill({})}),
      command({queryReceipt:{...command().queryReceipt,accepted:1}}),
      command({items:[{recordIndex:1}]}),command({items:[{recordIndex:0},{recordIndex:0}]}),key({items:[]})]){
      const fn='items' in value&&value.schemaVersion==='discovery-query-lineage-lookup/v1'?m.attestQueryLineageV2:m.appendQueryLineageV2;
      await expect(fn(tx([]).value,value)).rejects.toThrow();}
  });
  it('rejects multi-row and malformed database results at the repository boundary',async()=>{
    const m=await load(),applied={status:'APPLIED',attempt_count:0,item_count:0,query_key:QUERY};
    for(const rows of [[],[applied,applied],[{...applied,status:'REPLAYED'}],
      [{...applied,attempt_count:129}],[{...applied,query_key:'bad'}]])
      await expect(m.appendQueryLineageV2(tx(rows).value,command())).rejects.toThrow(
        'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_UNAVAILABLE');
    for(const rows of [[{status:'NOT_FOUND',query_receipt:{},budget_truncated:null,attempt_count:0,item_count:0,replay:false}],
      [{status:'REPLAYED',query_receipt:{queryKey:QUERY},budget_truncated:true,attempt_count:1,item_count:1,replay:true}],
      [{status:'NOT_FOUND',query_receipt:null,budget_truncated:null,attempt_count:1,item_count:0,replay:false}],
      [{status:'REPLAYED',query_receipt:command().queryReceipt,budget_truncated:null,attempt_count:1,item_count:1,replay:true}]])
      await expect(m.attestQueryLineageV2(tx(rows).value,key())).rejects.toThrow(
        'DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_UNAVAILABLE');
  });
});
