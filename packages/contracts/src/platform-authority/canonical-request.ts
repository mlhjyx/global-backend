export const PLATFORM_AUTHORITY_CANONICAL_REQUEST_VERSION =
  "platform-authority-canonical-request/v1" as const;
export const PLATFORM_AUTHORITY_REQUEST_HMAC_VERSION =
  "platform-authority-request-hmac/v1" as const;
export const PLATFORM_EXECUTION_TECHNICAL_QUOTE_HTTP_PATH =
  "/api/v1/platform-authority/technical-quote" as const;

export const PLATFORM_AUTHORITY_MAX_RAW_BODY_BYTES = 16 * 1024;
const MAX_SIGNED_64 = "9223372036854775807";
const MAX_REFERENCE_COUNT = "1000000";
const MAX_NUMERIC_DATE = "253402300799";
const ASCII_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METHOD = /^[A-Z]{3,10}$/;
const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/;
const AUDIENCE = /^[a-z0-9][a-z0-9._:/-]{0,199}$/;
const ENVIRONMENT_ID = /^[a-z][a-z0-9-]{0,62}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL_CHARACTER = /\p{Cc}/u;
const SCHEMA_BRAND: unique symbol = Symbol("platform-authority-schema");

type ExactField = Readonly<{
  readonly name: string;
  readonly kind: "exact";
  readonly value: string;
}>;
type TextField = Readonly<{
  readonly name: string;
  readonly kind: "text";
  readonly minimumBytes: number;
  readonly maximumBytes: number;
}>;
type DecimalField = Readonly<{
  readonly name: string;
  readonly kind: "decimal";
  readonly minimum: string;
  readonly maximum: string;
}>;
type Sha256Field = Readonly<{
  readonly name: string;
  readonly kind: "sha256";
}>;
type UuidField = Readonly<{
  readonly name: string;
  readonly kind: "lowercase-uuid";
}>;
type Field = ExactField | TextField | DecimalField | Sha256Field | UuidField;

export interface PlatformAuthorityCanonicalSchemaV1 {
  readonly schemaId: string;
  readonly fields: readonly Field[];
  readonly [SCHEMA_BRAND]: true;
}

export interface CanonicalizedPlatformAuthorityRequestBodyV1 {
  readonly schemaId: string;
  readonly values: Readonly<Record<string, string>>;
  readonly canonicalBodyUtf8: string;
  readonly canonicalBodyByteLength: number;
}

export interface PlatformAuthorityRequestHmacPreimageV1Input {
  readonly method: string;
  readonly normalized_path: string;
  readonly growthos_audience: string;
  readonly environment_id: string;
  readonly numeric_date: string;
  readonly key_id: string;
  readonly nonce: string;
  readonly canonical_body_sha256: string;
}

export class PlatformAuthorityCanonicalSchemaError extends Error {
  readonly code = "PLATFORM_AUTHORITY_CANONICAL_SCHEMA_INVALID" as const;

  constructor() {
    super("PLATFORM_AUTHORITY_CANONICAL_SCHEMA_INVALID");
    this.name = "PlatformAuthorityCanonicalSchemaError";
  }
}

export class PlatformAuthorityCanonicalRequestError extends Error {
  readonly code = "PLATFORM_AUTHORITY_CANONICAL_REQUEST_INVALID" as const;

  constructor() {
    super("PLATFORM_AUTHORITY_CANONICAL_REQUEST_INVALID");
    this.name = "PlatformAuthorityCanonicalRequestError";
  }
}

export class PlatformAuthorityHmacPreimageError extends Error {
  readonly code = "PLATFORM_AUTHORITY_HMAC_PREIMAGE_INVALID" as const;

  constructor() {
    super("PLATFORM_AUTHORITY_HMAC_PREIMAGE_INVALID");
    this.name = "PlatformAuthorityHmacPreimageError";
  }
}

function schemaInvalid(): never {
  throw new PlatformAuthorityCanonicalSchemaError();
}

function requestInvalid(): never {
  throw new PlatformAuthorityCanonicalRequestError();
}

