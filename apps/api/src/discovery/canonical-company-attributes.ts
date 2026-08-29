import { isDeepStrictEqual } from "node:util";
import {
  isContactFreeText,
  isControlledBusinessTerm,
  isProviderCompanyName,
  isSecretFreeText,
} from "./raw-source-provider-normalizer";
import { sanitizeStructuredHarvestSiteSections } from "./structured-harvest-site-sections";

const RETAINED_TOP_LEVEL_KEYS = new Set([
  "digital_footprint",
  "employee_band",
  "employees",
  "extraction_confidence",
  "extraction_evidence_digest",
  "fda",
  "fda_applicant",
  "gleif",
  "government_buyer",
  "hall",
  "hiring_signal",
  "intent",
  "keywords",
  "latitude",
  "longitude",
  "osm_id",
  "products",
  "sam_disclaimer",
  "sam_market_signal",
  "source_class",
  "source_fair",
  "source_kind",
  "stand",
  "structured_harvest",
  "ted",
  "ted_buyer",
  "wikidata",
  "wikidata_qid",
]);

const CONTACT_ATTRIBUTE_KEYS = new Set([
  "address",
  "contact",
  "contactemail",
  "contactname",
  "contactpoint",
  "email",
  "firstname",
  "fullname",
  "lastname",
  "mobile",
  "ownername",
  "person",
  "persons",
  "phone",
  "publicemail",
  "publicphone",
  "recipientname",
  "telephone",
  "usagent",
]);

const SEMANTIC_IDENTIFIER_KEYS = new Set([
  "cpv",
  "fei_number",
  "isin",
  "k_number",
  "lei",
  "legal_form_code",
  "naics",
  "notice",
  "osm_id",
  "owner_operator_numbers",
  "parent_lei",
  "parent_qid",
  "product_code",
  "publication_number",
  "qid",
  "registration_number",
  "source",
  "ultimate_parent_lei",
  "wikidata_qid",
  "winner_identifier",
]);

type SemanticIdentifierContract = Readonly<{
  allowArray?: boolean;
  validate: (value: string) => boolean;
}>;

function safeCode(value: string, maximumBytes = 128): boolean {
  return (
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u.test(value) &&
    isContactFreeText(value)
  );
}

function safeNotice(value: string): boolean {
  return (
    (/^\d{1,9}-(?:19|20)\d{2}$/u.test(value) && isSecretFreeText(value)) ||
    safeCode(value)
  );
}

function safeProviderIdentifier(value: string): boolean {
  return (
    Buffer.byteLength(value, "utf8") <= 80 &&
    /^[\p{L}\p{N}][\p{L}\p{N} ._:/-]{0,79}$/u.test(value) &&
    isContactFreeText(value)
  );
}

