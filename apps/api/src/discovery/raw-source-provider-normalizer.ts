import { createHash } from "node:crypto";

export type RawJsonRecord = Record<string, unknown>;

const PROVIDER_KEYS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    registry: [
      "attributes",
      "country",
      "domain",
      "employeeCount",
      "externalId",
      "identifier",
      "license",
      "name",
      "provenance",
      "revenueUsd",
    ],
    directory: [
      "attributes",
      "country",
      "domain",
      "externalId",
      "name",
      "provenance",
    ],
    wikidata: [
      "attributes",
      "country",
      "domain",
      "employeeCount",
      "externalId",
      "license",
      "name",
      "provenance",
    ],
    openstreetmap: [
      "attributes",
      "country",
      "domain",
      "externalId",
      "license",
      "name",
      "provenance",
    ],
    trade_fair: [
      "attributes",
      "country",
      "domain",
      "externalId",
      "license",
      "monitoredSource",
      "name",
      "provenance",
    ],
    ted: [
      "attributes",
      "country",
      "domain",
      "externalId",
      "identifier",
      "license",
      "name",
      "provenance",
    ],
    openfda: [
      "attributes",
      "country",
      "domain",
      "externalId",
      "identifier",
      "industry",
      "license",
      "name",
      "provenance",
    ],
    public_web: [
      "attributes",
      "country",
      "domain",
      "employeeCount",
      "externalId",
      "industry",
      "license",
      "name",
      "provenance",
    ],
  });
const SHA256 = /^[0-9a-f]{64}$/u;
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;
const CODE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PII_OR_SECRET =
  /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:bearer|basic auth|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|passwd|private[_ -]?key|first[_ -]?name|last[_ -]?name|full[_ -]?name|contact[_ -]?name|personal data|jane doe|john doe|john smith)\b|\bsk-[a-z0-9_-]{6,})/iu;
const CONTACT_LIKE_PHONE =
  /(?:^|[^\p{L}\d])(?:\+?\d[\s().-]*){7,}(?:$|[^\p{L}\d])/u;
const CONTROLLED_BUSINESS_TOKENS = new Set([
  "aerospace",
  "automation",
  "brake",
  "centrifugal",
  "compressor",
  "defense",
  "device",
  "devices",
  "electric",
  "electronics",
  "energy",
  "engineering",
  "equipment",
  "fabrication",
  "hydraulic",
  "imaging",
  "industrial",
  "machine",
  "machinery",
  "manufacturing",
  "medical",
  "metal",
  "motor",
  "motors",
  "press",
  "pump",
  "pumps",
  "radiological",
  "service",
  "services",
  "software",
  "system",
  "systems",
  "technology",
  "valve",
  "valves",
]);

function record(value: unknown): RawJsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RawJsonRecord)
    : null;
}
function keysWithin(value: RawJsonRecord, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}
function exactKeys(value: RawJsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}
function validDomain(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.toLowerCase() &&
    DOMAIN.test(value)
  );
}
function validExternalId(providerKey: string, value: unknown): value is string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > 256 ||
    !EXTERNAL_ID.test(value) ||
    !isSecretFreeText(value)
  ) {
    return false;
  }
  switch (providerKey) {
    case "wikidata":
      return /^wikidata:Q[1-9]\d{0,15}$/u.test(value);
    case "openstreetmap":
      return /^osm:(?:node|way|relation)\/\d{1,20}$/u.test(value);
    case "ted":
      return /^ted:\d{1,9}(?:-\d{4})?:\d{1,6}$/u.test(value);
    case "openfda":
      return /^openfda:(?:\d{1,32}|[0-9a-f]{64})$/u.test(value);
    default:
      return isContactFreeText(value);
  }
}
function codeToken(value: unknown, maximumBytes = 128): value is string {
  return (
    typeof value === "string" &&
    value.normalize("NFKC") === value &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    CODE_TOKEN.test(value) &&
    isContactFreeText(value)
  );
}
function validIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isSecretFreeText(value: unknown): value is string {
  return typeof value === "string" && !PII_OR_SECRET.test(value);
}
export function isProviderCompanyName(value: unknown): value is string {
  return typeof value === "string" && isContactFreeText(value);
}
export function isContactFreeText(value: unknown): value is string {
  return isSecretFreeText(value) && !CONTACT_LIKE_PHONE.test(value);
}
export function isControlledBusinessTerm(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.normalize("NFKC").trim();
  const tokens = normalized
    .toLowerCase()
    .split(/[\s_-]+/u)
    .filter(Boolean);
  return (
    normalized === value &&
    Buffer.byteLength(value, "utf8") <= 80 &&
    tokens.length >= 1 &&
    tokens.length <= 4 &&
    isContactFreeText(value) &&
    tokens.every((token) => CONTROLLED_BUSINESS_TOKENS.has(token))
  );
}
function controlledTerms(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.length <= 20 &&
    value.every(isControlledBusinessTerm)
    ? ([...value] as string[])
    : null;
}

