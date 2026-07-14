import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Tool } from './tool-contract';
import { ToolRegistry } from './tool-registry';
import { crawlHtml, CrawlHtmlResult } from '../adapters/web-crawler';
import { isAllowedByRobots } from '../adapters/robots';
import { resolvePublicIp } from '../adapters/net-guard';
import { wikidataSearchEntity, wikidataGetEntities, WikidataEntitySummary, RawEntity } from '../adapters/wikidata';
import { searchLeiRecords, getDirectParent, getUltimateParent, GleifRecord, GleifParent } from '../adapters/gleif';
import {
  searchAwardNotices,
  searchContractNotices,
  SearchAwardParams,
  TedAwardNotice,
  TedContractNotice,
} from '../adapters/ted-api';
import {
  searchRegistrations,
  search510kClearances,
  RegistrationSearchParams,
  Search510kParams,
  OpenFdaEstablishment,
  Fda510kClearance,
} from '../adapters/openfda-api';
import { queryAlgoliaExhibitors, AlgoliaFairConfig, FairExhibitor } from '../adapters/trade-fair-algolia';
import { searchCompanies, listOfficers, ChCompanyHit, ChOfficer } from '../adapters/companies-house';
import { searchCompaniesWithDirigeants, FrCompanyHit } from '../adapters/inpi-rne';
import { bigqueryPatents, PatentRecord } from '../adapters/bigquery-patents';
import { fetchSourcesSought, SamSourcesSought, SamSearchParams } from '../adapters/sam-api';

/**
 * 受治理数据源 + 标的站点的 L0 工具（收口②：主链出网收编进 ToolBroker）。
 * builtin-tools 是自托管基座五件套；本文件是各外部数据源的治理包装——
 * **required** 工具的 policyDomain 固定治理域，未在 source_policy 登记即 fail-closed。
 *
 * 登记例外（不经 Broker 的出网，理由见 docs/architecture/current.md §7）：
 *  - robots.txt 抓取（adapters/robots.ts）——合规探测本身；
 *  - DNS 解析（resolveMx/lookup，net-guard/digital-footprint/email-verify）——非 HTTP，SSRF 护栏原语；
 *  - 模型网关 new-api（model-gateway/*）——内部基座，预算/trace 由 ModelGateway 层强制；
 *  - outbox relay webhook（relay/outbox-relay.service.ts）——B 侧交付契约，由 outbox_delivery 账本治理。
 */

const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 24);
const stableKey = (obj: unknown): string => hash(JSON.stringify(obj));

/** crawl4ai.render —— 渲染后原始 HTML（数字足迹/结构化收割/web_watch 用；robots 在内强制）。 */
export const crawl4aiRenderTool: Tool<{ url: string }, CrawlHtmlResult & { robotsBlocked?: boolean }> = {
  id: 'crawl4ai.render',
  version: '1.0.0',
  category: 'fetch',
  sourceClass: 'public_intelligence',
  cost: { unit: 'page', estimatedCents: 1, external: false },
  rateLimit: { rps: 1, concurrency: 3, perDomainCrawlDelayMs: 2000 },
  compliance: { sourcePolicy: 'advisory', respectsRobots: true, personalData: false, allowedPurpose: ['discovery', 'enrichment'], reversible: true, authRequired: false, risk: 'low' },
  capabilities: { produces: ['company', 'domain', 'contact'], accepts: ['domain'] },
  idempotencyKey: (i) => `crawl4ai.render:${hash(i.url)}`,
  healthCheck: async () => ({ healthy: true, detail: 'crawl4ai' }),
  execute: async (input) => {
    if (!(await isAllowedByRobots(input.url))) {
      // robots 禁抓 → 合规放弃（不换 UA）。空 HTML 返回，不计费。
      return { data: { url: input.url, html: '', headers: {}, robotsBlocked: true }, costCents: 0 };
    }
    const r = await crawlHtml(input.url);
    return {
      data: r,
      costCents: 1,
      provenance: { sourceUrl: input.url, fetchedAt: new Date().toISOString(), contentHash: hash(r.html), parserVersion: 'crawl4ai/1' },
    };
  },
};

