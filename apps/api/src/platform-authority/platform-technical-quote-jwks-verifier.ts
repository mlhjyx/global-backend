import {
  compactVerify,
  createLocalJWKSet,
  errors as joseErrors,
  importJWK,
} from "jose";
import type { CompactVerifyGetKey, JWK } from "jose";

import { resolveRuntimeMode } from "../runtime/runtime-environment";
import {
  PLATFORM_TECHNICAL_QUOTE_ACCESS_TOKEN_AUDIENCE,
  PLATFORM_TECHNICAL_QUOTE_ACCESS_TOKEN_TYPE,
  PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_NOT_READY,
  PLATFORM_TECHNICAL_QUOTE_PATH,
  PLATFORM_TECHNICAL_QUOTE_READER_PRINCIPAL,
  PLATFORM_TECHNICAL_QUOTE_READ_SCOPE,
  PlatformTechnicalQuoteServiceAuthenticationDeniedError,
  PlatformTechnicalQuoteServiceAuthenticationUnavailableError,
  PlatformTechnicalQuoteServiceAuthenticationVerifier,
  type PlatformTechnicalQuoteServiceAuthenticationReadiness,
  type PlatformTechnicalQuoteServiceAuthenticationRequest,
  type PlatformTechnicalQuoteServiceIdentity,
} from "./platform-technical-quote-service-auth";

const ALGORITHM = "RS256" as const;
const CLOCK_TOLERANCE_SECONDS = 60;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_JWKS_KEYS = 3;
const MAX_TOKEN_TTL_SECONDS = 300;
const JWKS_CACHE_MILLISECONDS = 5 * 60 * 1_000;
const JWKS_TIMEOUT_MILLISECONDS = 2_000;
const BOUNDED_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const HEADER_KEYS = Object.freeze(["alg", "kid", "typ"] as const);
const CLAIM_KEYS = Object.freeze([
  "aud",
  "exp",
  "iat",
  "iss",
  "jti",
  "nbf",
  "scope",
  "sub",
] as const);
const PRIVATE_JWK_MEMBERS = new Set([
  "d",
  "p",
  "q",
  "dp",
  "dq",
  "qi",
  "oth",
  "k",
]);
const READY = Object.freeze({
  status: "ready" as const,
  code: "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_READY" as const,
});
const CAPTURED_FETCH = fetch;

export interface PlatformTechnicalQuoteJwksVerifierConfiguration {
  readonly jwks: URL;
  readonly issuer: string;
}

export interface PlatformTechnicalQuoteJwksVerifierDependencies {
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
}

class PlatformTechnicalQuoteJwksUnavailableError extends Error {
  constructor() {
    super("PLATFORM_TECHNICAL_QUOTE_JWKS_UNAVAILABLE");
    this.name = "PlatformTechnicalQuoteJwksUnavailableError";
  }
}

function invalidConfiguration(): never {
  throw new Error("PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_CONFIG_INVALID");
}

function requiredCanonical(
  env: NodeJS.ProcessEnv,
  name: string,
  maximumBytes: number,
): string {
  const value = env[name];
  if (
    !value ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    return invalidConfiguration();
  }
  return value;
}

function trustedUrl(
  env: NodeJS.ProcessEnv,
  name: string,
  mode: ReturnType<typeof resolveRuntimeMode>,
): URL {
  const value = requiredCanonical(env, name, 2_048);
  try {
    const parsed = new URL(value);
    const loopback = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]).has(
      parsed.hostname.toLowerCase(),
    );
    const developmentTrustRoot =
      (mode === "development" || mode === "test") &&
      parsed.protocol === "http:" &&
      loopback;
    if (
      value !== parsed.href ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol !== "https:" && !developmentTrustRoot)
    ) {
      return invalidConfiguration();
    }
    return parsed;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_CONFIG_INVALID"
    ) {
      throw error;
    }
    return invalidConfiguration();
  }
}