function stableDecodedPath(pathname: string): string | null {
  let current = pathname;
  for (let pass = 0; pass < 6; pass += 1) {
    if (!isContactFreeText(current)) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded === current) return /%25/iu.test(current) ? null : current;
    current = decoded;
  }
  return null;
}

export function isStableSafeHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      (parsed.port === "" || parsed.port === "443") &&
      validDomain(parsed.hostname.toLowerCase()) &&
      isContactFreeText(value) &&
      stableDecodedPath(parsed.pathname) !== null
    );
  } catch {
    return false;
  }
}

function normalizeProvenance(
  providerKey: string,
  value: unknown,
  payload: RawJsonRecord,
): RawJsonRecord | null {
  const input = record(value);
  if (
    !input ||
    !exactKeys(input, [
      "contentHash",
      "fetchedAt",
      "parserVersion",
      "sourceUrl",
    ]) ||
    !validIsoInstant(input.fetchedAt) ||
    !codeToken(input.parserVersion, 64) ||
    typeof input.sourceUrl !== "string"
  )
    return null;
  let sourceUrl = input.sourceUrl;
  if (providerKey === "openstreetmap") {
    try {
      const parsed = new URL(sourceUrl);
      const osmId = String(record(payload.attributes)?.osm_id ?? "");
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname !== "www.openstreetmap.org" ||
        parsed.pathname !== `/${osmId}` ||
        !/^(?:node|way|relation)\/\d{1,20}$/u.test(osmId)
      ) {
        return null;
      }
      sourceUrl = "https://overpass-api.de/api/interpreter";
    } catch {
      return null;
    }
  } else if (providerKey === "ted") {
    try {
      const parsed = new URL(sourceUrl);
      const publication = String(
        record(record(payload.attributes)?.ted)?.publication_number ?? "",
      );
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname !== "ted.europa.eu" ||
        !parsed.pathname.endsWith(`/${publication}`) ||
        !/^\d{1,9}(?:-\d{4})?$/u.test(publication)
      ) {
        return null;
      }
      sourceUrl = "https://api.ted.europa.eu/v3/notices/search";
    } catch {
      return null;
    }
  } else if (providerKey === "openfda") {
    try {
      const parsed = new URL(sourceUrl);
      const registration = String(
        record(record(payload.attributes)?.fda)?.registration_number ?? "",
      );
      if (
        parsed.protocol === "https:" &&
        parsed.hostname === "api.fda.gov" &&
        parsed.pathname === "/device/registrationlisting.json" &&
        parsed.hash === "" &&
        parsed.search ===
          `?search=registration.registration_number:${registration}` &&
        /^\d{1,32}$/u.test(registration)
      ) {
        sourceUrl = "https://api.fda.gov/device/registrationlisting.json";
      } else if (
        parsed.protocol === "https:" &&
        parsed.hostname === "open.fda.gov" &&
        parsed.search === "" &&
        parsed.hash === ""
      ) {
        sourceUrl = "https://api.fda.gov/device/registrationlisting.json";
      }
    } catch {
      return null;
    }
  }
  if (!isStableSafeHttpsUrl(sourceUrl)) return null;
  let contentHash = input.contentHash;
  if (
    typeof contentHash === "string" &&
    !SHA256.test(contentHash) &&
    ["wikidata", "openstreetmap"].includes(providerKey) &&
    Buffer.byteLength(contentHash, "utf8") <= 128 &&
    CODE_TOKEN.test(contentHash) &&
    isSecretFreeText(contentHash)
  ) {
    contentHash = sha256(`${providerKey}:${contentHash}`);
  }
  if (typeof contentHash !== "string" || !SHA256.test(contentHash)) return null;
  return {
    sourceUrl,
    fetchedAt: input.fetchedAt,
    contentHash,
    parserVersion: input.parserVersion,
  };
}