export interface HttpGetInput {
  url: string;
  method?: 'GET' | 'HEAD';
  timeoutMs?: number;
  /** 附加请求头（结构化端点需要的 UA/Accept 等）。 */
  headers?: Record<string, string>;
}
export interface HttpGetOutput {
  status: number;
  ok: boolean;
  /** GET 时的响应体文本（HEAD 恒空）。 */
  text: string;
  /** 重定向后最终落地 URL（careers 探测等证据记录用）。 */
  finalUrl?: string;
  /** SSRF 护栏拦截原因（命中则未发生出网）。 */
  blocked?: string;
}

const HTTP_GET_UA = 'Mozilla/5.0 (compatible; GlobalBot/1.0)';
const MAX_REDIRECT_HOPS = 3;

/**
 * http.get —— 标的站点的轻量 GET/HEAD（sitemap/careers 探测）。SSRF 护栏在内强制：
 * 初始 URL + **每一跳重定向目标**都先解析为公网 IP 才出网（redirect:'manual' 逐跳护栏——
 * 复审 HIGH：follow 模式下攻击者可用 30x 跳内网/云元数据）。残余 TOCTOU（校验与连接间
 * DNS rebinding 窗口）与 main 的原实现同级，根治需连接层 IP pinning，记档待收口⑥安全加固。
 */
export const httpGetTool: Tool<HttpGetInput, HttpGetOutput> = {
  id: 'http.get',
  version: '1.0.0',
  category: 'fetch',
  sourceClass: 'public_intelligence',
  cost: { unit: 'request', estimatedCents: 0, external: false },
  rateLimit: { rps: 3, concurrency: 4, perDomainCrawlDelayMs: 500 },
  compliance: { sourcePolicy: 'advisory', respectsRobots: false, personalData: false, allowedPurpose: ['discovery', 'enrichment'], reversible: true, authRequired: false, risk: 'low' },
  capabilities: { produces: ['domain'], accepts: ['domain'] },
  idempotencyKey: (i) => `http.get:${stableKey({ url: i.url, method: i.method ?? 'GET' })}`,
  healthCheck: async () => ({ healthy: true, detail: 'fetch' }),
  execute: async (input) => {
    let url = input.url;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      // 🛡️ SSRF 护栏：sitemap 内 URL 与重定向 Location 都是攻击者可控输入——逐跳解析公网 IP 才出网。
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return { data: { status: 0, ok: false, text: '', blocked: 'invalid_url' }, costCents: 0 };
      }
      const guard = await resolvePublicIp(host);
      if (!guard.safe) {
        return { data: { status: 0, ok: false, text: '', blocked: guard.reason ?? 'unsafe' }, costCents: 0 };
      }
      res = await fetch(url, {
        method: input.method ?? 'GET',
        // WAF 站点对 node 默认 UA 静默拒（复审 medium）——默认可识别 bot UA，调用方可覆盖。
        headers: { 'User-Agent': HTTP_GET_UA, ...input.headers },
        signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) break;
        url = new URL(loc, url).toString(); // 相对 Location 归一
        continue;
      }
      break;
    }
    if (!res) return { data: { status: 0, ok: false, text: '', blocked: 'no_response' }, costCents: 0 };
    if (res.status >= 300 && res.status < 400) {
      // 跳数用尽仍在重定向 → 视作拦截（绝不无界跟随）
      return { data: { status: res.status, ok: false, text: '', finalUrl: url, blocked: 'too_many_redirects' }, costCents: 0 };
    }
    let text = '';
    if (input.method !== 'HEAD') {
      // gzip 魔数透明解压（sitemap.xml.gz 常见；与原 fetchText 实现对齐）
      let buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        try {
          buf = gunzipSync(buf);
        } catch {
          // 损坏的 gz → 保留原字节的文本化（下游解析器自然解不出内容，fail-safe）
        }
      }
      text = buf.toString('utf8').slice(0, 3_000_000);
    }
    return { data: { status: res.status, ok: res.ok, text, finalUrl: url }, costCents: 0 };
  },
};

export type WikidataEntityInput =
  | { op: 'search'; name: string; limit?: number }
  | { op: 'get'; qids: string[]; props?: string };
export interface WikidataEntityOutput {
  search?: WikidataEntitySummary[];
  entities?: Record<string, RawEntity>;
}

