import {
  DynamicModule,
  Global,
  Inject,
  Injectable,
  Module,
} from '@nestjs/common';
import { resolve } from 'node:path';
import {
  type BuildIdentity,
  type RuntimeEnvironment,
  type RuntimeIdentityField,
} from './build-identity';
import { loadRuntimeBuildIdentity } from './build-receipt';

export const DEPLOYMENT_STAGES = [
  'development',
  'pilot',
  'production',
] as const;
export type DeploymentStage = (typeof DEPLOYMENT_STAGES)[number];

export type {
  BuildIdentity,
  RuntimeEnvironment,
  RuntimeIdentityField,
} from './build-identity';

export interface RuntimeAuthSafety {
  readonly mode: 'development' | 'jwks';
  readonly jwksUri: string | null;
  readonly issuer: string | null;
  readonly audience: string | null;
  readonly clockSkewSeconds: number;
  readonly workspaceClaim: string;
  readonly rolesClaim: string;
}

export interface RuntimeProcessSafety {
  readonly auth: RuntimeAuthSafety;
  readonly model: Readonly<{ allowStub: boolean }>;
  readonly storage: Readonly<{
    available: boolean;
    allowUnavailable: boolean;
    manageVariantAttemptLifecycle: boolean;
    strictVariantAttemptLifecycle: boolean;
  }>;
  readonly processorJurisdiction: 'EU' | 'UK' | 'US' | 'CN' | 'OTHER';
  readonly siteRendererBuildIdentity: string;
  readonly temporal: Readonly<{
    address: string;
    namespace: string;
    connectTimeoutMs: number;
  }>;
}

export interface RuntimeProcessSnapshot {
  readonly deploymentStage: DeploymentStage;
  /** Private process configuration copy. Never return this from HTTP health. */
  readonly environment: RuntimeEnvironment;
  readonly safety: RuntimeProcessSafety;
}

export interface RuntimeAdmission {
  readonly deploymentStage: DeploymentStage;
  readonly apiBindHost: '127.0.0.1';
  readonly port: number;
  readonly corsOrigins: readonly string[];
  readonly buildIdentity: BuildIdentity;
}

export interface RuntimeBootstrapSnapshot {
  readonly process: RuntimeProcessSnapshot;
  readonly admission: RuntimeAdmission;
}

export interface RuntimeAdmissionOptions {
  readonly artifactRoot?: string;
  readonly receiptPath?: string;
}

export interface BuildHealthResponse {
  readonly status: BuildIdentity['status'];
  readonly service: 'global-api';
  readonly deploymentStage: DeploymentStage;
  readonly identity: Readonly<{
    buildSha: string | null;
    buildTime: string | null;
    artifactDigest: string | null;
    migrationManifestDigest: string | null;
    migrationRevision: string | null;
    migrationCount: number | null;
  }>;
  readonly missingFields: readonly RuntimeIdentityField[];
}

export const RUNTIME_ADMISSION = Symbol('RUNTIME_ADMISSION');

const APPROVED_API_BIND_HOST = '127.0.0.1' as const;
const DEFAULT_API_PORT = 3000;
const DEFAULT_TEMPORAL_CONNECT_TIMEOUT_MS = 3_000;
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/u;
const CANONICAL_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RENDERER_BUILD_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._+@:/-]{0,127}$/u;
const JURISDICTIONS = ['EU', 'UK', 'US', 'CN', 'OTHER'] as const;
const NODE_ENV_VALUES = ['development', 'test', 'production'] as const;
const LOOPBACK_HOSTNAMES = new Set([
  '127.0.0.1',
  '::1',
  '[::1]',
  'localhost',
]);

function invalid(name: string, expectation: string): never {
  throw new Error(`${name} is invalid; ${expectation}`);
}

function optionalBoolean(
  env: RuntimeEnvironment,
  name: string,
): boolean | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return invalid(name, 'expected exactly true or false');
}

function optionalCanonical(
  env: RuntimeEnvironment,
  name: string,
): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (value === '' || value.trim() !== value) {
    return invalid(name, 'expected a non-blank canonical value');
  }
  return value;
}

