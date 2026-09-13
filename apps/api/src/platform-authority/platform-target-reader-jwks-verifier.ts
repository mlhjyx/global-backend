import { compactVerify, createLocalJWKSet, errors as joseErrors } from "jose";
import { createHash, createPublicKey } from "node:crypto";
import {
  PlatformAuthorityTargetReaderClaimsSchema,
  PlatformAuthorityTargetLookupRequestSchema,
  PLATFORM_AUTHORITY_TARGET_READER_TYPE,
  PLATFORM_AUTHORITY_TARGET_READER_SCOPE,
} from "@global/contracts/platform-authority/target-lookup";
import { createStrictJwtPrimitives } from "./strict-jwt-primitives";

export class PlatformTargetReaderDeniedError extends Error {
  constructor() {
    super("PLATFORM_TARGET_READER_DENIED");
  }
}
export class PlatformTargetReaderUnavailableError extends Error {
  constructor() {
    super("PLATFORM_TARGET_READER_UNAVAILABLE");
  }
}
const {
  canonicalBase64urlBytes,
  strictUtf8,
  ClosedJwtObjectParser,
  validJwksDocument,
} = createStrictJwtPrimitives(
  PlatformTargetReaderDeniedError,
  PlatformTargetReaderUnavailableError,
);
const CAPTURED_FETCH = fetch;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CLAIM_KEYS = ["iss", "aud", "sub", "scope", "jti", "iat", "nbf", "exp"];
interface Configuration {
  readonly jwks: string;
  readonly issuer: string;
  readonly subject: string;
  readonly targetIssuer: string;
}
export interface VerifiedPlatformTargetReaderIdentity {
  readonly authenticationMode: "SERVICE_ONLY";
  readonly issuer: string;
  readonly subject: string;
  readonly targetIssuer: string;
  readonly scope: typeof PLATFORM_AUTHORITY_TARGET_READER_SCOPE;
}