export function validatePlatformTechnicalQuoteJwksVerifierConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): PlatformTechnicalQuoteJwksVerifierConfiguration {
  try {
    const mode = resolveRuntimeMode(env);
    const jwks = trustedUrl(
      env,
      "PLATFORM_TECHNICAL_QUOTE_AUTH_JWKS_URI",
      mode,
    );
    const issuer = trustedUrl(
      env,
      "PLATFORM_TECHNICAL_QUOTE_AUTH_ISSUER",
      mode,
    ).href;
    return Object.freeze({ jwks, issuer });
  } catch {
    return invalidConfiguration();
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function sameKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function canonicalBase64urlBytes(value: string): Buffer {
  if (!BASE64URL.test(value)) {
    throw new PlatformTechnicalQuoteServiceAuthenticationDeniedError();
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== value) {
    throw new PlatformTechnicalQuoteServiceAuthenticationDeniedError();
  }
  return bytes;
}

function strictUtf8(bytes: Uint8Array): string {
  try {
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (decoded.charCodeAt(0) === 0xfeff) {
      throw new Error("BOM is forbidden");
    }
    return decoded;
  } catch {
    throw new PlatformTechnicalQuoteServiceAuthenticationDeniedError();
  }
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

type FlatJsonValue = string | number;

/** Rejects duplicate decoded members before JOSE can overwrite them. */
class ClosedJwtObjectParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(
    expectedKeys: readonly string[],
  ): Readonly<Record<string, FlatJsonValue>> {
    try {
      this.skipWhitespace();
      if (this.source[this.index] !== "{") return this.invalid();
      this.index += 1;
      this.skipWhitespace();
      const result: Record<string, FlatJsonValue> = Object.create(
        null,
      ) as Record<string, FlatJsonValue>;
      const keys = new Set<string>();
      if (this.source[this.index] === "}") return this.invalid();
      for (;;) {
        const key = this.string();
        if (keys.has(key)) return this.invalid();
        keys.add(key);
        this.skipWhitespace();
        if (this.source[this.index] !== ":") return this.invalid();
        this.index += 1;
        this.skipWhitespace();
        const value =
          this.source[this.index] === '"' ? this.string() : this.integer();
        result[key] = value;
        this.skipWhitespace();
        const separator = this.source[this.index];
        if (separator === "}") {
          this.index += 1;
          break;
        }
        if (separator !== ",") return this.invalid();
        this.index += 1;
        this.skipWhitespace();
      }
      this.skipWhitespace();
      if (
        this.index !== this.source.length ||
        !sameKeys(result, expectedKeys)
      ) {
        return this.invalid();
      }
      return Object.freeze({ ...result });
    } catch (error) {
      if (
        error instanceof PlatformTechnicalQuoteServiceAuthenticationDeniedError
      ) {
        throw error;
      }
      return this.invalid();
    }
  }

  private skipWhitespace(): void {
    while ([" ", "\t", "\n", "\r"].includes(this.source[this.index] ?? "")) {
      this.index += 1;
    }
  }

  private string(): string {
    if (this.source[this.index] !== '"') return this.invalid();
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        let value: unknown;
        try {
          value = JSON.parse(this.source.slice(start, this.index));
        } catch {
          return this.invalid();
        }
        if (typeof value !== "string" || containsUnpairedSurrogate(value)) {
          return this.invalid();
        }
        return value;
      }
      if (code < 0x20) return this.invalid();
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.source[this.index];
        if (escape === undefined) return this.invalid();
        if ('"\\/bfnrt'.includes(escape)) {
          this.index += 1;
          continue;
        }
        if (
          escape !== "u" ||
          !/^[0-9a-fA-F]{4}$/u.test(
            this.source.slice(this.index + 1, this.index + 5),
          )
        ) {
          return this.invalid();
        }
        this.index += 5;
        continue;
      }
      this.index += 1;
    }
    return this.invalid();
  }

  private integer(): number {
    const start = this.index;
    if (this.source[this.index] === "0") {
      this.index += 1;
    } else {
      if (!/[1-9]/u.test(this.source[this.index] ?? "")) return this.invalid();
      while (/[0-9]/u.test(this.source[this.index] ?? "")) this.index += 1;
    }
    const value = Number(this.source.slice(start, this.index));
    if (!Number.isSafeInteger(value) || value < 0) return this.invalid();
    return value;
  }

  private invalid(): never {
    throw new PlatformTechnicalQuoteServiceAuthenticationDeniedError();
  }
}

