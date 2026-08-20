import { createHash } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  createRemoteJWKSet,
  compactVerify,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
  type CompactVerifyGetKey,
  type JWTPayload,
} from 'jose';
import type { RuntimeReadinessContributorRegistry } from '../runtime/runtime-readiness-registry';
import { resolveRuntimeMode } from '../runtime/runtime-environment';

export const SITE_BUILD_BUDGET_GRANT_HEADER =
  'X-Site-Build-Budget-Grant' as const;
export const SITE_BUILD_BUDGET_GRANT_SCHEMA =
  'site-builder-budget-grant/v1' as const;
export const SITE_BUILD_BUDGET_GRANT_PURPOSE =
  'site_builder.build_run' as const;
export const SITE_BUILD_BUDGET_GRANT_AUDIENCE =
  'global-backend:site-builder-budget' as const;

const MAX_GRANT_BYTES = 16 * 1024;
const MAX_TTL_SECONDS = 300;
const CLOCK_TOLERANCE_SECONDS = 60;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const ALLOWED_ALGORITHMS = new Set(['RS256', 'ES256', 'EdDSA']);
const MAX_BIGINT = 9_223_372_036_854_775_807n;

export type SiteBuildBudgetGrantOperation = 'refurbish' | 'intake';

export interface SiteBuildBudgetGrantScope {
  workspaceId: string;
  siteId?: string;
  operation: SiteBuildBudgetGrantOperation;
  requestSha256: string;
}

export interface VerifiedSiteBuildBudgetGrant {
  schemaVersion: typeof SITE_BUILD_BUDGET_GRANT_SCHEMA;
  issuer: string;
  audience: string;
  jti: string;
  purpose: typeof SITE_BUILD_BUDGET_GRANT_PURPOSE;
  operation: SiteBuildBudgetGrantOperation;
  workspaceId: string;
  siteId: string | null;
  requestSha256: string;
  currency: 'USD';
  unit: 'microusd';
  capMicrousd: bigint;
  tokenSha256: string;
  issuedAt: Date;
  notBefore: Date;
  expiresAt: Date;
  expiredAtVerification: boolean;
}

export function assertBudgetGrantConsumable(
  grant: VerifiedSiteBuildBudgetGrant,
  now = new Date(),
): void {
  if (
    grant.expiredAtVerification ||
    now.getTime() >
      grant.expiresAt.getTime() + CLOCK_TOLERANCE_SECONDS * 1_000
  ) {
    throw new SiteBuildBudgetGrantError(
      'BUDGET_GRANT_EXPIRED',
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

export function isBudgetGrantExpiredStorageError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes('BUDGET_GRANT_EXPIRED')
  );
}

export type SiteBuildBudgetGrantErrorCode =
  | 'BUDGET_GRANT_REQUIRED'
  | 'BUDGET_GRANT_INVALID'
  | 'BUDGET_GRANT_EXPIRED'
  | 'BUDGET_GRANT_SCOPE_MISMATCH'
  | 'BUDGET_GRANT_VERIFICATION_UNAVAILABLE';

export class SiteBuildBudgetGrantError extends HttpException {
  constructor(
    public readonly code: SiteBuildBudgetGrantErrorCode,
    status: number,
  ) {
    super(
      {
        error: {
          code,
          message:
            code === 'BUDGET_GRANT_VERIFICATION_UNAVAILABLE'
              ? 'budget grant verification is temporarily unavailable'
              : code === 'BUDGET_GRANT_SCOPE_MISMATCH'
                ? 'budget grant does not authorize this build request'
                : code === 'BUDGET_GRANT_REQUIRED'
                  ? 'a site build budget grant is required'
                  : code === 'BUDGET_GRANT_EXPIRED'
                    ? 'budget grant is expired or not active'
                    : 'budget grant verification failed',
        },
      },
      status,
    );
    this.name = 'SiteBuildBudgetGrantError';
  }
}

interface VerifierDeps {
  keyResolver?: JWTVerifyGetKey;
  now?: () => Date;
  fetcher?: (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'body'>>;
}

function requiredCanonical(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value !== value.trim() || value.length > 512) {
    throw new Error(`${name} is required and must be canonical`);
  }
  return value;
}

function requiredTrustedUrl(
  env: NodeJS.ProcessEnv,
  name: string,
  mode: ReturnType<typeof resolveRuntimeMode>,
): string {
  const value = requiredCanonical(env, name);
  const parsed = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(
    parsed.hostname.toLowerCase(),
  );
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== 'https:' &&
      !(
        (mode === 'development' || mode === 'test') &&
        parsed.protocol === 'http:' &&
        loopback
      ))
  ) {
    throw new Error(`${name} must use the trusted HTTPS/loopback URL policy`);
  }
  return value;
}

