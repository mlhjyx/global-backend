import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverCompaniesByIndustry } from './wikidata';
const binding=(changes:Record<string,unknown>={})=>({
 company:{type:'uri',value:'http://www.wikidata.org/entity/Q123'},
 companyLabel:{type:'literal',value:'Example Works'},
 website:{type:'uri',value:'https://example.test'},
 employees:{type:'literal',value:'120'},
 countryCode:{type:'literal',value:'DE'},
 coord:{type:'literal',value:'Point(13.4 52.5)'},...changes,
});
async function parse(row:unknown){
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({results:{bindings:[row]}}),{status:200})));
 return discoverCompaniesByIndustry({industryQids:['Q1']});
}
afterEach(()=>vi.unstubAllGlobals());
describe('Wikidata SPARQL company binding validation',()=>{
 it('preserves valid identity, name, website, employee count and coordinates',async()=>{
  expect(await parse(binding())).toEqual([{qid:'Q123',name:'Example Works',website:'https://example.test',employees:120,countryCode:'DE',longitude:13.4,latitude:52.5}]);
 });
 it.each(['not-a-qid','P123','Q0','Q01','Q-1','Q1?x=2',''])('drops invalid entity identifier %s',async id=>{
  expect(await parse(binding({company:{type:'uri',value:`https://example.test/${id}`}}))).toEqual([]);
 });
 it.each(['NaN','Infinity','-Infinity','not-a-number'])('omits nonfinite employee value %s',async employees=>{
  const [row]=await parse(binding({employees:{type:'literal',value:employees}}));expect(row.employees).toBeUndefined();expect(row.qid).toBe('Q123');
 });
 it.each(['0','120.5','-1'])('preserves existing finite number semantics for %s',async employees=>{
  const [row]=await parse(binding({employees:{type:'literal',value:employees}}));expect(row.employees).toBe(Number(employees));
 });
 it('normalizes two-letter country codes',async()=>{
  expect((await parse(binding({countryCode:{type:'literal',value:' de '}})))[0].countryCode).toBe('DE');
 });
 it.each(['DEU','D','12','', 'DÉ'])('omits invalid country code %s',async countryCode=>{
  expect((await parse(binding({countryCode:{type:'literal',value:countryCode}})))[0].countryCode).toBeUndefined();
 });
 it('preserves missing optional fields and skips missing or identifier-only labels',async()=>{
  const [row]=await parse(binding({employees:undefined,countryCode:undefined,coord:undefined,website:undefined}));
  expect(row.employees).toBeUndefined();expect(row.countryCode).toBeUndefined();expect(row.latitude).toBeUndefined();
  for(const label of ['', 'Q123'])expect(await parse(binding({companyLabel:{type:'literal',value:label}}))).toEqual([]);
 });
});
