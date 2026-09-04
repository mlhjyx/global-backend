export const PLATFORM_AUTHORITY_CANONICAL_REQUEST_VERSION =
  "platform-authority-canonical-request/v1" as const;
export const PLATFORM_AUTHORITY_REQUEST_HMAC_VERSION =
  "platform-authority-request-hmac/v1" as const;

const MAX_RAW_BODY_BYTES = 16 * 1024;
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
    left.length === right.length
      ? left.localeCompare(right)
      : left.length - right.length;
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
  if (
    !isPlainRecord(input) ||
    input.schema === null ||
    typeof input.schema !== "object" ||
    !CODE_OWNED_SCHEMAS.has(input.schema)
  ) {
    schemaInvalid();
  }
  if (
    input.contentType !== "application/json" ||
    !(input.rawBody instanceof Uint8Array) ||
    input.rawBody.byteLength < 1 ||
    input.rawBody.byteLength > MAX_RAW_BODY_BYTES
  ) {
    requestInvalid();
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      input.rawBody,
    );
  } catch {
    return requestInvalid();
  }
  if (source.charCodeAt(0) === 0xfeff) requestInvalid();
  const values = parseClosedStringObject(source);
  const expectedKeys = input.schema.fields.map((field) => field.name).sort();
  const actualKeys = Object.keys(values).sort();
  if (actualKeys.join("\0") !== expectedKeys.join("\0")) requestInvalid();
  for (const field of input.schema.fields) {
    if (!validField(field, values[field.name]!)) requestInvalid();
  }
  const canonicalBodyUtf8 = canonicalJson(values);
  return deepFreeze({
    schemaId: input.schema.schemaId,
    values: { ...values },
    canonicalBodyUtf8,
    canonicalBodyByteLength: Buffer.byteLength(canonicalBodyUtf8, "utf8"),
  });
}

function exactInputKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
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
  if (
    !isPlainRecord(input) ||
    !exactInputKeys(input, keys) ||
    !keys.every((key) => typeof input[key] === "string") ||
    !METHOD.test(input.method) ||
    !validNormalizedPath(input.normalized_path) ||
    !AUDIENCE.test(input.growthos_audience) ||
    !ENVIRONMENT_ID.test(input.environment_id) ||
    !decimalWithin(input.numeric_date, "0", MAX_NUMERIC_DATE) ||
    !KEY_ID.test(input.key_id) ||
    !LOWERCASE_UUID.test(input.nonce) ||
    !SHA256.test(input.canonical_body_sha256)
  ) {
    preimageInvalid();
  }
  return [
    PLATFORM_AUTHORITY_REQUEST_HMAC_VERSION,
    input.method,
    input.normalized_path,
    input.growthos_audience,
    input.environment_id,
    input.numeric_date,
    input.key_id,
    input.nonce,
    input.canonical_body_sha256,
  ].join("\n");
}