function preimageInvalid(): never {
  throw new PlatformAuthorityHmacPreimageError();
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotOwnDataProperties(
  value: unknown,
  expectedKeys: readonly string[],
  invalid: () => never,
): Readonly<Record<string, unknown>> {
  let descriptors: PropertyDescriptorMap;
  try {
    if (!isPlainRecord(value)) return invalid();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return invalid();
  }
  const descriptorKeys = Reflect.ownKeys(descriptors);
  if (
    descriptorKeys.some((key) => typeof key !== "string") ||
    descriptorKeys.length !== expectedKeys.length ||
    [...descriptorKeys].sort().join("\0") !==
      [...expectedKeys].sort().join("\0")
  ) {
    invalid();
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of expectedKeys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, "value") ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      invalid();
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_BUFFER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)!.get!;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)!.get!;
const TYPED_ARRAY_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "length",
)!.get!;
const ARRAY_BUFFER_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;

function copyBoundedRawBody(value: unknown): Uint8Array {
  let backingBuffer: ArrayBufferLike;
  let byteLength: number;
  let elementLength: number;
  try {
    if (!ArrayBuffer.isView(value)) return requestInvalid();
    backingBuffer = TYPED_ARRAY_BUFFER.call(value) as ArrayBufferLike;
    byteLength = TYPED_ARRAY_BYTE_LENGTH.call(value) as number;
    elementLength = TYPED_ARRAY_LENGTH.call(value) as number;
    ARRAY_BUFFER_BYTE_LENGTH.call(backingBuffer);
  } catch {
    return requestInvalid();
  }
  if (
    byteLength < 1 ||
    byteLength > PLATFORM_AUTHORITY_MAX_RAW_BODY_BYTES ||
    byteLength !== elementLength
  ) {
    requestInvalid();
  }
  const bytes = new Uint8Array(byteLength);
  try {
    Uint8Array.prototype.set.call(bytes, value as unknown as ArrayLike<number>);
  } catch {
    return requestInvalid();
  }
  return bytes;
}

const CODE_OWNED_SCHEMAS = new WeakSet<object>();

function defineCodeOwnedSchema(
  schemaId: string,
  fields: readonly Field[],
): PlatformAuthorityCanonicalSchemaV1 {
  const schema = deepFreeze({
    schemaId,
    fields: fields.map((field) => ({ ...field })),
    [SCHEMA_BRAND]: true as const,
  });
  CODE_OWNED_SCHEMAS.add(schema);
  return schema;
}

/**
 * Codec-only conformance schema shared with GrowthOS. It is deliberately not
 * an issuance, quote, grant, or authorization body. Product schemas are added
 * as separate code-owned constants when their contracts are approved.
 */
export const PLATFORM_AUTHORITY_CANONICAL_REFERENCE_SCHEMA_V1 =
  defineCodeOwnedSchema("platform-authority-canonical-reference/v1", [
    {
      name: "amount_microusd",
      kind: "decimal",
      minimum: "0",
      maximum: MAX_SIGNED_64,
    },
    {
      name: "count",
      kind: "decimal",
      minimum: "0",
      maximum: MAX_REFERENCE_COUNT,
    },
    { name: "digest_sha256", kind: "sha256" },
    { name: "label", kind: "text", minimumBytes: 1, maximumBytes: 128 },
    {
      name: "numeric_date",
      kind: "decimal",
      minimum: "0",
      maximum: MAX_NUMERIC_DATE,
    },
    {
      name: "padding",
      kind: "text",
      minimumBytes: 0,
      maximumBytes: 16080,
    },
    {
      name: "schema_version",
      kind: "exact",
      value: "platform-authority-canonical-reference/v1",
    },
    { name: "workflow_run_id", kind: "lowercase-uuid" },
  ]);