/** wikidata.entity —— Wikidata REST（wbsearchentities/wbgetentities，富集用）。 */
export const wikidataEntityTool: Tool<WikidataEntityInput, WikidataEntityOutput> = {
  id: 'wikidata.entity',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'company_registry',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 2, concurrency: 2 },
  compliance: { sourcePolicy: 'required', policyDomain: 'www.wikidata.org', respectsRobots: false, personalData: false, allowedPurpose: ['discovery', 'enrichment'], reversible: true, authRequired: false, risk: 'low' },
  capabilities: { produces: ['company', 'relation'], accepts: ['keywords'], enrichesOnly: true },
  idempotencyKey: (i) => `wikidata.entity:${stableKey(i)}`,
  healthCheck: async () => ({ healthy: true, detail: 'wikidata-api' }),
  execute: async (input) => {
    if (input.op === 'search') {
      return { data: { search: await wikidataSearchEntity(input.name, input.limit) }, costCents: 0 };
    }
    return { data: { entities: await wikidataGetEntities(input.qids, input.props) }, costCents: 0 };
  },
};

export type GleifFetchInput =
  | { op: 'search'; name: string; country?: string; limit?: number }
  | { op: 'directParent'; lei: string }
  | { op: 'ultimateParent'; lei: string };
export interface GleifFetchOutput {
  records?: GleifRecord[];
  parent?: GleifParent | null;
}

/** gleif.fetch —— GLEIF LEI API（法律身份/母子关系富集，CC0）。 */
export const gleifFetchTool: Tool<GleifFetchInput, GleifFetchOutput> = {
  id: 'gleif.fetch',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'company_registry',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 2, concurrency: 2 },
  compliance: { sourcePolicy: 'required', policyDomain: 'api.gleif.org', respectsRobots: false, personalData: false, allowedPurpose: ['discovery', 'enrichment'], reversible: true, authRequired: false, risk: 'low' },
  capabilities: { produces: ['company', 'relation'], accepts: ['lei', 'keywords'], enrichesOnly: true },
  idempotencyKey: (i) => `gleif.fetch:${stableKey(i)}`,
  healthCheck: async () => ({ healthy: true, detail: 'gleif' }),
  execute: async (input) => {
    if (input.op === 'search') {
      return { data: { records: await searchLeiRecords({ name: input.name, country: input.country, limit: input.limit }) }, costCents: 0 };
    }
    const parent = input.op === 'directParent' ? await getDirectParent(input.lei) : await getUltimateParent(input.lei);
    return { data: { parent }, costCents: 0 };
  },
};

export type TedSearchInput = { kind: 'award' | 'contract'; params: SearchAwardParams };
export interface TedSearchOutput {
  awards?: TedAwardNotice[];
  notices?: TedContractNotice[];
}

/** ted.search —— TED v3 官方 Search API（中标发现 + 招标 intent；CC BY 4.0 署名义务）。 */
export const tedSearchTool: Tool<TedSearchInput, TedSearchOutput> = {
  id: 'ted.search',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'public_intelligence',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 1, concurrency: 2 },
  // personalData:true —— notice 可含具名联系人（绿字段抽取已隔离，元数据仍如实标注，与 source_policy 行一致）。
  // 'intent'：招标 intent 投影（TENDER_PUBLISHED）以该用途经本工具（旧 §8.8 门显式列 intent）。
  compliance: { sourcePolicy: 'required', policyDomain: 'api.ted.europa.eu', respectsRobots: false, personalData: true, allowedPurpose: ['discovery', 'enrichment', 'intent'], reversible: true, authRequired: false, risk: 'low' },
  capabilities: { produces: ['company', 'trade_record'], accepts: ['keywords'] },
  idempotencyKey: (i) => `ted.search:${stableKey(i)}`,
  healthCheck: async () => ({ healthy: true, detail: 'ted' }),
  execute: async (input) => {
    if (input.kind === 'award') {
      return { data: { awards: await searchAwardNotices(input.params) }, costCents: 0 };
    }
    return { data: { notices: await searchContractNotices(input.params) }, costCents: 0 };
  },
};

export type OpenFdaSearchInput =
  | { kind: 'registration'; params: RegistrationSearchParams }
  | { kind: '510k'; params: Search510kParams };