function boundedInteger(
  env: RuntimeEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!CANONICAL_INTEGER_PATTERN.test(value)) {
    return invalid(name, `expected an integer from ${minimum} through ${maximum}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return invalid(name, `expected an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

export function resolveDeploymentStage(
  env: RuntimeEnvironment,
): DeploymentStage {
  const explicitStage = env.DEPLOYMENT_STAGE;
  if (explicitStage === undefined) {
    throw new Error('DEPLOYMENT_STAGE is required');
  }
  if (!(DEPLOYMENT_STAGES as readonly string[]).includes(explicitStage)) {
    return invalid(
      'DEPLOYMENT_STAGE',
      `expected one of ${DEPLOYMENT_STAGES.join(', ')}`,
    );
  }
  const nodeEnvironment = env.NODE_ENV;
  if (
    nodeEnvironment !== undefined &&
    !(NODE_ENV_VALUES as readonly string[]).includes(nodeEnvironment)
  ) {
    return invalid(
      'NODE_ENV',
      `expected one of ${NODE_ENV_VALUES.join(', ')}`,
    );
  }
  if (explicitStage !== 'development' && nodeEnvironment !== 'production') {
    throw new Error(
      `NODE_ENV=production is required for DEPLOYMENT_STAGE=${explicitStage}`,
    );
  }
  if (explicitStage === 'development' && nodeEnvironment === 'production') {
    throw new Error(
      'DEPLOYMENT_STAGE cannot downgrade a NODE_ENV=production process to development',
    );
  }
  return explicitStage as DeploymentStage;
}

function canonicalHttpUrl(
  name: string,
  value: string,
  stage: DeploymentStage,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid(name, 'expected a canonical HTTP(S) URL');
  }
  if (
    (parsed.protocol !== 'https:' &&
      !(stage === 'development' && parsed.protocol === 'http:')) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    parsed.href !== value
  ) {
    return invalid(
      name,
      stage === 'development'
        ? 'expected a canonical HTTP(S) URL without credentials or fragments'
        : 'expected a canonical HTTPS URL without credentials or fragments',
    );
  }
  return value;
}

function authIdentityUrl(
  name: 'AUTH_JWKS_URI' | 'AUTH_ISSUER',
  value: string,
  stage: DeploymentStage,
): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid(name, 'expected an absolute HTTP(S) URL');
  }
  const secure = parsed.protocol === 'https:';
  const loopbackDevelopment =
    stage === 'development' &&
    parsed.protocol === 'http:' &&
    LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
  if (
    (!secure && !loopbackDevelopment) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== ''
  ) {
    return invalid(
      name,
      'expected HTTPS without credentials or fragments, except loopback HTTP in development',
    );
  }
  // jose compares issuer bytes exactly; validation must not normalize it.
  return value;
}

function resolveAuthSafety(
  stage: DeploymentStage,
  env: RuntimeEnvironment,
): RuntimeAuthSafety {
  const jwksUriValue = optionalCanonical(env, 'AUTH_JWKS_URI');
  const issuer = optionalCanonical(env, 'AUTH_ISSUER');
  const audience = optionalCanonical(env, 'AUTH_AUDIENCE');
  if (
    [jwksUriValue, issuer, audience].filter(
      (value): value is string => value !== undefined,
    ).length !== 0 &&
    (!jwksUriValue || !issuer || !audience)
  ) {
    throw new Error(
      'AUTH_JWKS_URI, AUTH_ISSUER, and AUTH_AUDIENCE must be configured together',
    );
  }
  const allowDevelopmentTokens =
    optionalBoolean(env, 'AUTH_ALLOW_DEV_TOKENS') ?? false;
  if (stage !== 'development' && allowDevelopmentTokens) {
    throw new Error(
      'AUTH_ALLOW_DEV_TOKENS is forbidden outside development',
    );
  }
  if (stage !== 'development' && !jwksUriValue) {
    throw new Error(
      `AUTH_JWKS_URI, AUTH_ISSUER, and AUTH_AUDIENCE are required for ${stage}`,
    );
  }
  if (stage === 'development' && !jwksUriValue && !allowDevelopmentTokens) {
    throw new Error(
      'AUTH_ALLOW_DEV_TOKENS=true is required to use development tokens without JWKS',
    );
  }
  if (audience && audience.length > 512) {
    return invalid('AUTH_AUDIENCE', 'expected at most 512 characters');
  }
  const mode = jwksUriValue ? 'jwks' : 'development';
  const workspaceClaim =
    optionalCanonical(env, 'AUTH_WORKSPACE_CLAIM') ?? 'workspace_id';
  const rolesClaim = optionalCanonical(env, 'AUTH_ROLES_CLAIM') ?? 'roles';
  if (!SAFE_IDENTIFIER_PATTERN.test(workspaceClaim)) {
    return invalid('AUTH_WORKSPACE_CLAIM', 'expected a safe claim identifier');
  }
  if (!SAFE_IDENTIFIER_PATTERN.test(rolesClaim)) {
    return invalid('AUTH_ROLES_CLAIM', 'expected a safe claim identifier');
  }
  return Object.freeze({
    mode,
    jwksUri: jwksUriValue
      ? authIdentityUrl('AUTH_JWKS_URI', jwksUriValue, stage)
      : null,
    issuer: issuer ? authIdentityUrl('AUTH_ISSUER', issuer, stage) : null,
    audience: audience ?? null,
    clockSkewSeconds: boundedInteger(
      env,
      'AUTH_CLOCK_SKEW_S',
      60,
      0,
      300,
    ),
    workspaceClaim,
    rolesClaim,
  });
}