function normalizeAttributes(
  providerKey: string,
  value: unknown,
): RawJsonRecord | null {
  const input = record(value);
  if (!input) return null;
  if (providerKey === "registry") {
    if (!keysWithin(input, ["employee_band", "employees", "products"]))
      return null;
    const products =
      input.products === undefined
        ? undefined
        : controlledTerms(input.products);
    if (products === null) return null;
    return {
      ...(products ? { products } : {}),
      ...(input.employee_band !== undefined
        ? { employee_band: input.employee_band }
        : {}),
      ...(input.employees !== undefined ? { employees: input.employees } : {}),
    };
  }
  if (providerKey === "directory") {
    if (
      !keysWithin(input, [
        "detail_url",
        "listing_location",
        "source_class",
        "source_directory",
        "source_kind",
      ]) ||
      !validDomain(input.source_directory) ||
      input.source_class !== "industry_data" ||
      (input.detail_url != null && !isStableSafeHttpsUrl(input.detail_url))
    )
      return null;
    return {
      source_kind: "directory",
      source_directory: input.source_directory,
      ...(typeof input.detail_url === "string"
        ? { detail_url: input.detail_url }
        : {}),
      source_class: input.source_class,
    };
  }
  if (providerKey === "wikidata")
    return keysWithin(input, [
      "latitude",
      "longitude",
      "source_class",
      "wikidata_qid",
    ])
      ? { ...input }
      : null;
  if (providerKey === "openstreetmap") {
    if (
      !keysWithin(input, [
        "city",
        "latitude",
        "longitude",
        "osm_id",
        "osm_tags",
        "source_class",
      ])
    )
      return null;
    return Object.fromEntries(
      ["osm_id", "latitude", "longitude", "source_class"].flatMap((key) =>
        input[key] === undefined ? [] : [[key, input[key]]],
      ),
    );
  }
  if (providerKey === "trade_fair") {
    if (
      !keysWithin(input, [
        "description",
        "hall",
        "hiring_signal",
        "products",
        "public_email",
        "public_phone",
        "source_class",
        "source_fair",
        "source_fair_name",
        "source_kind",
        "stand",
      ])
    )
      return null;
    const products =
      input.products === undefined
        ? undefined
        : controlledTerms(input.products);
    if (products === null) return null;
    return Object.fromEntries(
      [
        ["hall", input.hall],
        ["hiring_signal", input.hiring_signal],
        ["products", products],
        ["source_class", input.source_class],
        ["source_fair", input.source_fair],
        ["source_kind", input.source_kind],
        ["stand", input.stand],
      ].flatMap(([key, item]) => (item == null ? [] : [[key, item]])),
    );
  }
  if (providerKey === "ted") {
    if (!exactKeys(input, ["ted"])) return null;
    const ted = record(input.ted);
    if (
      !ted ||
      !keysWithin(ted, [
        "attribution",
        "buyer_countries",
        "buyer_names",
        "cpv",
        "license",
        "notice_type",
        "publication_date",
        "publication_number",
        "winner_city",
        "winner_identifier",
      ])
    )
      return null;
    return {
      ted: Object.fromEntries(
        [
          ["publication_number", ted.publication_number],
          [
            "publication_date",
            typeof ted.publication_date === "string"
              ? ted.publication_date.slice(0, 10)
              : ted.publication_date,
          ],
          ["notice_type", ted.notice_type],
          ["cpv", ted.cpv],
          ["buyer_countries", ted.buyer_countries],
          ["winner_identifier", ted.winner_identifier],
        ].flatMap(([key, item]) => (item == null ? [] : [[key, item]])),
      ),
    };
  }
  if (providerKey === "openfda") {
    if (!keysWithin(input, ["fda", "products"])) return null;
    const fda = record(input.fda);
    if (
      !fda ||
      !keysWithin(fda, [
        "attribution",
        "city",
        "created_date",
        "device_facts",
        "disclaimer",
        "establishment_types",
        "fei_number",
        "initial_importer",
        "license",
        "owner_operator_numbers",
        "product_codes",
        "registration_number",
        "state_code",
        "status_code",
      ])
    )
      return null;
    const safe = Object.fromEntries(
      [
        "created_date",
        "fei_number",
        "initial_importer",
        "owner_operator_numbers",
        "product_codes",
        "registration_number",
        "state_code",
        "status_code",
      ].flatMap((key) => (fda[key] === undefined ? [] : [[key, fda[key]]])),
    );
    return {
      fda: safe,
      ...(Array.isArray(fda.product_codes)
        ? { products: [...fda.product_codes] }
        : {}),
    };
  }
  if (providerKey === "public_web") {
    if (
      !keysWithin(input, [
        "extraction_confidence",
        "extraction_evidence",
        "extraction_evidence_digest",
        "keywords",
        "products",
        "source_class",
      ])
    )
      return null;
    const products =
      input.products === undefined ? [] : controlledTerms(input.products);
    const keywords =
      input.keywords === undefined ? [] : controlledTerms(input.keywords);
    if (products === null || keywords === null) return null;
    const confidence =
      input.extraction_confidence == null ? 0 : input.extraction_confidence;
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    )
      return null;
    let digest = input.extraction_evidence_digest;
    if (digest === undefined) {
      if (
        input.extraction_evidence != null &&
        typeof input.extraction_evidence !== "string"
      )
        return null;
      digest = sha256(String(input.extraction_evidence ?? ""));
    }
    if (typeof digest !== "string" || !SHA256.test(digest)) return null;
    return {
      products,
      keywords,
      extraction_evidence_digest: digest,
      extraction_confidence: confidence,
      source_class: input.source_class,
    };
  }
  return null;
}