export interface OpenFdaSearchOutput {
  establishments?: OpenFdaEstablishment[];
  clearances?: Fda510kClearance[];
}

/** openfda.search —— openFDA 官方 API（器械注册发现 + 510k intent；CC0，「注册≠核准」红线由调用方文案守）。 */
export const openFdaSearchTool: Tool<OpenFdaSearchInput, OpenFdaSearchOutput> = {
  id: 'openfda.search',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'public_intelligence',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 1, concurrency: 2 },
  // personalData:true —— registrationlisting 可含具名 us_agent/contact（不入绿库由 provider 抽取面守）。
  // 'intent'：510k 清关 intent 投影（FDA_CLEARANCE）以该用途经本工具。
  compliance: { sourcePolicy: 'required', policyDomain: 'api.fda.gov', respectsRobots: false, personalData: true, allowedPurpose: ['discovery', 'enrichment', 'intent'], reversible: true, authRequired: false, risk: 'low' },
  capabilities: { produces: ['company'], accepts: ['keywords'] },
  idempotencyKey: (i) => `openfda.search:${stableKey(i)}`,
  healthCheck: async () => ({ healthy: true, detail: 'openfda' }),
  execute: async (input) => {
    if (input.kind === 'registration') {
      return { data: { establishments: await searchRegistrations(input.params) }, costCents: 0 };
    }
    return { data: { clearances: await search510kClearances(input.params) }, costCents: 0 };
  },
};

export type CompaniesHouseInput =
  | { op: 'search'; query: string; limit?: number }
  | { op: 'officers'; companyNumber: string; limit?: number };
export interface CompaniesHouseOutput {
  companies?: ChCompanyHit[];
  officers?: ChOfficer[];
}

/**
 * companies_house.search —— UK Companies House 官方注册处 API（Basic auth；董事 = 具名经济买家）。
 * required 治理：董事 = 🔴 具名个人（GDPR）→ personalData=true → §8.8 用途门 fail-closed（未登记/
 * SUSPENDED/用途不符即拒）。authRequired=true（key 走 env，业务码不见）。数据最小化在 adapter 层。
 */
export const companiesHouseSearchTool: Tool<CompaniesHouseInput, CompaniesHouseOutput> = {
  id: 'companies_house.search',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'company_registry',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 2, concurrency: 2 },
  // personalData:true —— officers 是具名董事（GDPR）；数据最小化（无 DOB/国籍/住址）在 adapter 层强制。
  compliance: { sourcePolicy: 'required', policyDomain: 'api.company-information.service.gov.uk', respectsRobots: false, personalData: true, allowedPurpose: ['discovery', 'enrichment'], reversible: true, authRequired: true, risk: 'low' },
  capabilities: { produces: ['contact', 'company'], accepts: ['keywords'] },
  idempotencyKey: (i) => `companies_house.search:${stableKey(i)}`,
  healthCheck: async () => ({ healthy: true, detail: 'companies-house' }),
  execute: async (input) => {
    if (input.op === 'search') {
      return { data: { companies: await searchCompanies(input.query, input.limit) }, costCents: 0 };
    }
    return { data: { officers: await listOfficers(input.companyNumber, input.limit) }, costCents: 0 };
  },
};

export type InpiRneInput = { op: 'search'; query: string; limit?: number };
export interface InpiRneOutput {
  companies?: FrCompanyHit[];
}

/**
 * inpi_rne.search —— 法国 dirigeants（经开放政务网关 API Recherche d'entreprises，数据源 = INPI RNE + Sirene）。
 * required 治理：dirigeant = 🔴 具名个人（GDPR）→ personalData=true → §8.8 用途门 fail-closed（未登记/
 * SUSPENDED/用途不符即拒）。**开放 API 无鉴权**（authRequired=false）。数据最小化（无 DOB/国籍）在 adapter 层。
 */
