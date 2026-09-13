import {
  PlatformTargetReaderDeniedError,
  type PlatformTargetReaderJwksVerifier,
  type VerifiedPlatformTargetReaderIdentity,
} from "./platform-target-reader-jwks-verifier";
import type { PlatformTargetLookupRepository } from "./platform-target-lookup.repository";
import type { PlatformTargetLookupRateLimiter } from "./platform-target-lookup-rate-limit";
import {
  PlatformAuthorityTargetLookupRequestSchema,
  PlatformAuthorityTargetObservationSchema,
  PLATFORM_AUTHORITY_TARGET_OBSERVATION_VERSION,
  PLATFORM_AUTHORITY_TARGET_READER_SCOPE,
  type PlatformAuthorityTargetObservation,
  type PlatformAuthorityTargetLookupRequest,
} from "@global/contracts/platform-authority/target-lookup";
import { types } from "node:util";
import { createStrictJwtPrimitives } from "./strict-jwt-primitives";

export const PLATFORM_AUTHORITY_TARGET_LOOKUP_PATH =
  "/api/v1/platform-authority/target-lookup" as const;
export class PlatformTargetLookupInvalidError extends Error {
  constructor() {
    super("PLATFORM_AUTHORITY_TARGET_LOOKUP_INVALID");
  }
}
export class PlatformTargetLookupNotFoundError extends Error {
  constructor() {
    super("PLATFORM_AUTHORITY_TARGET_LOOKUP_NOT_FOUND");
  }
}
export class PlatformTargetLookupRateLimitedError extends Error {
  constructor() {
    super("PLATFORM_AUTHORITY_TARGET_LOOKUP_RATE_LIMITED");
  }
}
export class PlatformTargetLookupScopeMismatchError extends Error {
  constructor() {
    super("PLATFORM_AUTHORITY_TARGET_LOOKUP_SCOPE_MISMATCH");
  }
}
export class PlatformTargetLookupUnavailableError extends Error {
  constructor() {
    super("PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE");
  }
}
export interface PlatformTargetLookupInput {
  readonly method: string;
  readonly originalUrl: string;
  readonly rawHeaders: readonly string[];
  readonly rawBody: Buffer;
}
export interface PlatformTargetLookupDependencies {
  readonly verifier: Pick<PlatformTargetReaderJwksVerifier, "verify">;
  readonly repository: Pick<PlatformTargetLookupRepository, "lookup">;
  readonly limiter: PlatformTargetLookupRateLimiter;
  readonly admitted: () => boolean;
  readonly monotonicNow?: () => number;
  readonly now?: () => Date;
}

const { strictUtf8, ClosedJwtObjectParser } = createStrictJwtPrimitives(
  PlatformTargetLookupInvalidError,
  PlatformTargetLookupUnavailableError,
);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const REQUEST_KEYS = [
  "target_issuer",
  "target_jti",
  "schedule_id",
  "workflow_run_id",
  "nonce",
];

function parse(input: PlatformTargetLookupInput): {
  token: string;
  request: PlatformAuthorityTargetLookupRequest;
} {
  try {
    if (
      input.method !== "POST" ||
      input.originalUrl !== PLATFORM_AUTHORITY_TARGET_LOOKUP_PATH ||
      !Buffer.isBuffer(input.rawBody) ||
      input.rawBody.length < 1 ||
      input.rawBody.length > 4096 ||
      !Array.isArray(input.rawHeaders) ||
      types.isProxy(input.rawHeaders) ||
      input.rawHeaders.length % 2 !== 0 ||
      input.rawHeaders.length > 128
    )
      throw new PlatformTargetLookupInvalidError();
    const headers = new Map<string, string>();
    let bytes = 0;
    for (let index = 0; index < input.rawHeaders.length; index += 2) {
      const name = input.rawHeaders[index];
      const value = input.rawHeaders[index + 1];
      if (
        typeof name !== "string" ||
        typeof value !== "string" ||
        name.length > 32768 ||
        value.length > 32768 ||
        !HEADER_NAME.test(name) ||
        [...value].some(
          (character) =>
            (character.charCodeAt(0) < 32 && character !== "\t") ||
            character.charCodeAt(0) === 127,
        )
      )
        throw new PlatformTargetLookupInvalidError();
      const normalized = name.toLowerCase();
      bytes +=
        Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4;
      if (bytes > 32768 || headers.has(normalized))
        throw new PlatformTargetLookupInvalidError();
      headers.set(normalized, value);
    }
    const contentType = headers.get("content-type")?.trim() ?? "";
    const contentEncoding = headers.get("content-encoding");
    const contentLength = headers.get("content-length");
    if (
      headers.has("cookie") ||
      headers.has("cookie2") ||
      headers.has("transfer-encoding") ||
      (contentEncoding !== undefined &&
        contentEncoding.trim().toLowerCase() !== "identity") ||
      !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(
        contentType,
      ) ||
      (contentLength !== undefined &&
        (!/^(0|[1-9][0-9]*)$/.test(contentLength) ||
          Number(contentLength) !== input.rawBody.length))
    )
      throw new PlatformTargetLookupInvalidError();
    const request = Object.freeze(
      PlatformAuthorityTargetLookupRequestSchema.parse(
        new ClosedJwtObjectParser(strictUtf8(input.rawBody)).parse(
          REQUEST_KEYS,
        ),
      ),
    );
    const authorization = headers.get("authorization");
    const bearer = authorization?.match(
      /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i,
    );
    if (!bearer || Buffer.byteLength(bearer[1]!, "utf8") > 16384)
      throw new PlatformTargetReaderDeniedError();
    return { token: bearer[1]!, request };
  } catch (error) {
    if (error instanceof PlatformTargetReaderDeniedError) throw error;
    throw new PlatformTargetLookupInvalidError();
  }
}

