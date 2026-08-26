type JsonRecord = Record<string, unknown>;

export type RawProviderPayloadValidation =
  | Readonly<{ ok: true; value: JsonRecord }>
  | Readonly<{
      ok: false;
      reason:
        | "MALFORMED_PAYLOAD"
        | "UNKNOWN_PAYLOAD_FIELD"
        | "UNGOVERNED_PROVIDER_PAYLOAD"
        | "PROVIDER_PAYLOAD_SCHEMA_INVALID";
    }>;

const TOP_LEVEL_KEYS = new Set([
  "externalId",
  "name",
  "domain",
  "country",
  "employeeCount",
  "revenueUsd",
  "attributes",
  "identifier",
  "license",
  "provenance",
  "monitoredSource",
]);
const SOURCE_CLASSES = new Set([
  "trade_data",
  "b2b_company_person",
  "company_registry",
  "contact_discovery",
  "email_verification",
  "public_intelligence",
  "industry_data",
]);
const GOVERNED_PROVIDERS = new Set([
  "registry",
  "directory",
  "wikidata",
  "openstreetmap",
  "trade_fair",
  "ted",
  "openfda",
  "public_web",
]);
const PROVIDER_TOP_LEVEL_KEYS: Readonly<Record<string, readonly string[]>> =
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
      "license",
      "name",
      "provenance",
    ],
  });
const LICENSES_BY_PROVIDER: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    registry: new Set(["public", "licensed", "byo"]),
    directory: new Set(["public", "licensed", "byo"]),
    wikidata: new Set(["CC0-1.0"]),
    openstreetmap: new Set(["ODbL-1.0"]),
    trade_fair: new Set(["SOURCE_SPECIFIC_RESTRICTED", "public"]),
    ted: new Set(["CC BY 4.0"]),
    openfda: new Set(["CC0-1.0"]),
    public_web: new Set(["public", "licensed", "byo"]),
  });
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u;
const STRUCTURED_TOKEN = /^[\p{L}\p{N}][\p{L}\p{N} ._+&'(),/#:-]*$/u;
const CODE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,79}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PII_OR_SECRET =
  /(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:bearer|basic auth|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|secret|password|passwd|private[_ -]?key|first[_ -]?name|last[_ -]?name|full[_ -]?name|contact[_ -]?name|personal data|jane doe|john doe|john smith)\b|\bsk-[a-z0-9_-]{6,})/iu;
const PHONE = /(?:^|[^\d])\+\d[\d ().-]{6,}\d(?:$|[^\d])/u;
const BUSINESS_NAME_MARKER =
  /\b(?:ag|ab|bv|co|company|corp|corporation|electric|engineering|group|gmbh|holding|holdings|inc|industrial|industries|kg|llc|ltd|maschinenbau|manufacturing|motors|nv|oy|pump|pumps|sa|sas|solutions|srl|systems|technologies|technology)\b/iu;
const PERSON_LIKE_NAME = /^\p{Lu}[\p{L}'-]+(?:\s+\p{Lu}[\p{L}'-]+){1,3}$/u;

function record(value: unknown): JsonRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as JsonRecord)
    : null;
}

class InvalidProviderContainerError extends Error {}

function withoutUndefined(
  value: unknown,
  state = { remaining: 256, ancestors: new Set<object>() },
  depth = 0,
): unknown {
  state.remaining -= 1;
  if (state.remaining < 0 || depth > 6) {
    throw new InvalidProviderContainerError("provider payload bounds exceeded");
  }
  if (Array.isArray(value)) {
    if (
      value.length > 20 ||
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.keys(value).length !== value.length
    ) {
      throw new InvalidProviderContainerError("invalid provider array");
    }
    if (state.ancestors.has(value)) {
      throw new InvalidProviderContainerError("cyclic provider payload");
    }
    state.ancestors.add(value);
    try {
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !("value" in descriptor)) {
          throw new InvalidProviderContainerError("provider array accessor");
        }
        return withoutUndefined(descriptor.value, state, depth + 1);
      });
    } finally {
      state.ancestors.delete(value);
    }
  }
  const input = record(value);
  if (!input) return value;
  if (state.ancestors.has(input)) {
    throw new InvalidProviderContainerError("cyclic provider payload");
  }
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length > 32 || ownKeys.some((key) => typeof key === "symbol")) {
    throw new InvalidProviderContainerError("invalid provider object keys");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  state.ancestors.add(input);
  try {
    return Object.fromEntries(
      Object.entries(descriptors).flatMap(([key, descriptor]) => {
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new InvalidProviderContainerError("provider object accessor");
        }
        return descriptor.value === undefined
          ? []
          : [[key, withoutUndefined(descriptor.value, state, depth + 1)]];
      }),
    );
  } finally {
    state.ancestors.delete(input);
  }
}

