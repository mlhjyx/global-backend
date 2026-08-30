import { types } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

const moduleUrl = new URL('./discovery-query-lineage.repository.ts', import.meta.url);
const IDS = { workspace:'10000000-0000-4000-8000-000000000001', run:'20000000-0000-4000-8000-000000000001',
  plan:'30000000-0000-4000-8000-000000000001', operation:'40000000-0000-4000-8000-000000000001' };
const SHA='a'.repeat(64), QUERY='b'.repeat(64);

async function load() {
  try {
    const module=await import(moduleUrl.href);
    if(typeof module.appendQueryLineageV1!=='function'||typeof module.attestQueryLineageV1!=='function') throw new Error();
    return module;
  } catch { throw new Error('DISCOVERY_QUERY_LINEAGE_REPOSITORY_MISSING'); }
}
function key(extra={}) { return {schemaVersion:'discovery-query-lineage-lookup/v1',workspaceId:IDS.workspace,
  runId:IDS.run,planId:IDS.plan,queryKey:QUERY,queryOrdinal:0,authorityId:'50000000-0000-4000-8000-000000000001',
  accountKey:`discovery.run:discovery_run:request:${SHA}:${SHA}`,purpose:'discovery.run',subjectType:'discovery_run',
  subjectId:`request:${SHA}`,requestSha256:SHA,...extra}; }
function command(extra={}) { return {schemaVersion:'discovery-query-lineage-command/v1',lookup:key(),
  sourceClass:'company_discovery',providers:['public_web'],attempts:[],items:[],recordCount:0,
  acceptedCount:0,quarantinedCount:0,rejectedCount:0,duplicateCount:0,governanceDeniedCount:0,
  usageQuantity:0,costCents:0,contractSha256:SHA,...extra}; }
function tx(rows){const q=vi.fn(async()=>rows);return {value:{$queryRaw:q,$executeRaw:vi.fn(),$queryRawUnsafe:vi.fn()},q};}
function closed(v,keys){try{if(!v||typeof v!=='object'||Array.isArray(v)||types.isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype)return false;
  const d=Object.getOwnPropertyDescriptors(v),k=Reflect.ownKeys(v);return k.length===keys.length&&k.every(x=>typeof x==='string'&&keys.includes(x)&&d[x]?.enumerable&&Object.hasOwn(d[x],'value'));}catch{return false;}}

describe('Discovery query lineage SQL repository',()=>{
  it('mutation-proves closed append and identity-only attest inputs',()=>{
    expect(closed(key(),Object.keys(key()))).toBe(true); expect(closed(command(),Object.keys(command()))).toBe(true);
    expect(closed({...key(),attempts:[]},Object.keys(key()))).toBe(false);
    expect(closed(new Proxy(command(),{}),Object.keys(command()))).toBe(false);
    const a=command();Object.defineProperty(a,'items',{enumerable:true,get:()=>[]});expect(closed(a,Object.keys(command()))).toBe(false);
  });
  it('calls one exact append SQL with the full fresh-only command',async()=>{
    const m=await load(),db=tx([{status:'APPLIED',attempt_count:0,item_count:0,query_key:QUERY}]);
    await expect(m.appendQueryLineageV1(db.value,command())).resolves.toMatchObject({status:'APPLIED'});
    expect(db.q).toHaveBeenCalledOnce();const q=db.q.mock.calls[0][0];expect(q.values).toHaveLength(1);
    expect(q.strings.join('?').replace(/\s+/g,' ').trim()).toBe('SELECT * FROM public.append_discovery_query_lineage_v1(?::jsonb)');
  });
  it('attests with identity only and preserves NOT_FOUND and REPLAYED',async()=>{
    const m=await load();for(const row of [{status:'NOT_FOUND',query_receipt:null,attempt_count:0,item_count:0,replay:false},
      {status:'REPLAYED',query_receipt:{queryKey:QUERY},attempt_count:1,item_count:1,replay:true}]){
      const db=tx([row]);await expect(m.attestQueryLineageV1(db.value,key())).resolves.toMatchObject({status:row.status});
      expect(db.q.mock.calls[0][0].strings.join('?').replace(/\s+/g,' ').trim())
        .toBe('SELECT * FROM public.attest_discovery_query_lineage_v1(?::jsonb)');}
  });
  it('maps only trusted P0001 integrity HOLD and never leaks SQL or payload',async()=>{
    const m=await load();const hostile=new Error('raw company payload secret@example.test');
    await expect(m.appendQueryLineageV1(tx(hostile).value,command())).rejects.not.toThrow(/secret@example|payload/);
  });
  it('rejects limits, count drift, holes, duplicate indexes and materialization in attest keys',async()=>{
    const m=await load();for(const value of [command({attempts:Array(129).fill({})}),command({recordCount:1}),
      command({items:[{recordIndex:1}]}),command({items:[{recordIndex:0},{recordIndex:0}]}),key({items:[]})]){
      const fn='items' in value&&value.schemaVersion==='discovery-query-lineage-lookup/v1'?m.attestQueryLineageV1:m.appendQueryLineageV1;
      await expect(fn(tx([]).value,value)).rejects.toThrow();}
  });
});
