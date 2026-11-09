/**
 * Product execution-shape ceilings. These are platform safety contracts used
 * by providers, workflows and technical quotes; they are not customer usage
 * limits, balances, prices or commercial entitlements.
 */
// 8→9（WEB-1 model_web_search 注册面，2026-11-10）：报价上界的适配器因子随之 +1。
export const MAX_COMPANY_DISCOVERY_ADAPTERS = 9 as const;
/** `discovery.query_plan` output schema bound. */
export const MAX_QUERY_PLANNER_QUERIES = 64 as const;
/** Deterministic cold-path queries added after planning: TED and openFDA, at most one each. */
export const MAX_INJECTED_PLAN_QUERIES = 2 as const;
export const MAX_DISCOVERY_PLAN_QUERIES =
  MAX_QUERY_PLANNER_QUERIES + MAX_INJECTED_PLAN_QUERIES;
export const MAX_DISCOVERY_PROVIDER_RECORDS = 25 as const;
export const MAX_DISCOVERY_FIT_COMPANIES =
  MAX_DISCOVERY_PLAN_QUERIES *
  MAX_COMPANY_DISCOVERY_ADAPTERS *
  MAX_DISCOVERY_PROVIDER_RECORDS;

// Per plan query, before the provider fan-out: taxonomy terms sent to the
// `taxonomy.normalize` cold path (one model call per unresolved term).
export const MAX_QUERY_TAXONOMY_INDUSTRY_TERMS = 4 as const;
export const MAX_QUERY_TAXONOMY_COUNTRY_TERMS = 2 as const;

// Per plan query, per company discovery adapter.
export const MAX_PUBLIC_WEB_SEARCHES_PER_QUERY = 3 as const;
export const MAX_PUBLIC_WEB_DOMAINS_PER_QUERY = 14 as const;
export const MAX_DIRECTORY_SEARCHES_PER_QUERY = 4 as const;
export const MAX_DIRECTORY_LISTING_PAGES = 8 as const;
export const MAX_DIRECTORY_PAGINATION = 3 as const;
/** wikidata, osm, ted and openfda issue one search wire per query. */
export const MAX_SINGLE_SEARCH_WIRES_PER_QUERY = 1 as const;

// Post-discovery stages of one run, and their per-company wires.
/** Website profile (G3 5.4b): before fit, homepage + Impressum per company, at most one model call. */
export const MAX_DISCOVERY_PROFILE_COMPANIES = 50 as const;
export const MAX_WEBSITE_PROFILE_FETCHES_PER_COMPANY = 2 as const;
/** BI-14 contact paths (switch company_contact): the linked contact page, rendered to look for a form. */
export const MAX_WEBSITE_PROFILE_RENDERS_PER_COMPANY = 1 as const;
export const MAX_DISCOVERY_ENRICH_COMPANIES = 50 as const;
/** GLEIF: country search, name-only retry, direct and ultimate parent. */
export const MAX_GLEIF_FETCHES_PER_COMPANY = 4 as const;
/** Wikidata: entity search, candidate claims, referenced labels. */
export const MAX_WIKIDATA_ENTITY_READS_PER_COMPANY = 3 as const;
export const MAX_DISCOVERY_SIGNAL_COMPANIES = 12 as const;
export const MAX_DISCOVERY_WATCH_COMPANIES = 12 as const;

// Contact stage: `discoverRunContacts` runs inside the 30-minute start-to-close
// activity window (discovery.workflow.ts signalActs). Two companies are in
// flight at a time and the soft deadline stops claiming new ones so the pair
// in flight can finish inside the window; the hard count is only a safety
// bound because the D7 sub-budget usually truncates earlier.
export const CONTACT_DISCOVERY_COMPANY_CONCURRENCY = 2 as const;
export const MAX_CONTACT_DISCOVERY_COMPANIES = 25 as const;
/**
 * 18 minutes: the two companies still in flight at the deadline finish inside the
 * 30-minute window even at the 10-minute worst-case unit (18 + 10 < 30).
 */