function exactKeys(value: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(ordinalCompare);
  const expected = [...keys].sort(ordinalCompare);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function keysWithin(value: JsonRecord, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function noSensitiveText(value: string): boolean {
  return (
    !PII_OR_SECRET.test(value) &&
    !PHONE.test(value) &&
    (!PERSON_LIKE_NAME.test(value) || BUSINESS_NAME_MARKER.test(value))
  );
}

function structuredToken(value: unknown, maximumBytes = 80): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.normalize("NFKC").trim();
  return (
    trimmed === value &&
    Buffer.byteLength(trimmed, "utf8") <= maximumBytes &&
    STRUCTURED_TOKEN.test(trimmed) &&
    trimmed.split(/\s+/u).length <= 8 &&
    noSensitiveText(trimmed)
  );
}

function codeToken(value: unknown, maximumBytes = 80): value is string {
  return (
    typeof value === "string" &&
    value.normalize("NFKC") === value &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    CODE_TOKEN.test(value) &&
    noSensitiveText(value)
  );
}

function tokenArray(
  value: unknown,
  predicate: (item: unknown) => boolean = structuredToken,
): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every((item) => predicate(item))
  );
}

function validCompanyName(value: unknown): value is string {
  return structuredToken(value, 160);
}

function validDomain(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.toLowerCase() &&
    DOMAIN.test(value) &&
    noSensitiveText(value)
  );
}

function validExternalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    EXTERNAL_ID.test(value) &&
    noSensitiveText(value)
  );
}

function validHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(parsed.pathname);
    } catch {
      return false;
    }
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      (parsed.port === "" || parsed.port === "443") &&
      validDomain(parsed.hostname.toLowerCase()) &&
      noSensitiveText(value) &&
      noSensitiveText(decodedPath)
    );
  } catch {
    return false;
  }
}

function validIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
  );
}

function validProvenance(value: unknown): boolean {
  const input = record(value);
  return Boolean(
    input &&
    exactKeys(input, [
      "contentHash",
      "fetchedAt",
      "parserVersion",
      "sourceUrl",
    ]) &&
    validHttpsUrl(input.sourceUrl) &&
    validIsoInstant(input.fetchedAt) &&
    typeof input.contentHash === "string" &&
    SHA256.test(input.contentHash) &&
    codeToken(input.parserVersion, 64),
  );
}

function validIdentifier(value: unknown): boolean {
  if (value === undefined) return true;
  const input = record(value);
  return Boolean(
    input &&
    exactKeys(input, ["scheme", "value"]) &&
    codeToken(input.scheme, 64) &&
    codeToken(input.value, 128),
  );
}

function validSourceClass(value: unknown): value is string {
  return typeof value === "string" && SOURCE_CLASSES.has(value);
}

function validRegistryAttributes(value: JsonRecord): boolean {
  if (!keysWithin(value, ["employee_band", "employees", "products"])) {
    return false;
  }
  return (
    (value.products === undefined || tokenArray(value.products)) &&
    (value.employee_band === undefined ||
      (typeof value.employee_band === "string" &&
        /^\d{1,7}(?:-\d{1,7}|\+)$/u.test(value.employee_band))) &&
    (value.employees === undefined ||
      (Number.isSafeInteger(value.employees) &&
        Number(value.employees) >= 0 &&
        Number(value.employees) <= 10_000_000_000))
  );
}

function validDirectoryAttributes(value: JsonRecord): boolean {
  return (
    keysWithin(value, [
      "detail_url",
      "source_class",
      "source_directory",
      "source_kind",
    ]) &&
    (value.detail_url === undefined || validHttpsUrl(value.detail_url)) &&
    validDomain(value.source_directory) &&
    value.source_kind === "directory" &&
    value.source_class === "industry_data"
  );
}

function validCoordinates(value: JsonRecord, idKey: string): boolean {
  const latitude = value.latitude;
  const longitude = value.longitude;
  return (
    codeToken(value[idKey], 80) &&
    (latitude === undefined ||
      (typeof latitude === "number" &&
        Number.isFinite(latitude) &&
        latitude >= -90 &&
        latitude <= 90)) &&
    (longitude === undefined ||
      (typeof longitude === "number" &&
        Number.isFinite(longitude) &&
        longitude >= -180 &&
        longitude <= 180)) &&
    validSourceClass(value.source_class)
  );
}

function validWikidataAttributes(value: JsonRecord): boolean {
  return (
    keysWithin(value, [
      "latitude",
      "longitude",
      "source_class",
      "wikidata_qid",
    ]) &&
    typeof value.wikidata_qid === "string" &&
    /^Q[1-9]\d{0,15}$/u.test(value.wikidata_qid) &&
    validCoordinates(value, "wikidata_qid") &&
    ["company_registry", "industry_data"].includes(String(value.source_class))
  );
}