function numericDate(payload: JWTPayload, name: 'iat' | 'nbf' | 'exp'): number {
  const value = payload[name];
  if (!Number.isSafeInteger(value) || value! < 0) throw new Error(`invalid ${name}`);
  return value!;
}

/**
 * Verifies the SaaS-issued, request-bound spending authority. The raw compact
 * JWS is intentionally reduced to a digest before it crosses this boundary.
 */
@Injectable()
export class SiteBuildBudgetGrantVerifier implements OnModuleDestroy {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly algorithms: string[];
  private readonly keyResolver: JWTVerifyGetKey | null;
  private readonly jwksUri: string | null;
  private readonly probeRemoteJwks: boolean;
  private readonly fetcher: (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'body'>>;
  private readonly now: () => Date;
  private readonly available: boolean;
  private readonly unregisterReadiness?: () => void;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    deps: VerifierDeps = {},
    readinessRegistry?: RuntimeReadinessContributorRegistry,
  ) {
    let issuer = '';
    let audience = '';
    let algorithms: string[] = [];
    let keyResolver: JWTVerifyGetKey | null = null;
    let jwksUri: string | null = null;
    let probeRemoteJwks = false;
    let available = false;
    try {
      const mode = resolveRuntimeMode(env);
      const resolvedJwksUri = requiredTrustedUrl(
        env,
        'SITE_BUILD_BUDGET_GRANT_JWKS_URI',
        mode,
      );
      issuer = requiredTrustedUrl(
        env,
        'SITE_BUILD_BUDGET_GRANT_ISSUER',
        mode,
      );
      const configuredAudience = requiredCanonical(
        env,
        'SITE_BUILD_BUDGET_GRANT_AUDIENCE',
      );
      if (configuredAudience !== SITE_BUILD_BUDGET_GRANT_AUDIENCE) {
        throw new Error(
          'SITE_BUILD_BUDGET_GRANT_AUDIENCE must use the product audience',
        );
      }
      audience = SITE_BUILD_BUDGET_GRANT_AUDIENCE;
      algorithms = requiredCanonical(
        env,
        'SITE_BUILD_BUDGET_GRANT_ALGORITHMS',
      )
        .split(',')
        .map((value) => value.trim());
      if (
        algorithms.length === 0 ||
        new Set(algorithms).size !== algorithms.length ||
        algorithms.some((algorithm) => !ALLOWED_ALGORITHMS.has(algorithm))
      ) {
        throw new Error(
          'SITE_BUILD_BUDGET_GRANT_ALGORITHMS must be a unique asymmetric allowlist',
        );
      }
      keyResolver = deps.keyResolver ?? createRemoteJWKSet(new URL(resolvedJwksUri));
      jwksUri = resolvedJwksUri;
      probeRemoteJwks = !deps.keyResolver;
      available = true;
    } catch {
      // Managed runtimes remain diagnostic but not ready. Request handling below
      // returns a stable 503 without exposing which trust setting is absent.
    }
    this.issuer = issuer;
    this.audience = audience;
    this.algorithms = algorithms;
    this.keyResolver = keyResolver;
    this.jwksUri = jwksUri;
    this.probeRemoteJwks = probeRemoteJwks;
    this.fetcher = deps.fetcher ?? fetch;
    this.available = available;
    this.now = deps.now ?? (() => new Date());
    this.unregisterReadiness = readinessRegistry?.register(
      'budget_grant_verification',
      () => this.readiness(),
    );
  }

