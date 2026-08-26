import {
  isContactFreeText,
  isProviderCompanyName,
  isSecretFreeText,
  isStableSafeHttpsUrl,
  normalizeRawSourceProviderPayload,
} from "./raw-source-provider-normalizer";

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
  "industry",
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

function structuredToken(value: unknown, maximumBytes = 80): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.normalize("NFKC").trim();
  return (
    trimmed === value &&
    Buffer.byteLength(trimmed, "utf8") <= maximumBytes &&
    STRUCTURED_TOKEN.test(trimmed) &&
    trimmed.split(/\s+/u).length <= 8 &&
    isContactFreeText(trimmed)
  );
}

function codeToken(value: unknown, maximumBytes = 80): value is string {
  return (
    typeof value === "string" &&
    value.normalize("NFKC") === value &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    CODE_TOKEN.test(value) &&
    isContactFreeText(value)
  );
}

function providerIdentifierToken(
  value: unknown,
  maximumBytes = 80,
): value is string {
  return (
    typeof value === "string" &&
    value.normalize("NFKC") === value &&
    Buffer.byteLength(value, "utf8") <= maximumBytes &&
    /^[\p{L}\p{N}][\p{L}\p{N} ._:/-]*$/u.test(value) &&
    isSecretFreeText(value)
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
  if (typeof value !== "string") return false;
  const normalized = value.normalize("NFKC").trim();
  return (
    normalized === value &&
    Buffer.byteLength(value, "utf8") <= 160 &&
    STRUCTURED_TOKEN.test(value) &&
    value.split(/\s+/u).length <= 16 &&
    isProviderCompanyName(value)
  );
}

function validDomain(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.toLowerCase() &&
    DOMAIN.test(value) &&
    isSecretFreeText(value)
  );
}

function validGenericExternalId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    EXTERNAL_ID.test(value) &&
    isContactFreeText(value)
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
      return validGenericExternalId(value);
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
    isStableSafeHttpsUrl(input.sourceUrl) &&
    validIsoInstant(input.fetchedAt) &&
    typeof input.contentHash === "string" &&
    SHA256.test(input.contentHash) &&
    codeToken(input.parserVersion, 64),
  );
}

function validIdentifier(providerKey: string, value: unknown): boolean {
  if (value === undefined) return true;
  const input = record(value);
  if (!input || !exactKeys(input, ["scheme", "value"])) return false;
  const scheme = input.scheme;
  const identifier = input.value;
  if (typeof scheme !== "string" || typeof identifier !== "string") {
    return false;
  }
  if (
    identifier.normalize("NFKC") !== identifier ||
    Buffer.byteLength(identifier, "utf8") > 128 ||
    !isSecretFreeText(identifier)
  ) {
    return false;
  }
  if (providerKey === "registry") {
    return (
      (scheme === "registry-id" &&
        CODE_TOKEN.test(identifier) &&
        isContactFreeText(identifier)) ||
      (scheme === "lei" && /^[A-Z0-9]{20}$/u.test(identifier))
    );
  }
  if (providerKey === "ted") {
    return (
      /^ted-natid(?::[a-z]{2})?$/u.test(scheme) &&
      /^[\p{L}\p{N}][\p{L}\p{N} ._:/-]{0,79}$/u.test(identifier)
    );
  }
  if (providerKey === "openfda") {
    return scheme === "fda-reg" && /^\d{1,32}$/u.test(identifier);
  }
  return false;
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
    (value.detail_url === undefined ||
      isStableSafeHttpsUrl(value.detail_url)) &&
    validDomain(value.source_directory) &&
    value.source_kind === "directory" &&
    value.source_class === "industry_data"
  );
}

function validCoordinates(value: JsonRecord): boolean {
  const latitude = value.latitude;
  const longitude = value.longitude;
  return (
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
    validCoordinates(value) &&
    ["company_registry", "industry_data"].includes(String(value.source_class))
  );
}

function validOsmAttributes(value: JsonRecord): boolean {
  return (
    keysWithin(value, ["latitude", "longitude", "osm_id", "source_class"]) &&
    typeof value.osm_id === "string" &&
    /^(?:node|way|relation)\/\d{1,20}$/u.test(value.osm_id) &&
    validCoordinates(value) &&
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
    validGenericExternalId(input.sourceExternalId) &&
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
        (item) => typeof item === "string" && /^[A-Z]{2,3}$/u.test(item),
      )) &&
    (ted.winner_identifier === undefined ||
      providerIdentifierToken(ted.winner_identifier, 80))
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