function validOsmAttributes(value: JsonRecord): boolean {
  return (
    keysWithin(value, ["latitude", "longitude", "osm_id", "source_class"]) &&
    typeof value.osm_id === "string" &&
    /^(?:node|way|relation)\/\d{1,20}$/u.test(value.osm_id) &&
    validCoordinates(value, "osm_id") &&
    value.source_class === "industry_data"
  );
}

function validMonitoredSource(value: unknown): boolean {
  if (value === undefined) return true;
  const input = record(value);
  return Boolean(
    input &&
    exactKeys(input, [
      "originProviderKey",
      "sourceEntityId",
      "sourceExternalId",
      "sourceFetchId",
      "sourceId",
      "sourceKey",
    ]) &&
    typeof input.sourceId === "string" &&
    UUID.test(input.sourceId) &&
    typeof input.sourceEntityId === "string" &&
    UUID.test(input.sourceEntityId) &&
    typeof input.sourceFetchId === "string" &&
    UUID.test(input.sourceFetchId) &&
    validExternalId(input.sourceExternalId) &&
    codeToken(input.sourceKey, 128) &&
    ["mapyourshow", "trade_fair"].includes(String(input.originProviderKey)),
  );
}

function validTradeFairAttributes(value: JsonRecord): boolean {
  return (
    keysWithin(value, [
      "hall",
      "hiring_signal",
      "products",
      "source_class",
      "source_fair",
      "source_kind",
      "stand",
    ]) &&
    (value.hall === undefined || structuredToken(value.hall, 40)) &&
    (value.hiring_signal === undefined ||
      typeof value.hiring_signal === "boolean") &&
    (value.products === undefined || tokenArray(value.products)) &&
    (value.source_class === undefined ||
      value.source_class === "industry_data") &&
    (value.source_fair === undefined || codeToken(value.source_fair, 80)) &&
    (value.source_kind === undefined || codeToken(value.source_kind, 80)) &&
    (value.stand === undefined || structuredToken(value.stand, 40))
  );
}

function validTedAttributes(value: JsonRecord): boolean {
  if (!exactKeys(value, ["ted"])) return false;
  const ted = record(value.ted);
  if (
    !ted ||
    !keysWithin(ted, [
      "buyer_countries",
      "cpv",
      "notice_type",
      "publication_date",
      "publication_number",
      "winner_identifier",
    ])
  ) {
    return false;
  }
  return (
    typeof ted.publication_number === "string" &&
    /^\d{1,9}(?:-\d{4})?$/u.test(ted.publication_number) &&
    validIsoDate(ted.publication_date) &&
    typeof ted.notice_type === "string" &&
    /^(?:award|can|cn|pin|veat)(?:-[a-z0-9]+)*$/u.test(ted.notice_type) &&
    (ted.cpv === undefined ||
      tokenArray(
        ted.cpv,
        (item) => typeof item === "string" && /^\d{8}$/u.test(item),
      )) &&
    (ted.buyer_countries === undefined ||
      tokenArray(
        ted.buyer_countries,
        (item) => typeof item === "string" && /^[A-Z]{2}$/u.test(item),
      )) &&
    (ted.winner_identifier === undefined ||
      codeToken(ted.winner_identifier, 80))
  );
}

function validOpenFdaAttributes(value: JsonRecord): boolean {
  if (!keysWithin(value, ["fda", "products"])) return false;
  const fda = record(value.fda);
  if (
    !fda ||
    !keysWithin(fda, [
      "created_date",
      "fei_number",
      "initial_importer",
      "owner_operator_numbers",
      "product_codes",
      "registration_number",
      "state_code",
      "status_code",
    ])
  ) {
    return false;
  }
  const productCode = (item: unknown) =>
    typeof item === "string" && /^[A-Z0-9]{2,10}$/u.test(item);
  const numericId = (item: unknown) =>
    typeof item === "string" && /^\d{1,32}$/u.test(item);
  const hasStructuredFact =
    fda.registration_number !== undefined ||
    fda.fei_number !== undefined ||
    (Array.isArray(fda.product_codes) && fda.product_codes.length > 0);
  return (
    hasStructuredFact &&
    (fda.registration_number === undefined ||
      numericId(fda.registration_number)) &&
    (fda.fei_number === undefined || numericId(fda.fei_number)) &&
    (fda.status_code === undefined || codeToken(fda.status_code, 32)) &&
    (fda.state_code === undefined ||
      (typeof fda.state_code === "string" &&
        /^[A-Z0-9]{2,3}$/u.test(fda.state_code))) &&
    (fda.initial_importer === undefined ||
      typeof fda.initial_importer === "boolean") &&
    (fda.product_codes === undefined ||
      tokenArray(fda.product_codes, productCode)) &&
    (fda.owner_operator_numbers === undefined ||
      tokenArray(fda.owner_operator_numbers, numericId)) &&
    (fda.created_date === undefined || validIsoDate(fda.created_date)) &&
    (value.products === undefined || tokenArray(value.products, productCode))
  );
}