function safeHttpsSource(value: string): boolean {
  if (!isContactFreeText(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

const semanticIdentifierContracts = new Map<
  string,
  SemanticIdentifierContract
>([
  ["wikidata_qid", { validate: (value) => /^Q[1-9]\d{0,15}$/u.test(value) }],
  [
    "osm_id",
    { validate: (value) => /^(?:node|way|relation)\/\d{1,20}$/u.test(value) },
  ],
  [
    "ted.publication_number",
    { validate: (value) => /^\d{1,9}(?:-\d{4})?$/u.test(value) },
  ],
  [
    "ted.cpv",
    { allowArray: true, validate: (value) => /^\d{8}$/u.test(value) },
  ],
  ["ted.winner_identifier", { validate: safeProviderIdentifier }],
  [
    "fda.registration_number",
    { validate: (value) => /^\d{1,32}$/u.test(value) },
  ],
  ["fda.fei_number", { validate: (value) => /^\d{1,32}$/u.test(value) }],
  [
    "fda.owner_operator_numbers",
    { allowArray: true, validate: (value) => /^\d{1,32}$/u.test(value) },
  ],
  ["gleif.lei", { validate: (value) => /^[A-Z0-9]{20}$/u.test(value) }],
  [
    "gleif.parent_lei",
    { validate: (value) => /^[A-Z0-9]{20}$/u.test(value) },
  ],
  [
    "gleif.ultimate_parent_lei",
    { validate: (value) => /^[A-Z0-9]{20}$/u.test(value) },
  ],
  ["gleif.legal_form_code", { validate: safeCode }],
  ["wikidata.qid", { validate: (value) => /^Q[1-9]\d{0,15}$/u.test(value) }],
  [
    "wikidata.parent_qid",
    { validate: (value) => /^Q[1-9]\d{0,15}$/u.test(value) },
  ],
  ["wikidata.lei", { validate: (value) => /^[A-Z0-9]{20}$/u.test(value) }],
  [
    "wikidata.isin",
    { validate: (value) => /^[A-Z]{2}[A-Z0-9]{9}\d$/u.test(value) },
  ],
  [
    "structured_harvest.hiring_signal.source",
    {
      validate: (value) =>
        ["sitemap", "ats:greenhouse", "ats:lever", "ats:ashby"].includes(
          value,
        ) || safeHttpsSource(value),
    },
  ],
  [
    "intent.events.evidence.source",
    { validate: (value) => ["ted", "samgov", "openfda"].includes(value) },
  ],
  ["intent.events.evidence.notice", { validate: safeNotice }],
  [
    "intent.events.evidence.cpv",
    { allowArray: true, validate: (value) => /^\d{8}$/u.test(value) },
  ],
  [
    "intent.events.evidence.naics",
    { allowArray: true, validate: (value) => /^\d{2,6}$/u.test(value) },
  ],
  [
    "intent.events.evidence.product_code",
    { validate: (value) => /^[A-Z]{3}$/u.test(value) },
  ],
  ["intent.events.evidence.k_number", { validate: safeCode }],
]);

const storedCompanyFieldAttributePaths = new Map<
  string,
  readonly string[]
>([
  ["digital_footprint.ad_pixels", ["digital_footprint", "ad_pixels"]],
  ["digital_footprint.email_provider", ["digital_footprint", "email_provider"]],
  ["digital_footprint.hiring_signal", ["digital_footprint", "hiring_signal"]],
  ["digital_footprint.is_advertiser", ["digital_footprint", "is_advertiser"]],
  ["digital_footprint.served_langs", ["digital_footprint", "served_langs"]],
  ["digital_footprint.served_markets", ["digital_footprint", "served_markets"]],
  ["digital_footprint.structured_org", ["digital_footprint", "structured_org"]],
  ["digital_footprint.structured_products", ["digital_footprint", "structured_products"]],
  ["digital_footprint.tech_platform", ["digital_footprint", "tech_platform"]],
  ["gleif.entity_status", ["gleif", "entity_status"]],
  ["gleif.is_subsidiary", ["gleif", "is_subsidiary"]],
  ["gleif.legal_form", ["gleif", "legal_form"]],
  ["gleif.legal_form_code", ["gleif", "legal_form_code"]],
  ["gleif.legal_name", ["gleif", "legal_name"]],
  ["gleif.lei", ["gleif", "lei"]],
  ["gleif.match_confidence", ["gleif", "match_confidence"]],
  ["gleif.parent_lei", ["gleif", "parent_lei"]],
  ["gleif.parent_name", ["gleif", "parent_name"]],
  ["gleif.registered_city", ["gleif", "registered_city"]],
  ["gleif.registered_country", ["gleif", "registered_country"]],
  ["gleif.registration_status", ["gleif", "registration_status"]],
  ["gleif.ultimate_parent_lei", ["gleif", "ultimate_parent_lei"]],
  ["gleif.ultimate_parent_name", ["gleif", "ultimate_parent_name"]],
  ["structured_harvest.careers_url", ["structured_harvest", "careers_url"]],
  ["structured_harvest.hiring_signal", ["structured_harvest", "hiring_signal"]],
  ["structured_harvest.site_sections", ["structured_harvest", "site_sections"]],
  ["structured_harvest.sitemap_url_count", ["structured_harvest", "sitemap_url_count"]],
  ["wikidata.country", ["wikidata", "country"]],
  ["wikidata.employees", ["wikidata", "employees"]],
  ["wikidata.headquarters", ["wikidata", "headquarters"]],
  ["wikidata.inception_year", ["wikidata", "inception_year"]],
  ["wikidata.industries", ["wikidata", "industries"]],
  ["wikidata.isin", ["wikidata", "isin"]],
  ["wikidata.label", ["wikidata", "label"]],
  ["wikidata.lei", ["wikidata", "lei"]],
  ["wikidata.match_confidence", ["wikidata", "match_confidence"]],
  ["wikidata.parent_name", ["wikidata", "parent_name"]],
  ["wikidata.parent_qid", ["wikidata", "parent_qid"]],
  ["wikidata.products", ["wikidata", "products"]],
  ["wikidata.qid", ["wikidata", "qid"]],
  ["wikidata.stock_exchange", ["wikidata", "stock_exchange"]],
  ["wikidata.subsidiary_count", ["wikidata", "subsidiary_count"]],
  ["wikidata.website", ["wikidata", "website"]],
]);

export const STORED_COMPANY_FIELD_EVIDENCE_FIELDS = Object.freeze([
  "attributes",
  "country",
  "digital_footprint.ad_pixels",
  "digital_footprint.email_provider",
  "digital_footprint.hiring_signal",
  "digital_footprint.is_advertiser",
  "digital_footprint.served_langs",
  "digital_footprint.served_markets",
  "digital_footprint.structured_org",
  "digital_footprint.structured_products",
  "digital_footprint.tech_platform",
  "domain",
  "employee_count",
  "gleif.entity_status",
  "gleif.is_subsidiary",
  "gleif.legal_form",
  "gleif.legal_form_code",
  "gleif.legal_name",
  "gleif.lei",
  "gleif.match_confidence",
  "gleif.parent_lei",
  "gleif.parent_name",
  "gleif.registered_city",
  "gleif.registered_country",
  "gleif.registration_status",
  "gleif.ultimate_parent_lei",
  "gleif.ultimate_parent_name",
  "identity",
  "industry",
  "intent.clearance",
  "intent.sources_sought",
  "intent.tender",
  "intent.website_change",
  "name",
  "region",
  "revenue_usd",
  "structured_harvest.careers_url",
  "structured_harvest.hiring_signal",
  "structured_harvest.site_sections",
  "structured_harvest.sitemap_url_count",
  "wikidata.country",
  "wikidata.employees",
  "wikidata.headquarters",
  "wikidata.inception_year",
  "wikidata.industries",
  "wikidata.isin",
  "wikidata.label",
  "wikidata.lei",
  "wikidata.match_confidence",
  "wikidata.parent_name",
  "wikidata.parent_qid",
  "wikidata.products",
  "wikidata.qid",
  "wikidata.stock_exchange",
  "wikidata.subsidiary_count",
  "wikidata.website",
] as const);

interface SanitizeState {
  remaining: number;
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function safeProduct(value: unknown): value is string {
  return (
    isControlledBusinessTerm(value) ||
    (typeof value === "string" &&
      /^[A-Z]{3}$/u.test(value) &&
      isContactFreeText(value))
  );
}

function sanitizeValue(
  key: string,
  value: unknown,
  state: SanitizeState,
  depth: number,
  path: readonly string[],
): unknown {
  state.remaining -= 1;
  if (
    state.remaining < 0 ||
    depth > 6 ||
    CONTACT_ATTRIBUTE_KEYS.has(normalizedKey(key))
  ) {
    return undefined;
  }
  if (
    path.length === 2 &&
    path[0] === "structured_harvest" &&
    path[1] === "site_sections"
  ) {
    const sections = sanitizeStructuredHarvestSiteSections(value);
    state.remaining -= sections ? Object.keys(sections).length : 0;
    return state.remaining < 0 ? undefined : sections;
  }
  if (key === "products" || key === "keywords") {
    if (!Array.isArray(value)) return undefined;
    const predicate =
      key === "products" ? safeProduct : isControlledBusinessTerm;
    const terms = value.filter(predicate);
    return terms.length ? [...new Set(terms)] : undefined;
  }
  const semanticContract = SEMANTIC_IDENTIFIER_KEYS.has(key)
    ? semanticIdentifierContracts.get(path.join("."))
    : undefined;
  if (SEMANTIC_IDENTIFIER_KEYS.has(key) && !semanticContract) {
    return undefined;
  }
  if (value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const safeString = semanticContract
      ? semanticContract.validate(value)
      : isContactFreeText(value);
    return value.normalize("NFKC") === value &&
      Buffer.byteLength(value, "utf8") <= 1_024 &&
      safeString
      ? value
      : undefined;
  }
  if (Array.isArray(value)) {
    if (semanticContract && semanticContract.allowArray !== true) {
      return undefined;
    }
    if (value.length > 50) return undefined;
    const items = value
      .map((item) => sanitizeValue(key, item, state, depth + 1, path))
      .filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) return undefined;
  const sanitized = Object.fromEntries(
    entries.flatMap(([nestedKey, item]) => {
      const sanitized = sanitizeValue(
        nestedKey,
        item,
        state,
        depth + 1,
        [...path, nestedKey],
      );
      return sanitized === undefined ? [] : [[nestedKey, sanitized]];
    }),
  );
  return Object.keys(sanitized).length ? sanitized : undefined;
}

/**
 * Canonical attributes are a derived product read model, not an evidence dump.
 * Unknown historical namespaces are withheld by default; retained namespaces
 * are recursively bounded and stripped of contact/credential-shaped values.
 */
export function sanitizeCanonicalCompanyAttributes(
  value: unknown,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const state: SanitizeState = { remaining: 512 };
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      if (!RETAINED_TOP_LEVEL_KEYS.has(key)) return [];
      const sanitized = sanitizeValue(key, item, state, 0, [key]);
      return sanitized === undefined ? [] : [[key, sanitized]];
    }),
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function wrapStoredAttributePath(
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  return path.reduceRight<Record<string, unknown>>(
    (wrapped, part, index) => ({
      [part]: index === path.length - 1 ? value : wrapped,
    }),
    {},
  );
}

function readStoredAttributePath(
  value: unknown,
  path: readonly string[],
): unknown {
  let current = value;
  for (const part of path) {
    const object = record(current);
    if (!object || !Object.prototype.hasOwnProperty.call(object, part)) {
      return undefined;
    }
    current = object[part];
  }
  return current;
}

function sanitizeStoredAttributePath(
  path: readonly string[],
  value: unknown,
): unknown {
  return readStoredAttributePath(
    sanitizeCanonicalCompanyAttributes(wrapStoredAttributePath(path, value)),
    path,
  );
}

function safeStoredText(value: unknown, maximumBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.normalize("NFKC") === value &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    isContactFreeText(value)
  );
}

function safeStoredDomain(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.normalize("NFKC") === value &&
    value === value.toLowerCase() &&
    Buffer.byteLength(value, "utf8") <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value) &&
    isContactFreeText(value)
  );
}