function serviceIdentity(value: unknown): VerifiedPlatformTargetReaderIdentity {
  if (value === null || typeof value !== "object" || types.isProxy(value))
    throw new PlatformTargetLookupUnavailableError();
  const field = (name: string): unknown =>
    Object.getOwnPropertyDescriptor(value, name)?.value;
  const issuer = field("issuer");
  const subject = field("subject");
  const targetIssuer = field("targetIssuer");
  if (
    field("authenticationMode") !== "SERVICE_ONLY" ||
    field("scope") !== PLATFORM_AUTHORITY_TARGET_READER_SCOPE ||
    typeof issuer !== "string" ||
    !issuer ||
    typeof subject !== "string" ||
    !subject ||
    typeof targetIssuer !== "string" ||
    !targetIssuer
  )
    throw new PlatformTargetLookupUnavailableError();
  return Object.freeze({
    authenticationMode: "SERVICE_ONLY",
    scope: PLATFORM_AUTHORITY_TARGET_READER_SCOPE,
    issuer,
    subject,
    targetIssuer,
  });
}

/** Independent control-plane admission, not aggregate business Worker readiness.
 * The controller owns no-store/error HTTP mapping; this core never emits raw tokens. */
export class PlatformTargetLookupService {
  private readonly monotonicNow: () => number;
  private readonly now: () => Date;
  constructor(private readonly dependencies: PlatformTargetLookupDependencies) {
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    this.now = dependencies.now ?? (() => new Date());
  }
  async read(
    input: PlatformTargetLookupInput,
  ): Promise<PlatformAuthorityTargetObservation> {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const startedAt = this.monotonicNow();
      const deadline = startedAt + 2000;
      const remaining = () => {
        const budget = deadline - this.monotonicNow();
        if (
          finished ||
          !Number.isFinite(startedAt) ||
          !Number.isFinite(budget) ||
          budget <= 0 ||
          budget > 2000 ||
          this.dependencies.admitted() !== true
        )
          throw new PlatformTargetLookupUnavailableError();
        return budget;
      };
      remaining();
      const { token, request } = parse(input);
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          finished = true;
          reject(new PlatformTargetLookupUnavailableError());
        }, remaining());
      });
      const operation =
        async (): Promise<PlatformAuthorityTargetObservation> => {
          remaining();
          const verified = await this.dependencies.verifier.verify(
            token,
            deadline,
          );
          remaining();
          const identity = serviceIdentity(verified);
          if (request.target_issuer !== identity.targetIssuer)
            throw new PlatformTargetLookupScopeMismatchError();
          const allowed = await this.dependencies.limiter.allow(
            Object.freeze({
              issuer: identity.issuer,
              subject: identity.subject,
            }),
            deadline,
          );
          remaining();
          if (allowed === false)
            throw new PlatformTargetLookupRateLimitedError();
          if (allowed !== true)
            throw new PlatformTargetLookupUnavailableError();
          const found = await this.dependencies.repository.lookup(
            request,
            deadline,
          );
          remaining();
          if (found === false) throw new PlatformTargetLookupNotFoundError();
          if (found !== true) throw new PlatformTargetLookupUnavailableError();
          const observation = PlatformAuthorityTargetObservationSchema.parse({
            schema_version: PLATFORM_AUTHORITY_TARGET_OBSERVATION_VERSION,
            ...request,
            found: true,
            observed_at: Math.floor(this.now().getTime() / 1000),
          });
          if (Buffer.byteLength(JSON.stringify(observation), "utf8") > 4096)
            throw new PlatformTargetLookupUnavailableError();
          remaining();
          return Object.freeze(observation);
        };
      const result = await Promise.race([operation(), timeout]);
      remaining();
      return result;
    } catch (error) {
      if (
        error instanceof PlatformTargetLookupInvalidError ||
        error instanceof PlatformTargetLookupScopeMismatchError ||
        error instanceof PlatformTargetLookupNotFoundError ||
        error instanceof PlatformTargetLookupRateLimitedError ||
        error instanceof PlatformTargetReaderDeniedError
      )
        throw error;
      throw new PlatformTargetLookupUnavailableError();
    } finally {
      finished = true;
      clearTimeout(timer);
    }
  }
}