function resolveModelSafety(
  stage: DeploymentStage,
  env: RuntimeEnvironment,
): Readonly<{ allowStub: boolean }> {
  const gatewayUrl = optionalCanonical(env, 'MODEL_GATEWAY_URL');
  const gatewayKey = optionalCanonical(env, 'MODEL_GATEWAY_KEY');
  if ((gatewayUrl === undefined) !== (gatewayKey === undefined)) {
    throw new Error(
      'MODEL_GATEWAY_URL and MODEL_GATEWAY_KEY must be configured together',
    );
  }
  if (gatewayUrl) canonicalHttpUrl('MODEL_GATEWAY_URL', gatewayUrl, stage);
  const configuredStub = optionalBoolean(env, 'MODEL_ALLOW_STUB');
  if (stage !== 'development' && configuredStub === true) {
    throw new Error('MODEL_ALLOW_STUB is forbidden outside development');
  }
  if (stage !== 'development' && !gatewayUrl) {
    throw new Error(
      `MODEL_GATEWAY_URL and MODEL_GATEWAY_KEY are required for ${stage}`,
    );
  }
  return Object.freeze({
    allowStub:
      stage === 'development' && (configuredStub === undefined || configuredStub),
  });
}

function resolveStorageSafety(
  stage: DeploymentStage,
  env: RuntimeEnvironment,
): RuntimeProcessSafety['storage'] {
  const accessKey = optionalCanonical(env, 'S3_ACCESS_KEY');
  const secretKey = optionalCanonical(env, 'S3_SECRET_KEY');
  if ((accessKey === undefined) !== (secretKey === undefined)) {
    throw new Error('S3_ACCESS_KEY and S3_SECRET_KEY must be configured together');
  }
  if (stage !== 'development' && !accessKey) {
    throw new Error(
      `S3_ACCESS_KEY and S3_SECRET_KEY are required for ${stage}`,
    );
  }
  const available = accessKey !== undefined;
  const configuredManage = optionalBoolean(
    env,
    'S3_MANAGE_VARIANT_ATTEMPT_LIFECYCLE',
  );
  const manageVariantAttemptLifecycle =
    configuredManage ?? stage === 'development';
  return Object.freeze({
    available,
    allowUnavailable: stage === 'development' && !available,
    manageVariantAttemptLifecycle,
    strictVariantAttemptLifecycle:
      stage !== 'development' || !manageVariantAttemptLifecycle,
  });
}

