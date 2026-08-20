import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  errors as joseErrors,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';
import { resolveRuntimeMode } from '../runtime/runtime-environment';
import {
  assertAuthorityPurposeShape,
  assertCanonicalMicrousd,
  ExecutionBudgetGrantError,
  type ExecutionBudgetPurpose,
  type VerifiedExecutionBudgetAuthority,
} from './execution-budget-authority.types';

export const EXECUTION_BUDGET_GRANT_AUDIENCE =
  'global-backend:execution-budget' as const;

const EXECUTION_BUDGET_GRANT_SCHEMA = 'execution-budget-grant/v1' as const;
const EXECUTION_BUDGET_GRANT_TYPE = 'execution-budget-grant+jwt' as const;
const MAX_GRANT_BYTES = 16 * 1024;
const MAX_JWKS_BYTES = 64 * 1024;
const MAX_JWKS_KEYS = 64;
const JWKS_TIMEOUT_MS = 2_000;
const MAX_TTL_SECONDS = 300;
const CLOCK_TOLERANCE_SECONDS = 60;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const BOUNDED_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,190}$/;
const FIXED_ALGORITHMS = new Set(['RS256', 'ES256', 'EdDSA']);
const PURPOSES = new Set<ExecutionBudgetPurpose>([
  'icp.design',
  'icp.query_plan',
  'understanding.run',
  'discovery.run',
  'contact.verify',
  'platform.acquisition',
  'platform.intent_watch',
  'platform.sanctions',
]);

type WorkspaceExpectedScope = Readonly<
  Pick<
    VerifiedExecutionBudgetAuthority,
    | 'authorityKind'
    | 'purpose'
    | 'workspaceId'
    | 'subjectType'
    | 'subjectId'
    | 'requestSha256'
  > & {
    authorityKind: 'WORKSPACE_GRANT';
    workspaceId: string;
    requestSha256: string;
  }
>;

type PlatformExpectedScope = Readonly<
  Pick<
    VerifiedExecutionBudgetAuthority,
    'authorityKind' | 'purpose' | 'subjectType' | 'subjectId' | 'scheduleId'
  > & {
    authorityKind: 'PLATFORM_GRANT';
    scheduleId: string;
  }
>;

export type ExecutionBudgetGrantExpectedScope =
  | WorkspaceExpectedScope
  | PlatformExpectedScope;

export interface ExecutionBudgetGrantVerifierConfiguration {
  readonly jwks: URL;
  readonly issuer: string;
  readonly audience: typeof EXECUTION_BUDGET_GRANT_AUDIENCE;
  readonly algorithms: readonly string[];
}

export type ExecutionBudgetJwksFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

interface ExecutionBudgetJwksDocument {
  readonly keys: readonly JWK[];
}

interface VerifierDependencies {
  readonly keyResolver?: JWTVerifyGetKey;
  readonly fetcher?: ExecutionBudgetJwksFetch;
  readonly now?: () => Date;
}

class ExecutionBudgetJwksUnavailableError extends Error {
  constructor() {
    super('EXECUTION_BUDGET_JWKS_UNAVAILABLE');
    this.name = 'ExecutionBudgetJwksUnavailableError';
  }
}

function invalid(): ExecutionBudgetGrantError {
  return new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_INVALID');
}

function unavailable(): ExecutionBudgetGrantError {
  return new ExecutionBudgetGrantError(
    'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
  );
}

function requiredCanonical(
  env: NodeJS.ProcessEnv,
  name: string,
  maxLength = 512,
): string {
  const value = env[name];
  if (
    !value ||
    value !== value.trim() ||
    value.length > maxLength
  ) {
    throw new Error('EXECUTION_BUDGET_VERIFIER_CONFIG_INVALID');
  }
  return value;
}

function trustedUrl(
  env: NodeJS.ProcessEnv,
  name: string,
  mode: ReturnType<typeof resolveRuntimeMode>,
): URL {
  const value = requiredCanonical(env, name);
  const parsed = new URL(value);
  const loopback = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']).has(
    parsed.hostname.toLowerCase(),
  );
  const developmentTrustRoot =
    (mode === 'development' || mode === 'test') &&
    parsed.protocol === 'http:' &&
    loopback;
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== 'https:' && !developmentTrustRoot)
  ) {
    throw new Error('EXECUTION_BUDGET_VERIFIER_CONFIG_INVALID');
  }
  return parsed;
}

export function validateExecutionBudgetGrantVerifierConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): ExecutionBudgetGrantVerifierConfiguration {
  const mode = resolveRuntimeMode(env);
  const jwks = trustedUrl(env, 'EXECUTION_BUDGET_GRANT_JWKS_URI', mode);
  const issuer = trustedUrl(
    env,
    'EXECUTION_BUDGET_GRANT_ISSUER',
    mode,
  ).href;
  if (
    requiredCanonical(env, 'EXECUTION_BUDGET_GRANT_AUDIENCE', 256) !==
    EXECUTION_BUDGET_GRANT_AUDIENCE
  ) {
    throw new Error('EXECUTION_BUDGET_VERIFIER_CONFIG_INVALID');
  }
  const configuredAlgorithms = requiredCanonical(
    env,
    'EXECUTION_BUDGET_GRANT_ALGORITHMS',
    128,
  )
    .split(',')
    .map((algorithm) => algorithm.trim());
  const algorithms = configuredAlgorithms.filter((algorithm) =>
    FIXED_ALGORITHMS.has(algorithm),
  );
  if (
    algorithms.length === 0 ||
    algorithms.length !== configuredAlgorithms.length ||
    new Set(algorithms).size !== algorithms.length
  ) {
    throw new Error('EXECUTION_BUDGET_VERIFIER_CONFIG_INVALID');
  }
  return Object.freeze({
    jwks,
    issuer,
    audience: EXECUTION_BUDGET_GRANT_AUDIENCE,
    algorithms: Object.freeze([...algorithms]),
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasPrivateMaterial(key: Record<string, unknown>): boolean {
  return ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some(
    (name) => key[name] !== undefined,
  );
}

function compatibleKeyShape(
  key: Record<string, unknown>,
  algorithm: string,
): boolean {
  if (algorithm === 'RS256') {
    return (
      key.kty === 'RSA' &&
      typeof key.n === 'string' &&
      typeof key.e === 'string'
    );
  }
  if (algorithm === 'ES256') {
    return (
      key.kty === 'EC' &&
      key.crv === 'P-256' &&
      typeof key.x === 'string' &&
      typeof key.y === 'string'
    );
  }
  return (
    algorithm === 'EdDSA' &&
    key.kty === 'OKP' &&
    key.crv === 'Ed25519' &&
    typeof key.x === 'string'
  );
}

async function validateExecutionBudgetJwksDocument(
  value: unknown,
  algorithms: readonly string[],
): Promise<ExecutionBudgetJwksDocument> {
  if (!record(value) || !Array.isArray(value.keys)) {
    throw new ExecutionBudgetJwksUnavailableError();
  }
  if (value.keys.length < 1 || value.keys.length > MAX_JWKS_KEYS) {
    throw new ExecutionBudgetJwksUnavailableError();
  }

  const keys: JWK[] = [];
  const identities = new Set<string>();
  for (const candidate of value.keys) {
    if (!record(candidate) || hasPrivateMaterial(candidate)) {
      throw new ExecutionBudgetJwksUnavailableError();
    }
    const { alg, kid, use, key_ops: keyOperations } = candidate;
    if (
      typeof alg !== 'string' ||
      !algorithms.includes(alg) ||
      typeof kid !== 'string' ||
      !BOUNDED_IDENTIFIER.test(kid) ||
      (use !== undefined && use !== 'sig') ||
      (keyOperations !== undefined &&
        (!Array.isArray(keyOperations) ||
          !keyOperations.includes('verify') ||
          keyOperations.some((operation) => operation !== 'verify'))) ||
      !compatibleKeyShape(candidate, alg)
    ) {
      continue;
    }
    const identity = `${alg}:${kid}`;
    if (identities.has(identity)) {
      throw new ExecutionBudgetJwksUnavailableError();
    }
    try {
      const imported = await importJWK(candidate as JWK, alg);
      if (imported instanceof Uint8Array || imported.type !== 'public') {
        continue;
      }
    } catch {
      continue;
    }
    identities.add(identity);
    keys.push(Object.freeze({ ...candidate }) as JWK);
  }

  if (keys.length < 1) {
    throw new ExecutionBudgetJwksUnavailableError();
  }

  return Object.freeze({ keys: Object.freeze(keys) });
}

async function boundedJwksJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ExecutionBudgetJwksUnavailableError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_JWKS_BYTES) {
        throw new ExecutionBudgetJwksUnavailableError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
    await response.body.cancel().catch(() => undefined);
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

export async function loadExecutionBudgetJwks(
  configuration: ExecutionBudgetGrantVerifierConfiguration,
  fetcher: ExecutionBudgetJwksFetch = fetch,
  request: Readonly<{
    headers?: HeadersInit;
    signal?: AbortSignal;
  }> = {},
): Promise<ExecutionBudgetJwksDocument> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (request.signal?.aborted) abort();
  else request.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, JWKS_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetcher(configuration.jwks.href, {
      method: 'GET',
      headers:
        request.headers ??
        ({ Accept: 'application/jwk-set+json, application/json' } as const),
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new ExecutionBudgetJwksUnavailableError();
    }
    return await validateExecutionBudgetJwksDocument(
      await boundedJwksJson(response),
      configuration.algorithms,
    );
  } catch {
    throw new ExecutionBudgetJwksUnavailableError();
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener('abort', abort);
  }
}

function createBoundedRemoteJwkSet(
  configuration: ExecutionBudgetGrantVerifierConfiguration,
  fetcher: ExecutionBudgetJwksFetch,
): JWTVerifyGetKey {
  return createRemoteJWKSet(configuration.jwks, {
    timeoutDuration: JWKS_TIMEOUT_MS,
    [customFetch]: async (url, request) => {
      if (url !== configuration.jwks.href) {
        throw new ExecutionBudgetJwksUnavailableError();
      }
      const document = await loadExecutionBudgetJwks(
        configuration,
        fetcher,
        request,
      );
      return new Response(JSON.stringify(document), {
        status: 200,
        headers: { 'Content-Type': 'application/jwk-set+json' },
      });
    },
  });
}

function numericDate(payload: JWTPayload, name: 'iat' | 'nbf' | 'exp'): number {
  const value = payload[name];
  if (!Number.isSafeInteger(value) || value! < 0) throw invalid();
  return value!;
}

function boundedIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !BOUNDED_IDENTIFIER.test(value)) {
    throw invalid();
  }
  return value;
}