function validPublicWebAttributes(value: JsonRecord): boolean {
  return (
    keysWithin(value, [
      "extraction_confidence",
      "extraction_evidence_digest",
      "keywords",
      "products",
      "source_class",
    ]) &&
    (value.products === undefined || tokenArray(value.products)) &&
    (value.keywords === undefined || tokenArray(value.keywords)) &&
    typeof value.extraction_confidence === "number" &&
    Number.isFinite(value.extraction_confidence) &&
    value.extraction_confidence >= 0 &&
    value.extraction_confidence <= 1 &&
    typeof value.extraction_evidence_digest === "string" &&
    SHA256.test(value.extraction_evidence_digest) &&
    ["public_intelligence", "industry_data"].includes(
      String(value.source_class),
    )
  );
}

function validAttributes(providerKey: string, value: unknown): boolean {
  const input = record(value);
  if (!input) return false;
  switch (providerKey) {
    case "registry":
      return validRegistryAttributes(input);
    case "directory":
      return validDirectoryAttributes(input);
    case "wikidata":
      return validWikidataAttributes(input);
    case "openstreetmap":
      return validOsmAttributes(input);
    case "trade_fair":
      return validTradeFairAttributes(input);
    case "ted":
      return validTedAttributes(input);
    case "openfda":
      return validOpenFdaAttributes(input);
    case "public_web":
      return validPublicWebAttributes(input);
    default:
      return false;
  }
}

export function validateRawSourceProviderPayload(
  providerKey: string,
  value: unknown,
): RawProviderPayloadValidation {
  if (!GOVERNED_PROVIDERS.has(providerKey)) {
    return { ok: false, reason: "UNGOVERNED_PROVIDER_PAYLOAD" };
  }
  let normalized: unknown;
  try {
    normalized = withoutUndefined(value);
  } catch (error) {
    if (!(error instanceof InvalidProviderContainerError)) throw error;
    return { ok: false, reason: "PROVIDER_PAYLOAD_SCHEMA_INVALID" };
  }
  const input = record(normalized);
  if (!input) return { ok: false, reason: "MALFORMED_PAYLOAD" };
  if (Object.keys(input).some((key) => !TOP_LEVEL_KEYS.has(key))) {
    return { ok: false, reason: "UNKNOWN_PAYLOAD_FIELD" };
  }
  if (typeof input.name !== "string" || !input.name.trim()) {
    return { ok: false, reason: "MALFORMED_PAYLOAD" };
  }
  if (
    !keysWithin(input, PROVIDER_TOP_LEVEL_KEYS[providerKey] ?? []) ||
    (input.externalId !== undefined && !validExternalId(input.externalId)) ||
    !validCompanyName(input.name) ||
    (input.domain !== undefined && !validDomain(input.domain)) ||
    (input.country !== undefined &&
      (typeof input.country !== "string" ||
        !/^[A-Z]{2}$/u.test(input.country))) ||
    (input.employeeCount !== undefined &&
      (!Number.isSafeInteger(input.employeeCount) ||
        Number(input.employeeCount) < 0 ||
        Number(input.employeeCount) > 10_000_000_000)) ||
    (input.revenueUsd !== undefined &&
      (typeof input.revenueUsd !== "number" ||
        !Number.isFinite(input.revenueUsd) ||
        input.revenueUsd < 0 ||
        input.revenueUsd > 1_000_000_000_000_000)) ||
    !validAttributes(providerKey, input.attributes) ||
    !validIdentifier(input.identifier) ||
    !validProvenance(input.provenance) ||
    (input.license !== undefined &&
      (typeof input.license !== "string" ||
        !LICENSES_BY_PROVIDER[providerKey]?.has(input.license))) ||
    (["wikidata", "openstreetmap", "ted", "openfda"].includes(providerKey) &&
      input.license === undefined) ||
    (providerKey === "trade_fair"
      ? !validMonitoredSource(input.monitoredSource)
      : input.monitoredSource !== undefined) ||
    (providerKey === "trade_fair" &&
      input.monitoredSource === undefined &&
      (record(input.attributes)?.source_fair === undefined ||
        record(input.attributes)?.source_class !== "industry_data"))
  ) {
    return { ok: false, reason: "PROVIDER_PAYLOAD_SCHEMA_INVALID" };
  }
  return { ok: true, value: input };
}