function validProviderBindings(
  providerKey: string,
  payload: JsonRecord,
): boolean {
  const attributes = record(payload.attributes);
  const provenance = record(payload.provenance);
  if (!attributes || !provenance) return false;
  let host: string;
  let path: string;
  try {
    const source = new URL(String(provenance.sourceUrl));
    host = source.hostname.toLowerCase();
    path = source.pathname;
  } catch {
    return false;
  }
  switch (providerKey) {
    case "directory":
      return (
        (typeof payload.domain === "string"
          ? payload.externalId === `directory:${payload.domain}`
          : typeof payload.externalId === "string" &&
            payload.externalId.startsWith(
              `directory:${String(attributes.source_directory)}:`,
            )) &&
        host === attributes.source_directory
      );
    case "wikidata":
      return (
        payload.externalId === `wikidata:${String(attributes.wikidata_qid)}` &&
        host === "www.wikidata.org" &&
        path === `/wiki/${String(attributes.wikidata_qid)}`
      );
    case "openstreetmap":
      return (
        payload.externalId === `osm:${String(attributes.osm_id)}` &&
        host === "overpass-api.de" &&
        path === "/api/interpreter"
      );
    case "trade_fair": {
      const monitored = record(payload.monitoredSource);
      return typeof payload.externalId === "string" &&
        (monitored
          ? /^monitored:[0-9a-f]{64}$/u.test(payload.externalId)
          : payload.externalId.startsWith(
              `${String(attributes.source_fair)}:`,
            ));
    }
    case "ted": {
      const ted = record(attributes.ted);
      const identifier = record(payload.identifier);
      const externalId = String(payload.externalId);
      const prefix = `ted:${String(ted?.publication_number)}:`;
      return Boolean(
        ted &&
          externalId.startsWith(prefix) &&
          /^\d+$/u.test(externalId.slice(prefix.length)) &&
          host === "api.ted.europa.eu" &&
          path === "/v3/notices/search" &&
          (identifier === null || identifier.value === ted.winner_identifier),
      );
    }
    case "openfda": {
      const fda = record(attributes.fda);
      const identifier = record(payload.identifier);
      return Boolean(
        fda &&
          host === "api.fda.gov" &&
          path === "/device/registrationlisting.json" &&
          (identifier === null
            ? typeof payload.externalId === "string" &&
              /^openfda:[0-9a-f]{64}$/u.test(payload.externalId)
            : identifier.value === fda.registration_number &&
              payload.externalId === `openfda:${String(identifier.value)}`),
      );
    }
    case "public_web":
      return payload.externalId === payload.domain && host === payload.domain;
    default:
      return true;
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
  const governed = normalizeRawSourceProviderPayload(providerKey, input);
  if (!governed) {
    return { ok: false, reason: "PROVIDER_PAYLOAD_SCHEMA_INVALID" };
  }
  if (
    (governed.externalId !== undefined &&
      !validExternalId(providerKey, governed.externalId)) ||
    !validCompanyName(governed.name) ||
    (governed.domain !== undefined && !validDomain(governed.domain)) ||
    (governed.country !== undefined &&
      (typeof governed.country !== "string" ||
        !/^[A-Z]{2}$/u.test(governed.country))) ||
    (governed.employeeCount !== undefined &&
      (!Number.isSafeInteger(governed.employeeCount) ||
        Number(governed.employeeCount) < 0 ||
        Number(governed.employeeCount) > 10_000_000_000)) ||
    (governed.revenueUsd !== undefined &&
      (typeof governed.revenueUsd !== "number" ||
        !Number.isFinite(governed.revenueUsd) ||
        governed.revenueUsd < 0 ||
        governed.revenueUsd > 1_000_000_000_000_000)) ||
    !validAttributes(providerKey, governed.attributes) ||
    !validProviderBindings(providerKey, governed) ||
    !validIdentifier(providerKey, governed.identifier) ||
    !validProvenance(governed.provenance) ||
    (governed.license !== undefined &&
      (typeof governed.license !== "string" ||
        !LICENSES_BY_PROVIDER[providerKey]?.has(governed.license))) ||
    (["wikidata", "openstreetmap", "ted", "openfda"].includes(providerKey) &&
      governed.license === undefined) ||
    (providerKey === "trade_fair"
      ? !validMonitoredSource(governed.monitoredSource)
      : governed.monitoredSource !== undefined) ||
    (providerKey === "trade_fair" &&
      governed.monitoredSource === undefined &&
      (record(governed.attributes)?.source_fair === undefined ||
        record(governed.attributes)?.source_class !== "industry_data"))
  ) {
    return { ok: false, reason: "PROVIDER_PAYLOAD_SCHEMA_INVALID" };
  }
  return { ok: true, value: governed };
}
