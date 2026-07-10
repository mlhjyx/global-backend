import { createHash } from 'node:crypto';
import { Tool } from './tool-contract';
import { ToolRegistry } from './tool-registry';
import { searxSearchPaged, SearxResult, SearxCategory } from '../adapters/searxng';
import { crawlUrl } from '../adapters/web-crawler';
import { isAllowedByRobots } from '../adapters/robots';
import { discoverCompaniesByIndustry, WikidataCompany } from '../adapters/wikidata';
import { discoverByArea, OsmPlace } from '../adapters/openstreetmap';
import { resolvePublicIp } from '../adapters/net-guard';
import { smtpRcptProbe, SENDER_DOMAIN } from '../adapters/smtp-probe';

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
  compliance: { sourcePolicy: 'none', respectsRobots: false, personalData: false, allowedPurpose: ['discovery'], reversible: true, authRequired: false, risk: 'low' },
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
  // advisory：标的=任意公司官网（未登记放行，登记即强制 SUSPENDED/用途门）；robots 在 execute 内强制。
  compliance: { sourcePolicy: 'advisory', respectsRobots: true, personalData: false, allowedPurpose: ['discovery', 'enrichment'], reversible: true, authRequired: false, risk: 'low' },
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
  // required：受治理数据源（未登记 fail-closed）；治理域固定为 SPARQL 端点，seed 于 provider.registry。
  compliance: { sourcePolicy: 'required', policyDomain: 'query.wikidata.org', respectsRobots: false, personalData: false, allowedPurpose: ['discovery', 'enrichment'], reversible: true, authRequired: false, risk: 'low' },
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
  // required：受治理数据源；主端点 overpass-api.de（adapter 可能落 kumi 镜像，治理键固定主端点）。
  compliance: { sourcePolicy: 'required', policyDomain: 'overpass-api.de', respectsRobots: false, personalData: false, allowedPurpose: ['discovery'], reversible: true, authRequired: false, risk: 'low' },
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

/** smtp.rcpt_probe —— 邮箱验证的原始 SMTP 出网（端口 25 RCPT 探测，不发 DATA）。 */
export interface SmtpProbeInput {
  /** 邮箱域名（source_policy 以此为键——SUSPENDED/用途门校验的是它，非 MX 主机）。 */
  domain: string;
  /** 已选定的 MX 主机名（工具内再过 SSRF 护栏解析公网 IP 后才连接）。 */
  mxHost: string;
  /** RCPT 目标（真实地址 + 随机地址做 catch-all 探测）。 */
  rcptTo: string[];
}
export interface SmtpProbeOutput {
  reachable: boolean;
  mailFromCode: number | null;
  codes: (number | null)[];
  /** SSRF 护栏拦截（MX 解析到私网/内网 或 直接给 IP）时置位；上层据此判 RISKY，不发生出网。 */
  egressBlocked?: string;
}

/**
 * SMTP RCPT 探测工具（邮箱验证）。**sourcePolicy=advisory** → Broker 执行前按 `domain`
 * 查 source_policy（SUSPENDED 拒 + 用途门），并纳入限流/预算/Trace。SSRF 护栏在 execute 内先行：
 * MX 主机来自外部域名（可被投毒指向内网），解析为公网 IP 才连接，否则 egressBlocked 返回、绝不出网。
 * 不发 DATA（不真正发信）。端口 25 被封/超时 → reachable=false（上层诚实降级 RISKY）。
 */
export const smtpRcptProbeTool: Tool<SmtpProbeInput, SmtpProbeOutput> = {
  id: 'smtp.rcpt_probe',
  version: '1.0.0',
  category: 'verify',
  sourceClass: 'email_verification',
  cost: { unit: 'call', estimatedCents: 0, external: false },
  // MX 出网要克制：低 rps + 小并发，避免被反垃圾 tarpit/拉黑（每域延迟由 source_policy 兜）。
  rateLimit: { rps: 1, concurrency: 2 },
  // personalData:true —— rcptTo 可含具名人邮箱（john.doe@…），RCPT 握手会把地址发给对端 MX；
  // 按仓库 🔴 红线，凡可能承载人名邮箱的工具一律标 true（喂个人数据/脱敏门的工具元数据判据）。
  // 用途门覆盖 source_policy 词表两种用途：邮箱可达性探测属发现/富集流水线的一环，
  // 只要域策略允许其一即放行（仍受 SUSPENDED 硬门约束）；避免只登记 ['discovery'] 的域被误拒。
  // advisory：标的=任意公司邮箱域（要求预登记会杀死邮箱验证）；登记即强制 SUSPENDED/用途门。
  compliance: { sourcePolicy: 'advisory', respectsRobots: false, personalData: true, allowedPurpose: ['discovery', 'enrichment'], reversible: true, authRequired: false, risk: 'medium' },
  capabilities: { produces: [], accepts: ['domain'] },
  idempotencyKey: (i) => `smtp.rcpt_probe:${stableKey({ domain: i.domain, mxHost: i.mxHost, rcptTo: i.rcptTo })}`,
  healthCheck: async () => ({ healthy: true, detail: 'smtp' }),
  execute: async (input) => {
    // 🛡️ SSRF 护栏：连接前解析 MX 主机并拒私网/内网/云元数据 IP，直连解析出的公网 IP
    // （避免 connect 时二次解析的 TOCTOU/DNS rebinding）。拦截即返回，不发生任何出网。
    const guard = await resolvePublicIp(input.mxHost);
    if (!guard.safe || !guard.ip) {
      return { data: { reachable: false, mailFromCode: null, codes: [], egressBlocked: guard.reason ?? 'unsafe' }, costCents: 0 };
    }
    const probe = await smtpRcptProbe(guard.ip, `verify@${SENDER_DOMAIN}`, input.rcptTo);
    return { data: { reachable: probe.reachable, mailFromCode: probe.mailFromCode, codes: probe.codes }, costCents: 0 };
  },
};

/** 注册全部内置工具（启动期调用）。 */
export function registerBuiltinTools(registry: ToolRegistry): ToolRegistry {
  registry.register(searxngSearchTool as Tool);
  registry.register(crawl4aiFetchTool as Tool);
  registry.register(wikidataTool as Tool);
  registry.register(osmOverpassTool as Tool);
  registry.register(smtpRcptProbeTool as Tool);
  return registry;
}
