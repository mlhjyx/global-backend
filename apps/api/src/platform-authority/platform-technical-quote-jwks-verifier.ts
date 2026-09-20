import {
  createStrictJwtPrimitives,
  type VerifiedJwksDocument,
} from "./strict-jwt-primitives";
import { compactVerify, createLocalJWKSet, errors as joseErrors } from "jose";
import type { CompactVerifyGetKey } from "jose";

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
const MAX_TOKEN_TTL_SECONDS = 300;
const JWKS_CACHE_MILLISECONDS = 5 * 60 * 1_000;
const JWKS_TIMEOUT_MILLISECONDS = 2_000;
const BOUNDED_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
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

const {
  canonicalBase64urlBytes,
  strictUtf8,
  ClosedJwtObjectParser,
  validJwksDocument,
} = createStrictJwtPrimitives(
  PlatformTechnicalQuoteServiceAuthenticationDeniedError,
  PlatformTechnicalQuoteJwksUnavailableError,
);

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
