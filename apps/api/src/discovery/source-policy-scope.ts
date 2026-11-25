/**
 * Reserved `source_policy.domain` key of the generic policy for a company's own website.
 *
 * Only public_web uses it, and only in Raw ingestion: a public_web record whose source host is
 * the record's own domain falls back to this row when no per-domain policy covers that host.
 * `raw-source-ingestion.ts` and the database writer (`raw_source_policy_binding_v3`, migration
 * 20261009180000_public_web_company_site_source_policy) apply the same rule.
 *
 * ":" and "_" never occur in a host name, so no host equals this key or ends with it. The
 * per-domain lookups (ToolBroker, SUSPENDED block lists) therefore never select the row.
 */
export const PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN = "public_web:company_site";

/**
 * Reserved `source_policy.domain` key for public B2B trade-association / exhibitor directories.
 *
 * Only `directory` uses it as a Tier-3 fallback (explicit site policy > closed deny-list >
 * `directory:public_b2b_listing`). `raw-source-ingestion.ts`, `directory-source-policy.ts`,
 * and PostgreSQL `raw_source_policy_binding_v3` enforce the exact same rule and deny-list.
 */
export const DIRECTORY_PUBLIC_B2B_LISTING_POLICY_DOMAIN =
  "directory:public_b2b_listing";

/**
 * Closed deny-list of domains that must never fall back to `directory:public_b2b_listing`.
 * Must stay 1:1 with `raw_source_policy_binding_v3` in PostgreSQL.
 */
export const DIRECTORY_FALLBACK_BLOCKED_DOMAINS: readonly string[] = Object.freeze([
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "xing.com",
  "youtube.com",
  "tiktok.com",
  "reddit.com",
  "pinterest.com",
  "wikipedia.org",
  "zoominfo.com",
  "apollo.io",
  "lusha.com",
  "rocketreach.co",
  "hunter.io",
  "prospeo.io",
  "clearbit.com",
  "crunchbase.com",
  "dnb.com",
  "pitchbook.com",
  "bloomberg.com",
  "statista.com",
  "owler.com",
  "signalhire.com",
  "contactout.com",
  "kaspr.io",
  "cognism.com",
  "kompass.com",
  "europages.com",
  "europages.co.uk",
  "europages.de",
  "europages.fr",
  "europages.it",
  "europages.es",
  "yelp.com",
  "trustpilot.com",
  "glassdoor.com",
  "indeed.com",
  "yellowpages.com",
  "paginegialle.it",
  "gelbeseiten.de",
  "wlw.de",
  "wlw.com",
  "thomasnet.com",
  "dunsguide.com",
  "amazon.com",
  "amazon.it",
  "amazon.de",
  "ebay.com",
  "alibaba.com",
  "1688.com",
  "made-in-china.com",
  "globalsources.com",
  "indiamart.com",
  "google.com",
  "bing.com",
  "duckduckgo.com",
]);

export function isReservedSourcePolicyDomain(domain: string): boolean {
  return (
    domain === PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN ||
    domain === DIRECTORY_PUBLIC_B2B_LISTING_POLICY_DOMAIN
  );
}

export function isDirectoryFallbackBlockedHost(host: string): boolean {
  const normalized = host
    .replace(/[A-Z]+/gu, (letters) => letters.toLowerCase())
    .replace(/^www\./u, "");
  return DIRECTORY_FALLBACK_BLOCKED_DOMAINS.some(
    (blocked) => normalized === blocked || normalized.endsWith(`.${blocked}`),
  );
}

/** Reserved fallback domain eligible when no site-specific policy covers the host. */
export function fallbackSourcePolicyDomain(
  providerKey: string,
  host: string | null,
  hostname: string,
  recordDomain: unknown,
): string | null {
  const ownDomain = typeof recordDomain === "string" ? recordDomain : null;
  if (
    (providerKey === "public_web" || providerKey === "model_web_search") &&
    host !== null &&
    ownDomain !== null &&
    (host === ownDomain || host.endsWith(`.${ownDomain}`))
  ) {
    return PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN;
  }
  if (providerKey === "directory" && !isDirectoryFallbackBlockedHost(hostname)) {
    return DIRECTORY_PUBLIC_B2B_LISTING_POLICY_DOMAIN;
  }
  return null;
}

/** Raw admission and directory preflight share the same closed discovery-purpose predicate. */
export function sourcePolicyAllowsDiscovery(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 &&
    value.every((purpose) => typeof purpose === 'string') && value.includes('discovery');
}
