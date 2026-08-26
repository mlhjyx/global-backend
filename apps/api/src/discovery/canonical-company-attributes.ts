import {
  isContactFreeText,
  isControlledBusinessTerm,
  isSecretFreeText,
} from "./raw-source-provider-normalizer";

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
      /^[A-Z0-9]{2,10}$/u.test(value) &&
      isContactFreeText(value))
  );
}

function sanitizeValue(
  key: string,
  value: unknown,
  state: SanitizeState,
  depth: number,
): unknown {
  state.remaining -= 1;
  if (
    state.remaining < 0 ||
    depth > 6 ||
    CONTACT_ATTRIBUTE_KEYS.has(normalizedKey(key))
  ) {
    return undefined;
  }
  if (key === "products" || key === "keywords") {
    if (!Array.isArray(value)) return undefined;
    const predicate =
      key === "products" ? safeProduct : isControlledBusinessTerm;
    const terms = value.filter(predicate);
    return terms.length ? [...new Set(terms)] : undefined;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const safeString = SEMANTIC_IDENTIFIER_KEYS.has(key)
      ? isSecretFreeText(value)
      : isContactFreeText(value);
    return value.normalize("NFKC") === value &&
      Buffer.byteLength(value, "utf8") <= 1_024 &&
      safeString
      ? value
      : undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) return undefined;
    return value
      .map((item) => sanitizeValue(key, item, state, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (value === null || typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) return undefined;
  return Object.fromEntries(
    entries.flatMap(([nestedKey, item]) => {
      const sanitized = sanitizeValue(nestedKey, item, state, depth + 1);
      return sanitized === undefined ? [] : [[nestedKey, sanitized]];
    }),
  );
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
      const sanitized = sanitizeValue(key, item, state, 0);
      return sanitized === undefined ? [] : [[key, sanitized]];
    }),
  );
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
