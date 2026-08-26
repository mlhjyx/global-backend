/**
 * Product execution-shape ceilings. These are platform safety contracts used
 * by providers, workflows and technical quotes; they are not customer usage
 * limits, balances, prices or commercial entitlements.
 */
export const MAX_COMPANY_DISCOVERY_ADAPTERS = 7 as const;
export const MAX_DISCOVERY_PLAN_QUERIES = 64 as const;
export const MAX_DISCOVERY_PROVIDER_RECORDS = 25 as const;
export const MAX_DISCOVERY_FIT_COMPANIES =
  MAX_DISCOVERY_PLAN_QUERIES *
  MAX_COMPANY_DISCOVERY_ADAPTERS *
  MAX_DISCOVERY_PROVIDER_RECORDS;

export const MAX_CONTACT_DISCOVERY_ADAPTERS = 5 as const;
export const MAX_CONTACTS_PER_DISCOVERY_ADAPTER = 25 as const;
export const MAX_DECISION_MAKER_PAGES = 4 as const;
export const MAX_EMAIL_GUESS_CONTACTS = 25 as const;
export const MAX_EMAIL_PROBE_CANDIDATES = 8 as const;
export const MAX_EMAIL_VERIFY_PHYSICAL_CALLS_PER_TARGET = 1 as const;