export const CONTACT_DISCOVERY_SOFT_DEADLINE_MS = 1_080_000 as const;
export const MAX_SITEMAP_ROOTS = 4 as const;
export const MAX_CHILD_SITEMAPS = 3 as const;
/** robots.txt, then the sitemap roots and index children. */
export const MAX_SITEMAP_HTTP_GETS = 1 + MAX_SITEMAP_ROOTS + MAX_CHILD_SITEMAPS;
export const CAREERS_PROBE_PATHS = Object.freeze([
  '/careers', '/en/careers', '/career', '/jobs', '/karriere', '/company/careers',
] as const);
/** Sitemap reads, careers HEAD probes, and one ATS board read. */
export const MAX_STRUCTURED_HARVEST_HTTP_GETS =
  MAX_SITEMAP_HTTP_GETS + CAREERS_PROBE_PATHS.length + 1;
export const MAX_STRUCTURED_HARVEST_RENDERS = 1 as const;
export const MAX_DIGITAL_FOOTPRINT_RENDERS = 1 as const;

// Seller understanding (POST /companies): homepage plus selected subpages.
export const MAX_UNDERSTANDING_SUBPAGES = 6 as const;

export const MAX_CONTACT_DISCOVERY_ADAPTERS = 6 as const;
export const MAX_CONTACTS_PER_DISCOVERY_ADAPTER = 25 as const;
export const MAX_DECISION_MAKER_PAGES = 4 as const;
/** public_web 联系人路径：首页之外最多再抓的 contact/impressum/about 页数。 */
export const MAX_PUBLIC_WEB_CONTACT_LINKED_PAGES = 4 as const; // A1：法律页固定路径变体需要多个槽位（/impressum, /kontakt, /impressum/, …）
/** social_presence 索引层：每家最多发出的社媒 dork 数（buildSocialDorks 上限）。 */
export const MAX_SOCIAL_DORKS = 4 as const;
/** social_presence 档案/直抓层：每个候选页最多 3 次抓取（Wayback availability + 档案副本 + 直抓）。 */
export const MAX_SOCIAL_FETCHES_PER_CANDIDATE = 3 as const;
/** companies_house 联系人发现：公司搜索 + officers 两次调用。 */
export const MAX_COMPANIES_HOUSE_CONTACT_CALLS = 2 as const;
/** social_presence 档案/直抓层：每家最多补抓的候选个人页数（D5 每家页数上限的社媒部分）。 */
export const MAX_SOCIAL_PROFILE_FETCHES = 4 as const;
export const MAX_EMAIL_GUESS_CONTACTS = 25 as const;
export const MAX_EMAIL_PROBE_CANDIDATES = 8 as const;
/** 发现 run 的邮箱补全：每公司 ≤6 次 SMTP 探测（D5 §六），跨该公司全部联系人共享。 */
export const MAX_RUN_EMAIL_PROBES_PER_COMPANY = 6 as const;
export const MAX_EMAIL_VERIFY_PHYSICAL_CALLS_PER_TARGET = 1 as const;

// P1-10 联系人富集（付费 finder / 验证 API）的执行形状上限——不是客户配额。
/** 每公司每轮富集最多 finder 调用（计划 §2.3.4.7；跨该公司的全部联系人共享）。 */
export const MAX_ENRICH_FINDER_CALLS_PER_COMPANY = 10 as const;
/** 单个地址的验证瀑布调用上限（计划 §2.3.5.3：≤6，含解析与仲裁）。 */
export const MAX_ENRICH_VERIFICATION_CALLS_PER_ADDRESS = 6 as const;
/** HTTP 端点单次请求最多处理的联系人（与 guess-emails 的 25 同量级、更保守）。 */
export const MAX_ENRICH_CONTACTS_PER_REQUEST = 10 as const;
/** 富集批内并发公司数（与联系人发现阶段一致：2）。 */
export const ENRICH_COMPANY_CONCURRENCY = 2 as const;
/** 每公司软截止 10 分钟（计划 §2.3.4.7）：到期不再开新联系人，在飞的可收尾。 */
export const ENRICH_SOFT_DEADLINE_MS = 600_000 as const;
/** run 内最多对 25 家公司触发富集（计划 §2.3.4.7）。 */
export const MAX_RUN_ENRICH_COMPANIES = 25 as const;
/** run 内单公司富集的预算上限（$0.50）：调用计数上限之外的第二道钱闸。 */
export const ENRICH_COMPANY_BUDGET_CAP_MICROUSD = 500_000 as const;