  onModuleDestroy(): void {
    this.unregisterReadiness?.();
  }

  private async readiness(): Promise<
    Readonly<{ status: 'ok' }> | Readonly<{ status: 'failed'; code: 'BUDGET_GRANT_VERIFICATION_UNAVAILABLE' }>
  > {
    if (!this.available || !this.keyResolver) {
      return { status: 'failed', code: 'BUDGET_GRANT_VERIFICATION_UNAVAILABLE' };
    }
    if (!this.probeRemoteJwks || !this.jwksUri) return { status: 'ok' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    timeout.unref();
    try {
      const response = await this.fetcher(this.jwksUri, {
        method: 'GET',
        headers: { Accept: 'application/json, application/jwk-set+json' },
        redirect: 'error',
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => undefined);
      return response.ok
        ? { status: 'ok' }
        : { status: 'failed', code: 'BUDGET_GRANT_VERIFICATION_UNAVAILABLE' };
    } catch {
      return { status: 'failed', code: 'BUDGET_GRANT_VERIFICATION_UNAVAILABLE' };
    } finally {
      clearTimeout(timeout);
    }
  }

  async verify(
    rawToken: string | undefined,
    scope: SiteBuildBudgetGrantScope,
  ): Promise<VerifiedSiteBuildBudgetGrant> {
    if (!this.available || !this.keyResolver) {
      throw new SiteBuildBudgetGrantError(
        'BUDGET_GRANT_VERIFICATION_UNAVAILABLE',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!rawToken) {
      throw new SiteBuildBudgetGrantError(
        'BUDGET_GRANT_REQUIRED',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    if (
      rawToken !== rawToken.trim() ||
      Buffer.byteLength(rawToken, 'utf8') > MAX_GRANT_BYTES
    ) {
      throw this.invalid();
    }

    let payload: JWTPayload;
    let expiredAtVerification = false;
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(rawToken);
    } catch {
      throw this.invalid();
    }
    if (
      header.typ !== 'site-build-budget-grant+jwt' ||
      typeof header.kid !== 'string' ||
      header.kid.length < 1 ||
      header.kid.length > 191 ||
      typeof header.alg !== 'string' ||
      !this.algorithms.includes(header.alg)
    ) {
      throw this.invalid();
    }
    try {
      ({ payload } = await jwtVerify(rawToken, this.keyResolver, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: this.algorithms,
        typ: 'site-build-budget-grant+jwt',
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: this.now(),
      }));
    } catch (error) {
      if (error instanceof SiteBuildBudgetGrantError) throw error;
      if (error instanceof joseErrors.JWTExpired) {
        try {
          const verified = await compactVerify(
            rawToken,
            this.keyResolver as unknown as CompactVerifyGetKey,
          );
          payload = JSON.parse(
            new TextDecoder().decode(verified.payload),
          ) as JWTPayload;
          if (
            payload.iss !== this.issuer ||
            payload.aud !== this.audience
          ) {
            throw this.invalid();
          }
          expiredAtVerification = true;
        } catch (expiredVerificationError) {
          if (expiredVerificationError instanceof SiteBuildBudgetGrantError) {
            throw expiredVerificationError;
          }
          throw this.classifyVerificationFailure(expiredVerificationError);
        }
      } else if (
        error instanceof joseErrors.JWTClaimValidationFailed &&
        error.claim === 'nbf'
      ) {
        throw new SiteBuildBudgetGrantError(
          'BUDGET_GRANT_EXPIRED',
          HttpStatus.PAYMENT_REQUIRED,
        );
      } else {
        throw this.classifyVerificationFailure(error);
      }
    }

    try {
      if (payload.aud !== SITE_BUILD_BUDGET_GRANT_AUDIENCE) {
        throw new Error('invalid grant audience shape');
      }
      const iat = numericDate(payload, 'iat');
      const nbf = numericDate(payload, 'nbf');
      const exp = numericDate(payload, 'exp');
      if (iat > nbf || nbf > exp || exp - iat > MAX_TTL_SECONDS) {
        throw new Error('invalid grant lifetime');
      }
      const jti = payload.jti;
      const schemaVersion = payload.schema_version;
      const purpose = payload.purpose;
      const operation = payload.operation;
      const workspaceId = payload.workspace_id;
      const siteId = payload.site_id;
      const requestSha256 = payload.request_sha256;
      const currency = payload.currency;
      const unit = payload.unit;
      const cap = payload.cap_microusd;
      if (
        typeof jti !== 'string' ||
        !UUID.test(jti) ||
        schemaVersion !== SITE_BUILD_BUDGET_GRANT_SCHEMA ||
        purpose !== SITE_BUILD_BUDGET_GRANT_PURPOSE ||
        (operation !== 'refurbish' && operation !== 'intake') ||
        typeof workspaceId !== 'string' ||
        !UUID.test(workspaceId) ||
        typeof requestSha256 !== 'string' ||
        !SHA256.test(requestSha256) ||
        currency !== 'USD' ||
        unit !== 'microusd' ||
        typeof cap !== 'string' ||
        !POSITIVE_DECIMAL.test(cap)
      ) {
        throw new Error('invalid grant claims');
      }
      const capMicrousd = BigInt(cap);
      if (capMicrousd > MAX_BIGINT) throw new Error('grant cap overflow');
      const normalizedSiteId =
        typeof siteId === 'string' && UUID.test(siteId) ? siteId : null;
      if (
        (operation === 'refurbish' && !normalizedSiteId) ||
        (operation === 'intake' && siteId !== undefined)
      ) {
        throw new Error('invalid site binding');
      }
      if (
        operation !== scope.operation ||
        workspaceId !== scope.workspaceId ||
        normalizedSiteId !== (scope.siteId ?? null) ||
        requestSha256 !== scope.requestSha256
      ) {
        throw new SiteBuildBudgetGrantError(
          'BUDGET_GRANT_SCOPE_MISMATCH',
          HttpStatus.FORBIDDEN,
        );
      }
      return {
        schemaVersion,
        issuer: this.issuer,
        audience: this.audience,
        jti,
        purpose,
        operation,
        workspaceId,
        siteId: normalizedSiteId,
        requestSha256,
        currency,
        unit,
        capMicrousd,
        tokenSha256: createHash('sha256').update(rawToken).digest('hex'),
        issuedAt: new Date(iat * 1_000),
        notBefore: new Date(nbf * 1_000),
        expiresAt: new Date(exp * 1_000),
        expiredAtVerification,
      };
    } catch (error) {
      if (error instanceof SiteBuildBudgetGrantError) throw error;
      throw this.invalid();
    }
  }

  private invalid(): SiteBuildBudgetGrantError {
    return new SiteBuildBudgetGrantError(
      'BUDGET_GRANT_INVALID',
      HttpStatus.PAYMENT_REQUIRED,
    );
  }

  private classifyVerificationFailure(error: unknown): SiteBuildBudgetGrantError {
    if (
      error instanceof joseErrors.JWKSTimeout ||
      error instanceof joseErrors.JWKSNoMatchingKey ||
      error instanceof joseErrors.JWKSMultipleMatchingKeys ||
      error instanceof joseErrors.JWKSInvalid ||
      error instanceof joseErrors.JWKInvalid ||
      error instanceof TypeError
    ) {
      return new SiteBuildBudgetGrantError(
        'BUDGET_GRANT_VERIFICATION_UNAVAILABLE',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.invalid();
  }
}
