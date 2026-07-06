import { createHash } from 'node:crypto';
import { Tool } from './tool-contract';
import { ToolRegistry } from './tool-registry';
import { searxSearchPaged, SearxResult, SearxCategory } from '../adapters/searxng';
import { crawlUrl } from '../adapters/web-crawler';
import { isAllowedByRobots } from '../adapters/robots';
import { discoverCompaniesByIndustry, WikidataCompany } from '../adapters/wikidata';
import { discoverByArea, OsmPlace } from '../adapters/openstreetmap';

const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 24);
const stableKey = (obj: unknown): string => hash(JSON.stringify(obj));

/** searxng.search —— 元搜索发现候选域名（自托管，无需 source_policy）。 */
export const searxngSearchTool: Tool<
  { q: string; categories?: SearxCategory[]; engines?: string[]; language?: string; timeRange?: 'day' | 'week' | 'month' | 'year'; pages?: number },
  { results: SearxResult[] }
> = {
  id: 'searxng.search',
  version: '1.0.0',
  category: 'search',
  sourceClass: 'public_intelligence',
  cost: { unit: 'request', estimatedCents: 0, external: false },
  rateLimit: { rps: 3, concurrency: 3 },
  compliance: { requiresSourcePolicy: false, respectsRobots: false, personalData: false, allowedPurpose: ['discovery'], reversible: true, authRequired: false, risk: 'low' },
  capabilities: { produces: ['domain'], accepts: ['keywords'] },
  idempotencyKey: (i) => `searxng.search:${stableKey(i)}`,
  healthCheck: async () => {
    try {
      const r = await searxSearchPaged({ q: 'test', language: 'en' }, 1, 8000);
      return { healthy: r.length >= 0 };
    } catch {
      return { healthy: false };
    }
  },
  execute: async (input) => {
    const results = await searxSearchPaged(
      { q: input.q, categories: input.categories, engines: input.engines, language: input.language, timeRange: input.timeRange },
      input.pages ?? 1,
    );
    return { data: { results }, costCents: 0 };
  },
};

/** crawl4ai.fetch —— 抓单页（需 source_policy + robots）。 */
export const crawl4aiFetchTool: Tool<{ url: string }, { url: string; text: string; contentHash: string }> = {
  id: 'crawl4ai.fetch',
  version: '1.0.0',
  category: 'fetch',
  sourceClass: 'public_intelligence',
  cost: { unit: 'page', estimatedCents: 1, external: false },
  rateLimit: { rps: 2, concurrency: 3, perDomainCrawlDelayMs: 2000 },
  compliance: { requiresSourcePolicy: true, respectsRobots: true, personalData: false, allowedPurpose: ['discovery', 'enrichment'], reversible: true, authRequired: false, risk: 'low' },
  capabilities: { produces: ['company', 'domain', 'contact'], accepts: ['domain'] },
  idempotencyKey: (i) => `crawl4ai.fetch:${hash(i.url)}`,
  healthCheck: async () => ({ healthy: true, detail: 'crawl4ai' }),
  execute: async (input) => {
    if (!(await isAllowedByRobots(input.url))) {
      // robots 禁抓 → 合规放弃（不换 UA）。返回空文本，不计失败。
      return { data: { url: input.url, text: '', contentHash: '' }, costCents: 0 };
    }
    const r = await crawlUrl(input.url);
    const text = r.text.slice(0, 40_000);
    return {
      data: { url: input.url, text, contentHash: hash(text) },
      costCents: 1,
      provenance: { sourceUrl: input.url, fetchedAt: new Date().toISOString(), contentHash: hash(text), parserVersion: 'crawl4ai/1' },
    };
  },
};

/** wikidata.sparql —— 结构化企业发现（免费 CC0，无需 source_policy）。 */
export const wikidataTool: Tool<
  { industryQids: string[]; countryQid?: string; limit?: number },
  { companies: WikidataCompany[] }
> = {
  id: 'wikidata.sparql',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'company_registry',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 1, concurrency: 1 },
  compliance: { requiresSourcePolicy: false, respectsRobots: false, personalData: false, allowedPurpose: ['discovery', 'enrichment'], reversible: true, authRequired: false, risk: 'low' },
  capabilities: { produces: ['company', 'relation'], accepts: ['keywords'], enrichesOnly: false },
  idempotencyKey: (i) => `wikidata.sparql:${stableKey(i)}`,
  healthCheck: async () => ({ healthy: true, detail: 'wdqs' }),
  execute: async (input) => {
    const companies = await discoverCompaniesByIndustry({ industryQids: input.industryQids, countryQid: input.countryQid, limit: input.limit ?? 50 });
    return {
      data: { companies },
      costCents: 0,
      provenance: { sourceUrl: 'https://query.wikidata.org/sparql', fetchedAt: new Date().toISOString(), parserVersion: 'wikidata/1' },
    };
  },
};

/** osm.overpass —— 工业标签+地区发现 / 实体校验（免费 ODbL）。 */
export const osmOverpassTool: Tool<
  { areaName: string; tagFilters: { k: string; v?: string }[]; limit?: number },
  { places: OsmPlace[] }
> = {
  id: 'osm.overpass',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'industry_data',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 1, concurrency: 1 },
  compliance: { requiresSourcePolicy: false, respectsRobots: false, personalData: false, allowedPurpose: ['discovery'], reversible: true, authRequired: false, risk: 'low' },
  capabilities: { produces: ['company'], accepts: ['coordinates', 'keywords'] },
  idempotencyKey: (i) => `osm.overpass:${stableKey(i)}`,
  healthCheck: async () => ({ healthy: true, detail: 'overpass' }),
  execute: async (input) => {
    const places = await discoverByArea({ areaName: input.areaName, tagFilters: input.tagFilters, limit: input.limit ?? 80 });
    return {
      data: { places },
      costCents: 0,
      provenance: { sourceUrl: 'overpass-api', fetchedAt: new Date().toISOString(), parserVersion: 'osm/1' },
    };
  },
};

/** 注册全部内置工具（启动期调用）。 */
export function registerBuiltinTools(registry: ToolRegistry): ToolRegistry {
  registry.register(searxngSearchTool as Tool);
  registry.register(crawl4aiFetchTool as Tool);
  registry.register(wikidataTool as Tool);
  registry.register(osmOverpassTool as Tool);
  return registry;
}