interface ParsedServiceToken {
  readonly compact: string;
  readonly payloadBytes: Buffer;
}

function parseServiceToken(
  compactJws: string,
  issuer: string,
  now: Date,
): ParsedServiceToken {
  if (
    compactJws !== compactJws.trim() ||
    Buffer.byteLength(compactJws, "utf8") > MAX_TOKEN_BYTES
  ) {
    throw new PlatformTechnicalQuoteServiceAuthenticationDeniedError();
  }
  const segments = compactJws.split(".");
  if (segments.length !== 3) {
    throw new PlatformTechnicalQuoteServiceAuthenticationDeniedError();
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments as [
    string,
    string,
    string,
  ];
  const headerBytes = canonicalBase64urlBytes(encodedHeader);
  const payloadBytes = canonicalBase64urlBytes(encodedPayload);
  canonicalBase64urlBytes(encodedSignature);
  const header = new ClosedJwtObjectParser(strictUtf8(headerBytes)).parse(
    HEADER_KEYS,
  );
  if (
    header.alg !== ALGORITHM ||
    header.typ !== PLATFORM_TECHNICAL_QUOTE_ACCESS_TOKEN_TYPE ||
    typeof header.kid !== "string" ||
    !BOUNDED_KEY_ID.test(header.kid)
  ) {
    throw new PlatformTechnicalQuoteServiceAuthenticationDeniedError();
  }
  const claims = new ClosedJwtObjectParser(strictUtf8(payloadBytes)).parse(
    CLAIM_KEYS,
  );
  const issuedAt = claims.iat;
  const notBefore = claims.nbf;
  const expiresAt = claims.exp;
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (
    claims.iss !== issuer ||
    claims.aud !== PLATFORM_TECHNICAL_QUOTE_ACCESS_TOKEN_AUDIENCE ||
    claims.sub !== PLATFORM_TECHNICAL_QUOTE_READER_PRINCIPAL ||
    claims.scope !== PLATFORM_TECHNICAL_QUOTE_READ_SCOPE ||
    typeof claims.jti !== "string" ||
    !LOWERCASE_UUID.test(claims.jti) ||
    typeof issuedAt !== "number" ||
    typeof notBefore !== "number" ||
    typeof expiresAt !== "number" ||
    issuedAt > notBefore ||
    notBefore >= expiresAt ||
    expiresAt - issuedAt > MAX_TOKEN_TTL_SECONDS ||
    issuedAt > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
    notBefore > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
    expiresAt < nowSeconds - CLOCK_TOLERANCE_SECONDS
  ) {
    throw new PlatformTechnicalQuoteServiceAuthenticationDeniedError();
  }
  return Object.freeze({ compact: compactJws, payloadBytes });
}

function jwkBitLength(modulus: string): number {
  const bytes = canonicalBase64urlBytes(modulus);
  const first = bytes[0]!;
  return (bytes.length - 1) * 8 + (32 - Math.clz32(first));
}

interface VerifiedJwksDocument {
  readonly keys: readonly JWK[];
}

async function validJwksDocument(
  value: unknown,
): Promise<VerifiedJwksDocument> {
  if (
    !plainRecord(value) ||
    !sameKeys(value, ["keys"]) ||
    !Array.isArray(value.keys)
  ) {
    throw new PlatformTechnicalQuoteJwksUnavailableError();
  }
  if (value.keys.length < 1 || value.keys.length > MAX_JWKS_KEYS) {
    throw new PlatformTechnicalQuoteJwksUnavailableError();
  }
  const seen = new Set<string>();
  const keys: JWK[] = [];
  for (const candidate of value.keys) {
    if (
      !plainRecord(candidate) ||
      Object.keys(candidate).some((name) => PRIVATE_JWK_MEMBERS.has(name)) ||
      !sameKeys(candidate, ["alg", "e", "kid", "kty", "n", "use"]) ||
      candidate.alg !== ALGORITHM ||
      candidate.kty !== "RSA" ||
      candidate.use !== "sig" ||
      typeof candidate.kid !== "string" ||
      !BOUNDED_KEY_ID.test(candidate.kid) ||
      seen.has(candidate.kid) ||
      typeof candidate.n !== "string" ||
      typeof candidate.e !== "string" ||
      jwkBitLength(candidate.n) < 2_048
    ) {
      throw new PlatformTechnicalQuoteJwksUnavailableError();
    }
    seen.add(candidate.kid);
    canonicalBase64urlBytes(candidate.e);
    try {
      const imported = await importJWK(candidate as JWK, ALGORITHM);
      if (imported instanceof Uint8Array || imported.type !== "public") {
        throw new PlatformTechnicalQuoteJwksUnavailableError();
      }
    } catch {
      throw new PlatformTechnicalQuoteJwksUnavailableError();
    }
    keys.push(Object.freeze({ ...candidate }) as JWK);
  }
  return Object.freeze({ keys: Object.freeze(keys) });
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new PlatformTechnicalQuoteJwksUnavailableError();
  }
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim();
  if (
    contentType !== "application/json" &&
    contentType !== "application/jwk-set+json"
  ) {
    await response.body.cancel().catch(() => undefined);
    throw new PlatformTechnicalQuoteJwksUnavailableError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_JWKS_BYTES) {
        throw new PlatformTechnicalQuoteJwksUnavailableError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
    await response.body.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(strictUtf8(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new PlatformTechnicalQuoteJwksUnavailableError();
  }
}

async function loadJwks(
  configuration: PlatformTechnicalQuoteJwksVerifierConfiguration,
  fetcher: typeof fetch,
): Promise<VerifiedJwksDocument> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    JWKS_TIMEOUT_MILLISECONDS,
  );
  timeout.unref();
  try {
    const response = await fetcher(configuration.jwks.href, {
      method: "GET",
      headers: { Accept: "application/jwk-set+json, application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    return await validJwksDocument(await boundedJson(response));
  } catch {
    throw new PlatformTechnicalQuoteJwksUnavailableError();
  } finally {
    clearTimeout(timeout);
  }
}

class CachedPlatformTechnicalQuoteJwks {
  private resolver: CompactVerifyGetKey | null = null;
  private loadedAt = Number.NEGATIVE_INFINITY;
  private refreshInFlight: Promise<CompactVerifyGetKey> | null = null;

  constructor(
    private readonly configuration: PlatformTechnicalQuoteJwksVerifierConfiguration,
    private readonly fetcher: typeof fetch,
    private readonly now: () => Date,
  ) {}

  async ready(): Promise<boolean> {
    try {
      await this.resolve(false);
      return true;
    } catch {
      return false;
    }
  }

  async verify(parsed: ParsedServiceToken): Promise<void> {
    let resolver = await this.resolve(false);
    try {
      await this.verifyWith(parsed, resolver);
      return;
    } catch (error) {
      if (!(error instanceof joseErrors.JWKSNoMatchingKey)) throw error;
    }
    resolver = await this.resolve(true);
    try {
      await this.verifyWith(parsed, resolver);
    } catch (error) {
      if (
        error instanceof joseErrors.JWKSNoMatchingKey ||
        error instanceof joseErrors.JWKSMultipleMatchingKeys ||
        error instanceof joseErrors.JWKSInvalid ||
        error instanceof joseErrors.JWKInvalid
      ) {
        throw new PlatformTechnicalQuoteJwksUnavailableError();
      }
      throw error;
    }
  }

  private async verifyWith(
    parsed: ParsedServiceToken,
    resolver: CompactVerifyGetKey,
  ): Promise<void> {
    const verified = await compactVerify(parsed.compact, resolver, {
      algorithms: [ALGORITHM],
    });
    if (!Buffer.from(verified.payload).equals(parsed.payloadBytes)) {
      throw new PlatformTechnicalQuoteServiceAuthenticationDeniedError();
    }
  }

  private async resolve(force: boolean): Promise<CompactVerifyGetKey> {
    const now = this.now().getTime();
    if (
      !force &&
      this.resolver &&
      now - this.loadedAt < JWKS_CACHE_MILLISECONDS
    ) {
      return this.resolver;
    }
    if (this.refreshInFlight) return this.refreshInFlight;
    const refresh = loadJwks(this.configuration, this.fetcher).then(
      (document) => {
        const resolver = createLocalJWKSet({ keys: [...document.keys] });
        this.resolver = resolver;
        this.loadedAt = this.now().getTime();
        return resolver;
      },
    );
    this.refreshInFlight = refresh;
    try {
      return await refresh;
    } finally {
      this.refreshInFlight = null;
    }
  }
}

function bearerToken(
  request: PlatformTechnicalQuoteServiceAuthenticationRequest,
): string {
  try {
    if (
      request.method !== "POST" ||
      request.normalizedPath !== PLATFORM_TECHNICAL_QUOTE_PATH
    ) {
      throw new Error("wrong request boundary");
    }
    const authorization = request.headers.authorization;
    if (
      typeof authorization !== "string" ||
      authorization !== authorization.trim() ||
      !authorization.startsWith("Bearer ")
    ) {
      throw new Error("invalid authorization header");
    }
    const token = authorization.slice("Bearer ".length);
    if (!token) throw new Error("missing bearer token");
    return token;
  } catch {
    throw new PlatformTechnicalQuoteServiceAuthenticationDeniedError();
  }
}

/** Verifies the fixed service profile without reusing user auth semantics. */
export class JwksPlatformTechnicalQuoteServiceAuthenticationVerifier extends PlatformTechnicalQuoteServiceAuthenticationVerifier {
  private readonly configuration: PlatformTechnicalQuoteJwksVerifierConfiguration | null;
  private readonly keys: CachedPlatformTechnicalQuoteJwks | null;
  private readonly now: () => Date;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    dependencies: PlatformTechnicalQuoteJwksVerifierDependencies = {},
  ) {
    super();
    this.now = dependencies.now ?? (() => new Date());
    let configuration: PlatformTechnicalQuoteJwksVerifierConfiguration | null =
      null;
    try {
      configuration =
        validatePlatformTechnicalQuoteJwksVerifierConfiguration(env);
    } catch {
      // Managed API stays diagnostic while this capability is unavailable.
    }
    this.configuration = configuration;
    this.keys = configuration
      ? new CachedPlatformTechnicalQuoteJwks(
          configuration,
          dependencies.fetcher ?? CAPTURED_FETCH,
          this.now,
        )
      : null;
  }

  async readiness(): Promise<PlatformTechnicalQuoteServiceAuthenticationReadiness> {
    if (!this.keys || !(await this.keys.ready())) {
      return PLATFORM_TECHNICAL_QUOTE_AUTHENTICATION_NOT_READY;
    }
    return READY;
  }

  async verify(
    request: PlatformTechnicalQuoteServiceAuthenticationRequest,
  ): Promise<PlatformTechnicalQuoteServiceIdentity> {
    if (!this.configuration || !this.keys) {
      throw new PlatformTechnicalQuoteServiceAuthenticationUnavailableError();
    }
    const parsed = parseServiceToken(
      bearerToken(request),
      this.configuration.issuer,
      this.now(),
    );
    try {
      await this.keys.verify(parsed);
    } catch (error) {
      if (
        error instanceof PlatformTechnicalQuoteJwksUnavailableError ||
        error instanceof joseErrors.JWKSNoMatchingKey ||
        error instanceof joseErrors.JWKSMultipleMatchingKeys ||
        error instanceof joseErrors.JWKSInvalid ||
        error instanceof joseErrors.JWKInvalid
      ) {
        throw new PlatformTechnicalQuoteServiceAuthenticationUnavailableError();
      }
      if (
        error instanceof PlatformTechnicalQuoteServiceAuthenticationDeniedError
      ) {
        throw error;
      }
      throw new PlatformTechnicalQuoteServiceAuthenticationDeniedError();
    }
    return Object.freeze({
      authenticationMode: "SERVICE_ONLY",
      principalId: PLATFORM_TECHNICAL_QUOTE_READER_PRINCIPAL,
      scopes: Object.freeze([PLATFORM_TECHNICAL_QUOTE_READ_SCOPE] as const),
    });
  }
}