const PLATFORM_EXECUTION_TECHNICAL_QUOTE_COMMON_FIELDS = Object.freeze([
  {
    name: "execution_envelope_schema_version",
    kind: "exact",
    value: "platform-execution-envelope/v1",
  },
  { name: "execution_envelope_sha256", kind: "sha256" },
  {
    name: "expires_at",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_NUMERIC_DATE,
  },
  { name: "hard_bounds_sha256", kind: "sha256" },
  {
    name: "issued_at",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_NUMERIC_DATE,
  },
  {
    name: "maximum_activity_attempts",
    kind: "decimal",
    minimum: "1",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_bytes_per_patent_anchor",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_due_sources",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_fallback_wires",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_input_tokens",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_costed_invocations",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_durable_result_bytes",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_output_items_per_wire",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_output_tokens",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_pages_per_source",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_patent_anchors",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_physical_invocations",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_redirects_per_operation",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_repair_wires",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_sanctions_sources",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_source_fetch_items",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "maximum_transport_response_bytes_per_wire",
    kind: "decimal",
    minimum: "0",
    maximum: MAX_SIGNED_64,
  },
  { name: "physical_wire_contracts_sha256", kind: "sha256" },
  {
    name: "physical_wire_selection",
    kind: "text",
    minimumBytes: 1,
    maximumBytes: 100,
  },
  {
    name: "policy_artifact_id",
    kind: "text",
    minimumBytes: 1,
    maximumBytes: 200,
  },
  { name: "policy_artifact_sha256", kind: "sha256" },
  {
    name: "policy_matrix_revision",
    kind: "text",
    minimumBytes: 1,
    maximumBytes: 100,
  },
  { name: "policy_revision", kind: "sha256" },
  { name: "price_catalog_revision", kind: "sha256" },
  { name: "provider_snapshot_sha256", kind: "sha256" },
  {
    name: "purpose",
    kind: "text",
    minimumBytes: 1,
    maximumBytes: 100,
  },
  { name: "quote_id", kind: "lowercase-uuid" },
  {
    name: "request_contract_version",
    kind: "exact",
    value: "platform-schedule-authority-v1",
  },
  {
    name: "required_campaign_cap_microusd",
    kind: "decimal",
    minimum: "1",
    maximum: MAX_SIGNED_64,
  },
  {
    name: "required_cap_per_run_microusd",
    kind: "decimal",
    minimum: "1",
    maximum: MAX_SIGNED_64,
  },
  { name: "required_max_runs", kind: "exact", value: "1" },
  {
    name: "schedule_id",
    kind: "text",
    minimumBytes: 1,
    maximumBytes: 100,
  },
  { name: "schedule_request_sha256", kind: "sha256" },
  {
    name: "schema_version",
    kind: "exact",
    value: "platform-execution-technical-quote/v1",
  },
  {
    name: "temporal_namespace",
    kind: "exact",
    value: "platform-automation",
  },
  { name: "tool_contracts_sha256", kind: "sha256" },
  {
    name: "workflow_id",
    kind: "text",
    minimumBytes: 1,
    maximumBytes: 200,
  },
  { name: "workflow_run_id", kind: "lowercase-uuid" },
  {
    name: "workflow_type",
    kind: "text",
    minimumBytes: 1,
    maximumBytes: 120,
  },
] satisfies readonly Field[]);

/**
 * Exact request accepted by the service-only Platform quote reader. Amounts,
 * provider state and customer identity are deliberately absent: the Backend
 * derives the technical envelope from its own immutable contracts.
 */
export const PLATFORM_EXECUTION_TECHNICAL_QUOTE_REQUEST_SCHEMA_V1 =
  defineCodeOwnedSchema("platform-execution-technical-quote-request/v1", [
    {
      name: "schema_version",
      kind: "exact",
      value: "platform-execution-technical-quote-request/v1",
    },
    {
      name: "purpose",
      kind: "text",
      minimumBytes: 1,
      maximumBytes: 100,
    },
    {
      name: "temporal_namespace",
      kind: "exact",
      value: "platform-automation",
    },
    {
      name: "schedule_id",
      kind: "text",
      minimumBytes: 1,
      maximumBytes: 100,
    },
    {
      name: "workflow_type",
      kind: "text",
      minimumBytes: 1,
      maximumBytes: 120,
    },
    {
      name: "workflow_id",
      kind: "text",
      minimumBytes: 1,
      maximumBytes: 200,
    },
    { name: "workflow_run_id", kind: "lowercase-uuid" },
    { name: "schedule_request_sha256", kind: "sha256" },
  ]);

/**
 * Product quote hash preimage. `quote_sha256` is deliberately absent so the
 * digest is non-self-referential and independently reproducible in GrowthOS.
 */
export const PLATFORM_EXECUTION_TECHNICAL_QUOTE_HASH_PREIMAGE_SCHEMA_V1 =
  defineCodeOwnedSchema(
    "platform-execution-technical-quote-hash-preimage/v1",
    PLATFORM_EXECUTION_TECHNICAL_QUOTE_COMMON_FIELDS,
  );