function configuration(env: NodeJS.ProcessEnv): Configuration {
  try {
    const required = (name: string, maximum: number) => {
      const value = env[name];
      if (
        !value ||
        value !== value.trim() ||
        Buffer.byteLength(value, "utf8") > maximum
      )
        throw new Error();
      return value;
    };
    const jwks = required("PLATFORM_AUTHORITY_TARGET_READER_JWKS_URI", 2048);
    const url = new URL(jwks);
    if (
      url.protocol !== "https:" ||
      url.href !== jwks ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    const issuerSchema =
      PlatformAuthorityTargetLookupRequestSchema.shape.target_issuer;
    return Object.freeze({
      jwks,
      issuer: issuerSchema.parse(
        required("PLATFORM_AUTHORITY_TARGET_READER_ISSUER", 2048),
      ),
      subject: required("PLATFORM_AUTHORITY_TARGET_READER_SUBJECT", 16384),
      targetIssuer: issuerSchema.parse(
        required("PLATFORM_AUTHORITY_TARGET_READER_TARGET_ISSUER", 2048),
      ),
    });
  } catch {
    throw new PlatformTargetReaderUnavailableError();
  }
}

/** Dedicated verifier only. Caller supplies a same-process performance.now()
 * deadline for the whole lookup and MUST retain that deadline for database work.
 * No cache, identity mint, HTTP route or database authorization side effect. */
export class PlatformTargetReaderJwksVerifier {
  private readonly config: Configuration | null;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  constructor(
    env: NodeJS.ProcessEnv = process.env,
    dependencies: {
      fetcher?: typeof fetch;
      now?: () => Date;
      monotonicNow?: () => number;
    } = {},
  ) {
    let configured: Configuration | null = null;
    try {
      configured = configuration(env);
    } catch {
      /* Missing trust stays diagnostic, never a fallback identity. */
    }
    this.config = configured;
    this.fetcher = dependencies.fetcher ?? CAPTURED_FETCH;
    this.now = dependencies.now ?? (() => new Date());
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  }
  /** Public trust capability only: no token mint, authentication probe or raw key output. */
  async readiness(deadlineAtMs: number): Promise<boolean> {
    try {
      return await this.withDeadline(deadlineAtMs, async (remaining, abort) => {
        if (!this.config) throw new PlatformTargetReaderUnavailableError();
        await this.loadKeys(this.config, remaining, abort);
        return true;
      });
    } catch {
      return false;
    }
  }

  async verify(
    compact: string,
    deadlineAtMs: number,
  ): Promise<VerifiedPlatformTargetReaderIdentity> {
    let finalClaimsCheck!: () => void;
    return this.withDeadline(
      deadlineAtMs,
      async (remaining, abort) => {
        const config = this.config;
        if (!config) throw new PlatformTargetReaderUnavailableError();
        let payloadBytes: Buffer;
        let claims: ReturnType<
          typeof PlatformAuthorityTargetReaderClaimsSchema.parse
        >;
        const liveClaims = () => {
          const now = Math.floor(this.now().getTime() / 1000);
          if (
            !Number.isSafeInteger(now) ||
            now < 0 ||
            claims.iat > now + 60 ||
            claims.nbf > now + 60 ||
            now >= claims.exp
          )
            throw new PlatformTargetReaderDeniedError();
        };
        finalClaimsCheck = liveClaims;
        try {
          if (
            typeof compact !== "string" ||
            compact !== compact.trim() ||
            Buffer.byteLength(compact, "utf8") > 16384
          )
            throw new PlatformTargetReaderDeniedError();
          const segments = compact.split(".");
          if (segments.length !== 3)
            throw new PlatformTargetReaderDeniedError();
          const header = new ClosedJwtObjectParser(
            strictUtf8(canonicalBase64urlBytes(segments[0]!)),
          ).parse(["alg", "kid", "typ"]);
          payloadBytes = canonicalBase64urlBytes(segments[1]!);
          canonicalBase64urlBytes(segments[2]!);
          if (
            header.alg !== "RS256" ||
            header.typ !== PLATFORM_AUTHORITY_TARGET_READER_TYPE ||
            typeof header.kid !== "string" ||
            !KEY_ID.test(header.kid)
          )
            throw new PlatformTargetReaderDeniedError();
          claims = PlatformAuthorityTargetReaderClaimsSchema.parse(
            new ClosedJwtObjectParser(strictUtf8(payloadBytes)).parse(
              CLAIM_KEYS,
            ),
          );
          if (claims.iss !== config.issuer || claims.sub !== config.subject)
            throw new PlatformTargetReaderDeniedError();
          liveClaims();
        } catch {
          throw new PlatformTargetReaderDeniedError();
        }

        const document = await this.loadKeys(config, remaining, abort);
        remaining();
        try {
          const verified = await compactVerify(
            compact,
            createLocalJWKSet({ keys: [...document.keys] }),
            { algorithms: ["RS256"] },
          );
          if (!Buffer.from(verified.payload).equals(payloadBytes))
            throw new PlatformTargetReaderDeniedError();
        } catch (error) {
          if (error instanceof joseErrors.JWKSNoMatchingKey)
            throw new PlatformTargetReaderUnavailableError();
          throw new PlatformTargetReaderDeniedError();
        }

        remaining();
        liveClaims();
        return Object.freeze({
          authenticationMode: "SERVICE_ONLY",
          issuer: config.issuer,
          subject: config.subject,
          targetIssuer: config.targetIssuer,
          scope: PLATFORM_AUTHORITY_TARGET_READER_SCOPE,
        });
      },
      () => finalClaimsCheck(),
    );
  }

  private async loadKeys(
    config: Configuration,
    remaining: () => number,
    abort: AbortController,
  ) {
    let document;
    try {
      remaining();
      const response = await this.fetcher(config.jwks, {
        method: "GET",
        headers: { Accept: "application/jwk-set+json, application/json" },
        redirect: "error",
        signal: abort.signal,
      });
      try {
        remaining();
      } catch (error) {
        void response.body?.cancel().catch(() => undefined);
        throw error;
      }
      if (
        response.redirected ||
        response.status !== 200 ||
        !response.body ||
        !["application/json", "application/jwk-set+json"].includes(
          response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "",
        )
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw new PlatformTargetReaderUnavailableError();
      }
      const reader = response.body.getReader();
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      abort.signal.addEventListener("abort", cancel, { once: true });
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          remaining();
          if (chunk.done) break;
          length += chunk.value.byteLength;
          if (length > 65536) throw new PlatformTargetReaderUnavailableError();
          chunks.push(chunk.value);
        }
        document = await validJwksDocument(
          new ClosedJwtObjectParser(
            strictUtf8(Buffer.concat(chunks)),
          ).parseJwks(),
        );
        const material = new Set<string>();
        for (const key of document.keys) {
          // Compare normalized RSA material, not caller-controlled integer encodings.
          const fingerprint = createHash("sha256")
            .update(
              createPublicKey({
                key: { kty: "RSA", n: key.n!, e: key.e! },
                format: "jwk",
              }).export({
                format: "der",
                type: "spki",
              }),
            )
            .digest("hex");
          if (material.has(fingerprint))
            throw new PlatformTargetReaderUnavailableError();
          material.add(fingerprint);
        }
      } finally {
        abort.signal.removeEventListener("abort", cancel);
        cancel();
        reader.releaseLock();
      }
    } catch {
      throw new PlatformTargetReaderUnavailableError();
    }

    remaining();
    return document;
  }

  private async withDeadline<T>(
    deadlineAtMs: number,
    operation: (remaining: () => number, abort: AbortController) => Promise<T>,
    finalCheck?: () => void,
  ): Promise<T> {
    let completed = false;
    const remaining = () => {
      const budget = deadlineAtMs - this.monotonicNow();
      if (completed || !Number.isFinite(budget) || budget <= 0 || budget > 2000)
        throw new PlatformTargetReaderUnavailableError();
      return budget;
    };
    remaining();
    const abort = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        completed = true;
        abort.abort();
        reject(new PlatformTargetReaderUnavailableError());
      }, remaining());
    });
    try {
      const result = await Promise.race([operation(remaining, abort), expired]);
      remaining();
      finalCheck?.();
      return result;
    } finally {
      completed = true;
      clearTimeout(timeout);
      abort.abort();
    }
  }
}