function nullableBoundedIdentifier(value: unknown): string | null {
  return value === undefined ? null : boundedIdentifier(value);
}

function nullableUuid(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value;
}

function nullableSha256(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !SHA256.test(value)) throw invalid();
  return value;
}

function nullableMicrousd(value: unknown): bigint | null {
  return value === undefined ? null : assertCanonicalMicrousd(value);
}

function nullablePositiveBigInt(value: unknown): bigint | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !POSITIVE_DECIMAL.test(value)) {
    throw invalid();
  }
  const parsed = BigInt(value);
  if (parsed > MAX_BIGINT) throw invalid();
  return parsed;
}

function isPurpose(value: unknown): value is ExecutionBudgetPurpose {
  return (
    typeof value === 'string' &&
    PURPOSES.has(value as ExecutionBudgetPurpose)
  );
}

function assertExpectedScope(
  authority: VerifiedExecutionBudgetAuthority,
  expected: ExecutionBudgetGrantExpectedScope,
): void {
  const commonMismatch =
    authority.authorityKind !== expected.authorityKind ||
    authority.purpose !== expected.purpose ||
    authority.subjectType !== expected.subjectType ||
    authority.subjectId !== expected.subjectId;
  const kindMismatch =
    expected.authorityKind === 'WORKSPACE_GRANT'
      ? authority.workspaceId !== expected.workspaceId ||
        authority.requestSha256 !== expected.requestSha256
      : authority.scheduleId !== expected.scheduleId;
  if (commonMismatch || kindMismatch) {
    throw new ExecutionBudgetGrantError(
      'EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH',
    );
  }
}

/**
 * Verifies external spending authority and reduces the credential-bearing
 * compact JWS to a digest before returning a fresh claim object.
 */