function sanitizeStoredIdentity(value: unknown): Record<string, unknown> | undefined {
  const input = record(value);
  if (!input) return undefined;
  const output: Record<string, unknown> = {};
  if (
    typeof input.name === "string" &&
    input.name.normalize("NFKC") === input.name &&
    Buffer.byteLength(input.name, "utf8") <= 160 &&
    isProviderCompanyName(input.name)
  ) output.name = input.name;
  if (safeStoredText(input.country, 80)) output.country = input.country;
  if (
    typeof input.source === "string" &&
    ["openfda", "samgov", "ted"].includes(input.source)
  ) output.source = input.source;
  if (typeof input.notice === "string" && safeNotice(input.notice)) {
    output.notice = input.notice;
  }
  if (typeof input.k_number === "string" && safeCode(input.k_number)) {
    output.k_number = input.k_number;
  }
  if (safeStoredText(input.attribution, 1_024)) output.attribution = input.attribution;
  if (safeStoredText(input.disclaimer, 1_024)) output.disclaimer = input.disclaimer;
  return Object.keys(output).length ? output : undefined;
}

/** FieldEvidence.field is a closed storage contract, not a JSON path. */
export function sanitizeStoredCompanyFieldEvidence(
  field: string,
  value: unknown,
): unknown {
  if (field === "attributes") {
    const attributes = sanitizeCanonicalCompanyAttributes(value);
    return Object.keys(attributes).length ? attributes : undefined;
  }
  if (field === "name") {
    return typeof value === "string" &&
      value.normalize("NFKC") === value &&
      Buffer.byteLength(value, "utf8") <= 160 &&
      isProviderCompanyName(value)
      ? value
      : undefined;
  }
  if (field === "domain") return safeStoredDomain(value) ? value : undefined;
  if (["country", "industry", "region"].includes(field)) {
    return safeStoredText(value, 160) ? value : undefined;
  }
  if (field === "employee_count") {
    return Number.isSafeInteger(value) && Number(value) >= 0 ? value : undefined;
  }
  if (field === "revenue_usd") {
    return typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1_000_000_000_000_000
      ? value
      : undefined;
  }
  if (field === "identity") return sanitizeStoredIdentity(value);
  if (field === "structured_harvest.site_sections") {
    return sanitizeStructuredHarvestSiteSections(value);
  }
  if (
    field === "intent.tender" ||
    field === "intent.sources_sought" ||
    field === "intent.website_change"
  ) return sanitizeStoredAttributePath(["intent"], value);
  if (field === "intent.clearance") {
    const intent = sanitizeStoredAttributePath(["intent"], { events: [value] });
    const events = record(intent)?.events;
    return Array.isArray(events) ? events[0] : undefined;
  }
  const path = storedCompanyFieldAttributePaths.get(field);
  return path ? sanitizeStoredAttributePath(path, value) : undefined;
}

export function mergeCanonicalCompanyAttributes(
  prior: unknown,
  next: unknown,
): Record<string, unknown> {
  const safePrior = sanitizeCanonicalCompanyAttributes(prior);
  const safeNext = sanitizeCanonicalCompanyAttributes(next);
  const products = [
    ...(Array.isArray(safePrior.products) ? safePrior.products : []),
    ...(Array.isArray(safeNext.products) ? safeNext.products : []),
  ].filter(safeProduct);
  return {
    ...safePrior,
    ...safeNext,
    ...(products.length ? { products: [...new Set(products)] } : {}),
  };
}

export function canonicalCompanyAttributesEqual(
  left: unknown,
  right: unknown,
): boolean {
  return isDeepStrictEqual(left, right);
}
