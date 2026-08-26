import { isDeepStrictEqual } from "node:util";
import {
  isContactFreeText,
  isControlledBusinessTerm,
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
  ["intent.events.evidence.notice", { validate: safeCode }],
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
