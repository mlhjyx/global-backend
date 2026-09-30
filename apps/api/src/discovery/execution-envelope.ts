/**
 * Product execution-shape ceilings. These are platform safety contracts used
 * by providers, workflows and technical quotes; they are not customer usage
 * limits, balances, prices or commercial entitlements.
 */
export const MAX_COMPANY_DISCOVERY_ADAPTERS = 7 as const;
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
export const MAX_DISCOVERY_ENRICH_COMPANIES = 50 as const;
/** GLEIF: country search, name-only retry, direct and ultimate parent. */
export const MAX_GLEIF_FETCHES_PER_COMPANY = 4 as const;
/** Wikidata: entity search, candidate claims, referenced labels. */
export const MAX_WIKIDATA_ENTITY_READS_PER_COMPANY = 3 as const;
export const MAX_DISCOVERY_SIGNAL_COMPANIES = 12 as const;
export const MAX_DISCOVERY_WATCH_COMPANIES = 12 as const;
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

export const MAX_CONTACT_DISCOVERY_ADAPTERS = 5 as const;
export const MAX_CONTACTS_PER_DISCOVERY_ADAPTER = 25 as const;
export const MAX_DECISION_MAKER_PAGES = 4 as const;
export const MAX_EMAIL_GUESS_CONTACTS = 25 as const;
export const MAX_EMAIL_PROBE_CANDIDATES = 8 as const;
export const MAX_EMAIL_VERIFY_PHYSICAL_CALLS_PER_TARGET = 1 as const;