@Injectable()
export class ExecutionBudgetGrantVerifier {
  private readonly configuration: ExecutionBudgetGrantVerifierConfiguration | null;
  private readonly keyResolver: JWTVerifyGetKey | null;
  private readonly now: () => Date;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    dependencies: VerifierDependencies = {},
  ) {
    let configuration: ExecutionBudgetGrantVerifierConfiguration | null = null;
    let keyResolver: JWTVerifyGetKey | null = null;
    try {
      configuration = validateExecutionBudgetGrantVerifierConfiguration(env);
      keyResolver =
        dependencies.keyResolver ??
        createBoundedRemoteJwkSet(
          configuration,
          dependencies.fetcher ?? fetch,
        );
    } catch {
      // Runtime composition may expose diagnostics while this additive
      // capability is unavailable. Verification remains fail closed.
    }
    this.configuration = configuration;
    this.keyResolver = keyResolver;
    this.now = dependencies.now ?? (() => new Date());
  }

  async verify(
    compactJws: string | undefined,
    expectedScope: ExecutionBudgetGrantExpectedScope,
  ): Promise<VerifiedExecutionBudgetAuthority> {
    if (!this.configuration || !this.keyResolver) throw unavailable();
    if (!compactJws) {
      throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_REQUIRED');
    }
    if (
      compactJws !== compactJws.trim() ||
      Buffer.byteLength(compactJws, 'utf8') > MAX_GRANT_BYTES
    ) {
      throw invalid();
    }

    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(compactJws);
    } catch {
      throw invalid();
    }
    if (
      header.typ !== EXECUTION_BUDGET_GRANT_TYPE ||
      typeof header.kid !== 'string' ||
      !BOUNDED_IDENTIFIER.test(header.kid) ||
      typeof header.alg !== 'string' ||
      !this.configuration.algorithms.includes(header.alg)
    ) {
      throw invalid();
    }

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(compactJws, this.keyResolver, {
        issuer: this.configuration.issuer,
        audience: this.configuration.audience,
        algorithms: [...this.configuration.algorithms],
        typ: EXECUTION_BUDGET_GRANT_TYPE,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: this.now(),
      }));
    } catch (error) {
      throw this.classifyVerificationFailure(error);
    }

    try {
      if (payload.aud !== EXECUTION_BUDGET_GRANT_AUDIENCE) throw invalid();
      const issuedAt = numericDate(payload, 'iat');
      const notBefore = numericDate(payload, 'nbf');
      const expiresAt = numericDate(payload, 'exp');
      const nowSeconds = Math.floor(this.now().getTime() / 1_000);
      if (
        issuedAt > notBefore ||
        notBefore > expiresAt ||
        expiresAt - issuedAt > MAX_TTL_SECONDS ||
        issuedAt > nowSeconds + CLOCK_TOLERANCE_SECONDS
      ) {
        throw invalid();
      }

      const authorityKind = payload.authority_kind;
      const purpose = payload.purpose;
      const workspaceId = nullableUuid(payload.workspace_id);
      const requestSha256 = nullableSha256(payload.request_sha256);
      if (
        (authorityKind !== 'WORKSPACE_GRANT' &&
          authorityKind !== 'PLATFORM_GRANT') ||
        !isPurpose(purpose) ||
        payload.schema_version !== EXECUTION_BUDGET_GRANT_SCHEMA ||
        typeof payload.jti !== 'string' ||
        !UUID.test(payload.jti) ||
        payload.currency !== 'USD' ||
        payload.unit !== 'microusd'
      ) {
        throw invalid();
      }

      const authority = Object.freeze({
        schemaVersion: EXECUTION_BUDGET_GRANT_SCHEMA,
        authorityKind,
        issuer: this.configuration.issuer,
        audience: EXECUTION_BUDGET_GRANT_AUDIENCE,
        jti: payload.jti,
        purpose,
        workspaceId,
        subjectType: boundedIdentifier(payload.subject_type),
        subjectId: boundedIdentifier(payload.subject_id),
        requestSha256,
        scheduleId: nullableBoundedIdentifier(payload.schedule_id),
        currency: 'USD' as const,
        unit: 'microusd' as const,
        capMicrousd: nullableMicrousd(payload.cap_microusd),
        capPerRunMicrousd: nullableMicrousd(payload.cap_per_run_microusd),
        campaignCapMicrousd: nullableMicrousd(
          payload.campaign_cap_microusd,
        ),
        maxRuns: nullablePositiveBigInt(payload.max_runs),
        tokenSha256: createHash('sha256').update(compactJws).digest('hex'),
        issuedAt: new Date(issuedAt * 1_000),
        notBefore: new Date(notBefore * 1_000),
        expiresAt: new Date(expiresAt * 1_000),
      }) satisfies VerifiedExecutionBudgetAuthority;

      assertAuthorityPurposeShape(authority);
      assertExpectedScope(authority, expectedScope);
      return authority;
    } catch (error) {
      if (error instanceof ExecutionBudgetGrantError) throw error;
      throw invalid();
    }
  }

  private classifyVerificationFailure(error: unknown): ExecutionBudgetGrantError {
    if (error instanceof joseErrors.JWTExpired) {
      return new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_EXPIRED');
    }
    if (
      error instanceof joseErrors.JWTClaimValidationFailed &&
      error.claim === 'nbf'
    ) {
      return new ExecutionBudgetGrantError('EXECUTION_BUDGET_GRANT_EXPIRED');
    }
    if (
      error instanceof ExecutionBudgetJwksUnavailableError ||
      error instanceof joseErrors.JWKSTimeout ||
      error instanceof joseErrors.JWKSNoMatchingKey ||
      error instanceof joseErrors.JWKSMultipleMatchingKeys ||
      error instanceof joseErrors.JWKSInvalid ||
      error instanceof joseErrors.JWKInvalid ||
      error instanceof TypeError
    ) {
      return unavailable();
    }
    return invalid();
  }
}