export const inpiRneSearchTool: Tool<InpiRneInput, InpiRneOutput> = {
  id: 'inpi_rne.search',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'company_registry',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 2, concurrency: 2 },
  // personalData:true —— dirigeants 是具名负责人（GDPR）；数据最小化（无 DOB/国籍/住址）在 adapter 层强制。
  compliance: { sourcePolicy: 'required', policyDomain: 'recherche-entreprises.api.gouv.fr', respectsRobots: false, personalData: true, allowedPurpose: ['discovery', 'enrichment'], reversible: true, authRequired: false, risk: 'low' },
  capabilities: { produces: ['contact', 'company'], accepts: ['keywords'] },
  idempotencyKey: (i) => `inpi_rne.search:${stableKey(i)}`,
  healthCheck: async () => ({ healthy: true, detail: 'inpi-rne' }),
  execute: async (input) => ({
    data: { companies: await searchCompaniesWithDirigeants(input.query, input.limit) },
    costCents: 0,
  }),
};

export interface GooglePatentsInput {
  applicant: string;
  fromYear: number;
  toYear: number;
  maxRows?: number;
}
export interface GooglePatentsOutput {
  patents?: PatentRecord[];
}

/**
 * google_patents.search —— BigQuery Google Patents Public Data（服务账号鉴权；发明人 = 具名技术买家）。
 * 待办 3 · 替代被封 EPO OPS。required 治理：发明人 = 🔴 具名个人（GDPR）→ personalData=true → §8.8
 * 用途门 fail-closed（未登记/SUSPENDED/用途不符即拒）。authRequired=true（SA key 走 env，业务码不见）。
 * 数据最小化（只 name，无 residence/国籍）在 adapter 层强制；CC BY 4.0 署名义务由 provider 写 field_evidence.license。
 * 成本护栏：maximumBytesBilled 硬顶护 1TB/月免费额度（adapter 层）。
 */
export const googlePatentsSearchTool: Tool<GooglePatentsInput, GooglePatentsOutput> = {
  id: 'google_patents.search',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'public_intelligence',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 1, concurrency: 1 },
  // personalData:true —— inventors 是具名发明人（GDPR）；数据最小化（只 name）在 adapter 层强制。
  compliance: { sourcePolicy: 'required', policyDomain: 'bigquery.googleapis.com', respectsRobots: false, personalData: true, allowedPurpose: ['discovery', 'enrichment'], reversible: true, authRequired: true, risk: 'low' },
  capabilities: { produces: ['contact'], accepts: ['keywords'] },
  idempotencyKey: (i) => `google_patents.search:${stableKey(i)}`,
  healthCheck: async () => ({ healthy: true, detail: 'google-patents-bigquery' }),
  execute: async (input) => ({
    data: {
      patents: await bigqueryPatents.searchPatentsByAssignee(input.applicant, {
        fromYear: input.fromYear,
        toYear: input.toYear,
        maxRows: input.maxRows,
      }),
    },
    costCents: 0,
  }),
};

export interface TradeFairAlgoliaInput {
  cfg: AlgoliaFairConfig;
  limit?: number;
}

/** tradefair.algolia —— RX 展会参展商（Algolia 托管搜索）。⚠️ ToS 灰偏红源（trade-fair-intelligence.md §0）——
 *  required 治理：source_policy 行是显性风险登记点，SUSPENDED 即全链停抓。 */
export const tradeFairAlgoliaTool: Tool<TradeFairAlgoliaInput, { exhibitors: FairExhibitor[] }> = {
  id: 'tradefair.algolia',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'industry_data',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 1, concurrency: 2 },
  // personalData:true —— 参展商记录可内联联系人邮箱/电话。
  compliance: { sourcePolicy: 'required', policyDomain: 'algolia.net', respectsRobots: false, personalData: true, allowedPurpose: ['discovery'], reversible: true, authRequired: false, risk: 'medium' },
  capabilities: { produces: ['company', 'contact'], accepts: ['keywords'] },
  idempotencyKey: (i) => `tradefair.algolia:${stableKey({ appId: i.cfg.appId, index: i.cfg.indexName, edition: i.cfg.eventEditionId, limit: i.limit })}`,
  healthCheck: async () => ({ healthy: true, detail: 'algolia' }),
  execute: async (input) => ({
    data: { exhibitors: await queryAlgoliaExhibitors(input.cfg, input.limit) },
    costCents: 0,
  }),
};

export interface MapYourShowFetchInput {
  /** 形如 "<show>.mapyourshow.com"（调用方已校验）。 */
  host: string;
  limit?: number;
}
export interface MysRawHit {
  fields?: {
    exhid_l?: string;
    exhname_t?: string;
    exhdesc_t?: string;
    boothsdisplay_la?: string[];
    hallid_la?: string[];
  };
}