function resolveProcessorJurisdictionSafety(
  stage: DeploymentStage,
  env: RuntimeEnvironment,
): RuntimeProcessSafety['processorJurisdiction'] {
  const configured = optionalCanonical(env, 'DATA_PROCESSOR_JURISDICTION');
  if (!configured) {
    if (stage !== 'development') {
      throw new Error(
        `DATA_PROCESSOR_JURISDICTION is required for ${stage}`,
      );
    }
    return 'EU';
  }
  const normalized = configured.toUpperCase();
  if (!(JURISDICTIONS as readonly string[]).includes(normalized)) {
    return invalid(
      'DATA_PROCESSOR_JURISDICTION',
      `expected one of ${JURISDICTIONS.join(', ')}`,
    );
  }
  return normalized as RuntimeProcessSafety['processorJurisdiction'];
}

function resolveRendererBuildIdentitySafety(
  stage: DeploymentStage,
  env: RuntimeEnvironment,
): string {
  const configured = optionalCanonical(env, 'SITE_RENDERER_BUILD_ID');
  if (!configured) {
    if (stage !== 'development') {
      throw new Error(`SITE_RENDERER_BUILD_ID is required for ${stage}`);
    }
    return 'site-renderer@dev-unpinned';
  }
  if (!RENDERER_BUILD_ID_PATTERN.test(configured)) {
    return invalid('SITE_RENDERER_BUILD_ID', 'expected a safe build identity');
  }
  return configured;
}

function resolveTemporalSafety(
  env: RuntimeEnvironment,
): RuntimeProcessSafety['temporal'] {
  const address = optionalCanonical(env, 'TEMPORAL_ADDRESS') ?? '127.0.0.1:7233';
  if (!/^[A-Za-z0-9._-]+:[1-9][0-9]{0,4}$/u.test(address)) {
    return invalid('TEMPORAL_ADDRESS', 'expected canonical host:port');
  }
  const port = Number(address.slice(address.lastIndexOf(':') + 1));
  if (port > 65_535) {
    return invalid('TEMPORAL_ADDRESS', 'expected canonical host:port');
  }
  const namespace = optionalCanonical(env, 'TEMPORAL_NAMESPACE') ?? 'default';
  if (!SAFE_IDENTIFIER_PATTERN.test(namespace)) {
    return invalid('TEMPORAL_NAMESPACE', 'expected a safe namespace identifier');
  }
  return Object.freeze({
    address,
    namespace,
    connectTimeoutMs: boundedInteger(
      env,
      'TEMPORAL_CONNECT_TIMEOUT_MS',
      DEFAULT_TEMPORAL_CONNECT_TIMEOUT_MS,
      1,
      10_000,
    ),
  });
}

export function resolveRuntimeProcessSnapshot(
  env: RuntimeEnvironment,
): RuntimeProcessSnapshot {
  const environment = Object.freeze({ ...env });
  const deploymentStage = resolveDeploymentStage(environment);
  const safety = Object.freeze({
    auth: resolveAuthSafety(deploymentStage, environment),
    model: resolveModelSafety(deploymentStage, environment),
    storage: resolveStorageSafety(deploymentStage, environment),
    processorJurisdiction: resolveProcessorJurisdictionSafety(
      deploymentStage,
      environment,
    ),
    siteRendererBuildIdentity: resolveRendererBuildIdentitySafety(
      deploymentStage,
      environment,
    ),
    temporal: resolveTemporalSafety(environment),
  });
  return Object.freeze({ deploymentStage, environment, safety });
}

export function resolveApiBindHost(
  deploymentStage: DeploymentStage,
  env: RuntimeEnvironment,
): '127.0.0.1' {
  const configuredHost = env.API_BIND_HOST;
  if (configuredHost === undefined) {
    if (deploymentStage === 'development') return APPROVED_API_BIND_HOST;
    throw new Error(
      `API_BIND_HOST is required for ${deploymentStage}; current Ubuntu admission accepts only ${APPROVED_API_BIND_HOST}`,
    );
  }
  if (configuredHost !== APPROVED_API_BIND_HOST) {
    return invalid(
      'API_BIND_HOST',
      `current Ubuntu admission accepts only ${APPROVED_API_BIND_HOST}`,
    );
  }
  return APPROVED_API_BIND_HOST;
}