export function normalizeRawSourceProviderPayload(
  providerKey: string,
  input: RawJsonRecord,
): RawJsonRecord | null {
  if (!keysWithin(input, PROVIDER_KEYS[providerKey] ?? [])) return null;
  const attributes = normalizeAttributes(providerKey, input.attributes);
  const provenance = normalizeProvenance(providerKey, input.provenance, input);
  if (!attributes || !provenance) return null;
  let externalId = input.externalId;
  if (
    providerKey === "openfda" &&
    typeof externalId === "string" &&
    !validExternalId(providerKey, externalId)
  )
    externalId = `openfda:${sha256(externalId)}`;
  const license =
    input.license ??
    (
      { wikidata: "CC0-1.0", openstreetmap: "ODbL-1.0" } as Record<
        string,
        string
      >
    )[providerKey];
  return Object.fromEntries(
    [
      ["externalId", externalId],
      ["name", input.name],
      ["domain", input.domain],
      ["country", input.country],
      ["employeeCount", input.employeeCount],
      ["revenueUsd", input.revenueUsd],
      ["attributes", attributes],
      ["identifier", input.identifier],
      ["license", license],
      ["provenance", provenance],
      ["monitoredSource", input.monitoredSource],
    ].flatMap(([key, item]) => (item === undefined ? [] : [[key, item]])),
  );
}