/** Exact closed wire body returned by the Platform technical quote reader. */
export const PLATFORM_EXECUTION_TECHNICAL_QUOTE_SCHEMA_V1 =
  defineCodeOwnedSchema("platform-execution-technical-quote/v1", [
    ...PLATFORM_EXECUTION_TECHNICAL_QUOTE_COMMON_FIELDS,
    { name: "quote_sha256", kind: "sha256" },
  ]);

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (
    source[index] === " " ||
    source[index] === "\t" ||
    source[index] === "\n" ||
    source[index] === "\r"
  ) {
    index += 1;
  }
  return index;
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function parseJsonString(
  source: string,
  start: number,
): Readonly<{ readonly value: string; readonly end: number }> {
  if (source[start] !== '"') requestInvalid();
  let index = start + 1;
  while (index < source.length) {
    const code = source.charCodeAt(index);
    if (code === 0x22) {
      const lexeme = source.slice(start, index + 1);
      let value: unknown;
      try {
        value = JSON.parse(lexeme);
      } catch {
        return requestInvalid();
      }
      if (typeof value !== "string" || containsUnpairedSurrogate(value)) {
        requestInvalid();
      }
      return Object.freeze({ value, end: index + 1 });
    }
    if (code < 0x20) requestInvalid();
    if (code === 0x5c) {
      index += 1;
      if (index >= source.length) requestInvalid();
      const escape = source[index]!;
      if ('"\\/bfnrt'.includes(escape)) {
        index += 1;
        continue;
      }
      if (
        escape !== "u" ||
        !/^[0-9a-fA-F]{4}$/.test(source.slice(index + 1, index + 5))
      ) {
        requestInvalid();
      }
      index += 5;
      continue;
    }
    index += 1;
  }
  return requestInvalid();
}

function parseClosedStringObject(
  source: string,
): Readonly<Record<string, string>> {
  let index = skipWhitespace(source, 0);
  if (source[index] !== "{") requestInvalid();
  index = skipWhitespace(source, index + 1);
  const values: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const normalizedKeys = new Set<string>();
  if (source[index] === "}") {
    index = skipWhitespace(source, index + 1);
    if (index !== source.length) requestInvalid();
    return Object.freeze(values);
  }
  while (index < source.length) {
    const keyToken = parseJsonString(source, index);
    const normalizedKey = keyToken.value.normalize("NFC");
    if (normalizedKeys.has(normalizedKey)) requestInvalid();
    normalizedKeys.add(normalizedKey);
    if (
      keyToken.value !== normalizedKey ||
      !ASCII_KEY.test(keyToken.value) ||
      Object.hasOwn(values, keyToken.value)
    ) {
      requestInvalid();
    }
    index = skipWhitespace(source, keyToken.end);
    if (source[index] !== ":") requestInvalid();
    index = skipWhitespace(source, index + 1);
    if (source[index] !== '"') requestInvalid();
    const valueToken = parseJsonString(source, index);
    const normalizedValue = valueToken.value.normalize("NFC");
    if (
      containsUnpairedSurrogate(normalizedValue) ||
      CONTROL_CHARACTER.test(normalizedValue)
    ) {
      requestInvalid();
    }
    values[keyToken.value] = normalizedValue;
    index = skipWhitespace(source, valueToken.end);
    if (source[index] === "}") {
      index = skipWhitespace(source, index + 1);
      if (index !== source.length) requestInvalid();
      return Object.freeze(values);
    }
    if (source[index] !== ",") requestInvalid();
    index = skipWhitespace(source, index + 1);
  }
  return requestInvalid();
}

function decimalWithin(
  value: string,
  minimum: string,
  maximum: string,
): boolean {
  if (!CANONICAL_DECIMAL.test(value)) return false;
  const compare = (left: string, right: string): number =>
    left.length !== right.length
      ? left.length - right.length
      : left === right
        ? 0
        : left < right
          ? -1
          : 1;
  return compare(value, minimum) >= 0 && compare(value, maximum) <= 0;
}