export function resolveApiPort(env: RuntimeEnvironment): number {
  const configuredPort = env.PORT;
  if (configuredPort === undefined) return DEFAULT_API_PORT;
  if (!PORT_PATTERN.test(configuredPort)) {
    return invalid('PORT', 'expected a canonical integer from 1 through 65535');
  }
  const port = Number(configuredPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return invalid('PORT', 'expected a canonical integer from 1 through 65535');
  }
  return port;
}

function canonicalCorsOrigin(value: string): string {
  if (value.length === 0) {
    return invalid('CORS_ORIGINS', 'blank entries are not allowed');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid(
      'CORS_ORIGINS',
      'each entry must be a canonical HTTP origin',
    );
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin !== value
  ) {
    return invalid(
      'CORS_ORIGINS',
      'each entry must be a canonical HTTP origin',
    );
  }
  return parsed.origin;
}

export function resolveCorsOrigins(
  deploymentStage: DeploymentStage,
  env: RuntimeEnvironment,
): readonly string[] {
  const configuredOrigins = env.CORS_ORIGINS;
  if (configuredOrigins === undefined) {
    if (deploymentStage === 'development') return Object.freeze([]);
    throw new Error(`CORS_ORIGINS is required for ${deploymentStage}`);
  }
  if (configuredOrigins.trim() === '') {
    throw new Error(`CORS_ORIGINS is required for ${deploymentStage}`);
  }
  const entries = configuredOrigins
    .split(',')
    .map((entry) => canonicalCorsOrigin(entry.trim()));
  return Object.freeze(Array.from(new Set(entries)));
}

export function resolveRuntimeAdmission(
  env: RuntimeEnvironment,
  options: RuntimeAdmissionOptions = {},
): RuntimeBootstrapSnapshot {
  const processSnapshot = resolveRuntimeProcessSnapshot(env);
  const { deploymentStage, environment } = processSnapshot;
  const artifactRoot = resolve(
    options.artifactRoot ?? resolve(__dirname, '..'),
  );
  const admission = Object.freeze({
    deploymentStage,
    apiBindHost: resolveApiBindHost(deploymentStage, environment),
    port: resolveApiPort(environment),
    corsOrigins: resolveCorsOrigins(deploymentStage, environment),
    buildIdentity: loadRuntimeBuildIdentity({
      artifactRoot,
      receiptPath: options.receiptPath,
      env: environment,
      required: deploymentStage !== 'development',
    }),
  });
  return Object.freeze({ process: processSnapshot, admission });
}

@Injectable()
export class RuntimeIdentityService {
  constructor(
    @Inject(RUNTIME_ADMISSION)
    private readonly bootstrapSnapshot: RuntimeBootstrapSnapshot,
  ) {}

  getBootstrapSnapshot(): RuntimeBootstrapSnapshot {
    return this.bootstrapSnapshot;
  }

  getProcessSnapshot(): RuntimeProcessSnapshot {
    return this.bootstrapSnapshot.process;
  }

  getSnapshot(): RuntimeAdmission {
    return this.bootstrapSnapshot.admission;
  }

  getBuildHealth(): BuildHealthResponse {
    const { deploymentStage, buildIdentity } = this.getSnapshot();
    return Object.freeze({
      status: buildIdentity.status,
      service: 'global-api',
      deploymentStage,
      identity: Object.freeze({
        buildSha: buildIdentity.buildSha,
        buildTime: buildIdentity.buildTime,
        artifactDigest: buildIdentity.artifactDigest,
        migrationManifestDigest: buildIdentity.migrationManifestDigest,
        migrationRevision: buildIdentity.migrationRevision,
        migrationCount:
          buildIdentity.status === 'VERIFIED'
            ? buildIdentity.migrationManifest.entries.length
            : null,
      }),
      missingFields: buildIdentity.missingFields,
    });
  }
}

@Global()
@Module({})
export class RuntimeModule {
  static forRoot(snapshot: RuntimeBootstrapSnapshot): DynamicModule {
    if (!Object.isFrozen(snapshot)) {
      throw new Error('runtime bootstrap snapshot must be frozen');
    }
    return {
      module: RuntimeModule,
      global: true,
      providers: [
        { provide: RUNTIME_ADMISSION, useValue: snapshot },
        RuntimeIdentityService,
      ],
      exports: [RUNTIME_ADMISSION, RuntimeIdentityService],
    };
  }
}