/** mapyourshow.fetch —— MYS 展会参展商 JSON（无鉴权 ColdFusion 后端；required 治理登记）。 */
export const mapYourShowFetchTool: Tool<MapYourShowFetchInput, { hits: MysRawHit[] }> = {
  id: 'mapyourshow.fetch',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'industry_data',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 1, concurrency: 2 },
  compliance: { sourcePolicy: 'required', policyDomain: 'mapyourshow.com', respectsRobots: false, personalData: false, allowedPurpose: ['discovery'], reversible: true, authRequired: false, risk: 'medium' },
  capabilities: { produces: ['company'], accepts: ['keywords'] },
  idempotencyKey: (i) => `mapyourshow.fetch:${stableKey(i)}`,
  healthCheck: async () => ({ healthy: true, detail: 'mapyourshow' }),
  execute: async (input) => {
    const base = `https://${input.host}/8_0`;
    const url = `${base}/ajax/remote-proxy.cfm?action=search&searchtype=exhibitor&searchterm=&pageID=1&perpage=${input.limit ?? 5000}`;
    // IIS 对裸请求 403：带浏览器 UA + XHR 头 + 同源 Referer（与站点前端一致的公开端点访问方式）。
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${base}/explore/exhibitor-gallery.cfm`,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`mapyourshow ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const json = (await res.json()) as { DATA?: { results?: { exhibitor?: { hit?: MysRawHit[] } } } };
    return { data: { hits: json?.DATA?.results?.exhibitor?.hit ?? [] }, costCents: 0 };
  },
};

export interface SamSearchInput {
  params: SamSearchParams;
}
export interface SamSearchOutput {
  notices?: SamSourcesSought[];
}

/**
 * samgov.search —— SAM.gov Sources Sought 公开数据抽取（keyless CSV `datagov` 分区）；招标前**联邦意图**（P4）。
 * required 治理：源含联系官具名字段（adapter 层已结构性剔除，不入绿库）→ personalData=true → §8.8 用途门 fail-closed
 * （未登记/SUSPENDED/用途不符即拒）。**keyless 无鉴权**（authRequired=false）。美国政府作品公共领域（署名非义务）。
 * 'intent'：Sources Sought intent 投影（US_FED_SOURCES_SOUGHT）以该用途经本工具。
 */
export const samgovSearchTool: Tool<SamSearchInput, SamSearchOutput> = {
  id: 'samgov.search',
  version: '1.0.0',
  category: 'structured_source',
  sourceClass: 'public_intelligence',
  cost: { unit: 'call', estimatedCents: 0, external: true },
  rateLimit: { rps: 1, concurrency: 1 },
  // personalData:true —— 上游 CSV 含联系官具名字段（adapter 层结构性剔除，绿库红线；元数据仍如实标注）。
  compliance: { sourcePolicy: 'required', policyDomain: 'sam.gov', respectsRobots: false, personalData: true, allowedPurpose: ['discovery', 'enrichment', 'intent'], reversible: true, authRequired: false, risk: 'low' },
  capabilities: { produces: ['company'], accepts: ['keywords'] },
  idempotencyKey: (i) => `samgov.search:${stableKey(i)}`,
  healthCheck: async () => ({ healthy: true, detail: 'samgov' }),
  execute: async (input) => ({ data: { notices: await fetchSourcesSought(input.params) }, costCents: 0 }),
};

/** 注册全部数据源工具（启动期，与 registerBuiltinTools 同点调用）。 */
export function registerSourceTools(registry: ToolRegistry): ToolRegistry {
  registry.register(crawl4aiRenderTool as Tool);
  registry.register(httpGetTool as Tool);
  registry.register(wikidataEntityTool as Tool);
  registry.register(gleifFetchTool as Tool);
  registry.register(tedSearchTool as Tool);
  registry.register(openFdaSearchTool as Tool);
  registry.register(tradeFairAlgoliaTool as Tool);
  registry.register(mapYourShowFetchTool as Tool);
  registry.register(companiesHouseSearchTool as Tool);
  registry.register(inpiRneSearchTool as Tool);
  registry.register(googlePatentsSearchTool as Tool);
  registry.register(samgovSearchTool as Tool);
  return registry;
}