function validField(field: Field, value: string): boolean {
  switch (field.kind) {
    case "exact":
      return value === field.value;
    case "text": {
      const bytes = Buffer.byteLength(value, "utf8");
      return bytes >= field.minimumBytes && bytes <= field.maximumBytes;
    }
    case "decimal":
      return decimalWithin(value, field.minimum, field.maximum);
    case "sha256":
      return SHA256.test(value);
    case "lowercase-uuid":
      return LOWERCASE_UUID.test(value);
  }
}

function canonicalJson(values: Readonly<Record<string, string>>): string {
  return `{${Object.keys(values)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(values[key])}`)
    .join(",")}}`;
}

export function canonicalizePlatformAuthorityRequestBodyV1(input: {
  readonly contentType: string;
  readonly rawBody: Uint8Array;
  readonly schema: PlatformAuthorityCanonicalSchemaV1;
}): CanonicalizedPlatformAuthorityRequestBodyV1 {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    schemaInvalid();
  }
  const envelope = snapshotOwnDataProperties(
    input,
    ["contentType", "rawBody", "schema"],
    requestInvalid,
  );
  const schema = envelope.schema;
  if (
    schema === null ||
    typeof schema !== "object" ||
    !CODE_OWNED_SCHEMAS.has(schema)
  ) {
    schemaInvalid();
  }
  const approvedSchema = schema as PlatformAuthorityCanonicalSchemaV1;
  const contentType = envelope.contentType;
  if (contentType !== "application/json") requestInvalid();
  const rawBody = copyBoundedRawBody(envelope.rawBody);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      rawBody,
    );
  } catch {
    return requestInvalid();
  }
  if (source.charCodeAt(0) === 0xfeff) requestInvalid();
  const values = parseClosedStringObject(source);
  const expectedKeys = approvedSchema.fields.map((field) => field.name).sort();
  const actualKeys = Object.keys(values).sort();
  if (actualKeys.join("\0") !== expectedKeys.join("\0")) requestInvalid();
  for (const field of approvedSchema.fields) {
    if (!validField(field, values[field.name]!)) requestInvalid();
  }
  const canonicalBodyUtf8 = canonicalJson(values);
  return deepFreeze({
    schemaId: approvedSchema.schemaId,
    values: { ...values },
    canonicalBodyUtf8,
    canonicalBodyByteLength: Buffer.byteLength(canonicalBodyUtf8, "utf8"),
  });
}

function validNormalizedPath(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > 512 ||
    !PATH.test(value) ||
    value.includes("//") ||
    (value.length > 1 && value.endsWith("/"))
  ) {
    return false;
  }
  return !value
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}

export function buildPlatformAuthorityRequestHmacPreimageV1(
  input: PlatformAuthorityRequestHmacPreimageV1Input,
): string {
  const keys = [
    "canonical_body_sha256",
    "environment_id",
    "growthos_audience",
    "key_id",
    "method",
    "nonce",
    "normalized_path",
    "numeric_date",
  ] as const;
  const fields = snapshotOwnDataProperties(input, keys, preimageInvalid);
  const canonicalBodySha256 = fields.canonical_body_sha256;
  const environmentId = fields.environment_id;
  const growthosAudience = fields.growthos_audience;
  const keyId = fields.key_id;
  const method = fields.method;
  const nonce = fields.nonce;
  const normalizedPath = fields.normalized_path;
  const numericDate = fields.numeric_date;
  if (
    typeof canonicalBodySha256 !== "string" ||
    typeof environmentId !== "string" ||
    typeof growthosAudience !== "string" ||
    typeof keyId !== "string" ||
    typeof method !== "string" ||
    typeof nonce !== "string" ||
    typeof normalizedPath !== "string" ||
    typeof numericDate !== "string" ||
    !METHOD.test(method) ||
    !validNormalizedPath(normalizedPath) ||
    !AUDIENCE.test(growthosAudience) ||
    !ENVIRONMENT_ID.test(environmentId) ||
    !decimalWithin(numericDate, "0", MAX_NUMERIC_DATE) ||
    !KEY_ID.test(keyId) ||
    !LOWERCASE_UUID.test(nonce) ||
    !SHA256.test(canonicalBodySha256)
  ) {
    preimageInvalid();
  }
  return [
    PLATFORM_AUTHORITY_REQUEST_HMAC_VERSION,
    method,
    normalizedPath,
    growthosAudience,
    environmentId,
    numericDate,
    keyId,
    nonce,
    canonicalBodySha256,
  ].join("\n");
}
