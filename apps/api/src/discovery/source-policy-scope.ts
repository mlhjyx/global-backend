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
