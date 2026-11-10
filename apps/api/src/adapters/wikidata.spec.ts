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
 it('uses the same P17 country binding for filtering and countryCode enrichment',async()=>{
  const fetchMock=vi.fn(async(_url: string | URL)=>new Response(JSON.stringify({results:{bindings:[]}})));
  vi.stubGlobal('fetch',fetchMock);
  await discoverCompaniesByIndustry({industryQids:['Q1'],countryQid:'Q183'});
  const query=new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('query') ?? '';
  expect(query).toMatch(/\?company\s+wdt:P17\s+\?country\s*\.\s*FILTER\s*\(\s*\?country\s*=\s*wd:Q183\s*\)/s);
  expect(query).toMatch(/\?country\s+wdt:P297\s+\?countryCode/s);
  expect(query).not.toMatch(/\?company\s+wdt:P17\s+wd:Q183/s);
 });

 it('preserves valid identity, name, website, employee count and coordinates',async()=>{
  expect(await parse(binding())).toEqual([{qid:'Q123',name:'Example Works',website:'https://example.test',employees:120,countryCode:'DE',longitude:13.4,latitude:52.5}]);
 });
 it.each(['not-a-qid','P123','Q0','Q01','Q-1','Q1?x=2',''])('drops invalid entity identifier %s',async id=>{
  expect(await parse(binding({company:{type:'uri',value:`https://www.wikidata.org/entity/${id}`}}))).toEqual([]);
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

it.each([
 {type:'literal',value:'Q123'},
 {type:'uri',value:'https://example.test/Q123'},
 {type:'literal',value:'http://www.wikidata.org/entity/Q123'},
 {type:'uri',value:'https://www.wikidata.org/wiki/Q123'},
 {type:'uri',value:'https://www.wikidata.org/entity/Q123#fragment'},
 {type:'uri',value:'https://www.wikidata.org@attacker.test/entity/Q123'},
])('rejects a binding that is not the complete official entity URI %#',async company=>{
 expect(await parse(binding({company}))).toEqual([]);
});
it('accepts the canonical entity URI with HTTPS as well as HTTP',async()=>{
 expect((await parse(binding({company:{type:'uri',value:'https://www.wikidata.org/entity/Q123'}})))[0].qid).toBe('Q123');
});

describe('Wikidata industry subclass closure fallback (vNext W4)', () => {
  it('runs the exact P452 match first and skips the closure query when it hits', async () => {
    const fetchMock = vi.fn(async (_url: string | URL) =>
      new Response(JSON.stringify({ results: { bindings: [binding()] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const rows = await discoverCompaniesByIndustry({ industryQids: ['Q1'] });

    expect(rows).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const query = new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('query') ?? '';
    expect(query).toMatch(/\?company\s+wdt:P452\s+\?industry/s);
    expect(query).toMatch(/VALUES\s+\?industry\s*\{\s*wd:Q1\s*\}/s);
    expect(query).not.toContain('P279*');
  });

  it('falls back to the P279* subclass closure only when the exact match finds nothing', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: { bindings: [] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ results: { bindings: [binding()] } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const rows = await discoverCompaniesByIndustry({ industryQids: ['Q8011'], countryQid: 'Q183' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const closure = new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('query') ?? '';
    // 公司行业是目标行业的子类时（P452 精确匹配漏掉），沿 P279* 闭包再查一次——
    // 闭包查询保留同样的国家过滤与官网约束。
    expect(closure).toMatch(/\?industry\s+wdt:P279\*\s+\?root/s);
    expect(closure).toMatch(/VALUES\s+\?root\s*\{\s*wd:Q8011\s*\}/s);
    expect(closure).toMatch(/\?company\s+wdt:P452\s+\?industry/s);
    expect(closure).toMatch(/\?company\s+wdt:P17\s+\?country\s*\.\s*FILTER\s*\(\s*\?country\s*=\s*wd:Q183\s*\)/s);
    expect(closure).toMatch(/\?company\s+wdt:P856\s+\?website/s);
    expect(rows).toHaveLength(1);
  });
});
