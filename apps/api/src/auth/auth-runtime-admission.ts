import { DeploymentStage, resolveDeploymentStage } from '../common/deployment-stage';
import { RoleScopePolicy } from './auth-scopes';

type Environment = Readonly<Record<string, string | undefined>>;

const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

export interface JwksRuntimeConfig {
  readonly uri: string;
  readonly issuer: string;
  readonly audience: string;
  readonly clockSkewSeconds: number;
  readonly workspaceClaim: string;
  readonly rolesClaim: string;
}

export interface AuthRuntimeAdmission {
  readonly stage: DeploymentStage;
  readonly verifierKind: 'jwks' | 'dev' | 'disabled';
  readonly bindHost: string;
  readonly allowListen: boolean;
  readonly roleScopePolicy: RoleScopePolicy;
  readonly jwks?: JwksRuntimeConfig;
}

function requiredValue(env: Environment, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (!value.trim() || value !== value.trim()) {
    throw new Error(`${name} must be a non-blank trimmed value`);
  }
  return value;
}

function parseClockSkew(raw: string | undefined): number {
  if (raw === undefined) return 60;
  if (!/^\d{1,3}$/u.test(raw)) {
    throw new Error('AUTH_CLOCK_SKEW_S must be an integer from 0 through 300');
  }
  const parsed = Number(raw);
  if (parsed > 300) {
    throw new Error('AUTH_CLOCK_SKEW_S must be an integer from 0 through 300');
  }
  return parsed;
}

function claimName(env: Environment, name: string, fallback: string): string {
  const value = requiredValue(env, name) ?? fallback;
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function validateAbsoluteUrl(raw: string, name: 'AUTH_JWKS_URI' | 'AUTH_ISSUER', stage: DeploymentStage): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`${name} must not contain credentials or a fragment`);
  }
  const loopback = LOOPBACK_BIND_HOSTS.has(url.hostname.toLowerCase());
  const secure = url.protocol === 'https:';
  const localDevelopment = stage === 'development' && url.protocol === 'http:' && loopback;
  if (!secure && !localDevelopment) {
    throw new Error(`${name} must use HTTPS except for loopback development`);
  }
  // jwtVerify compares issuer exactly; validation must not normalize its bytes.
  return raw;
}

function resolveJwksConfig(env: Environment, stage: DeploymentStage): JwksRuntimeConfig | undefined {
  const uri = requiredValue(env, 'AUTH_JWKS_URI');
  const issuer = requiredValue(env, 'AUTH_ISSUER');
  const audience = requiredValue(env, 'AUTH_AUDIENCE');
  const configured = [uri, issuer, audience].filter(Boolean).length;
  if (configured === 0) return undefined;
  if (!uri) throw new Error('AUTH_JWKS_URI is required for JWKS verification');
  if (!issuer) throw new Error('AUTH_ISSUER is required for JWKS verification');
  if (!audience) throw new Error('AUTH_AUDIENCE is required for JWKS verification');
  if (audience.length > 512) throw new Error('AUTH_AUDIENCE is too long');

  return Object.freeze({
    uri: validateAbsoluteUrl(uri, 'AUTH_JWKS_URI', stage),
    issuer: validateAbsoluteUrl(issuer, 'AUTH_ISSUER', stage),
    audience,
    clockSkewSeconds: parseClockSkew(env.AUTH_CLOCK_SKEW_S),
    workspaceClaim: claimName(env, 'AUTH_WORKSPACE_CLAIM', 'workspace_id'),
    rolesClaim: claimName(env, 'AUTH_ROLES_CLAIM', 'roles'),
  });
}

function servingBindHost(env: Environment, stage: DeploymentStage): string {
  const host = requiredValue(env, 'API_BIND_HOST') ?? '127.0.0.1';
  if (stage !== 'development' && host !== '127.0.0.1') {
    throw new Error('API_BIND_HOST must be canonical 127.0.0.1 in pilot or production');
  }
  if (!LOOPBACK_BIND_HOSTS.has(host.toLowerCase())) {
    throw new Error('API_BIND_HOST must be loopback (127.0.0.1, ::1, or localhost)');
  }
  return host;
}

/**
 * Fails closed before Nest constructs a verifier or opens a listening socket.
 * OpenAPI export is explicitly non-serving and receives a verifier that rejects all tokens.
 */
export function resolveAuthRuntimeAdmission(env: Environment, argv: readonly string[] = []): AuthRuntimeAdmission {
  const stage = resolveDeploymentStage(env);
  const openApiOnly = argv.includes('--export-openapi');
  if (openApiOnly) {
    return Object.freeze({
      stage,
      verifierKind: 'disabled',
      bindHost: '127.0.0.1',
      allowListen: false,
      roleScopePolicy: RoleScopePolicy.disabledRuntime(),
    });
  }

  const bindHost = servingBindHost(env, stage);
  const roleScopePolicy = RoleScopePolicy.parse(env.AUTH_ROLE_SCOPE_MAP);
  const jwks = resolveJwksConfig(env, stage);

  if (stage === 'pilot' || stage === 'production') {
    if (!jwks) {
      throw new Error(`${stage} requires AUTH_JWKS_URI, AUTH_ISSUER, and AUTH_AUDIENCE; DevTokenVerifier is forbidden`);
    }
    return Object.freeze({
      stage,
      verifierKind: 'jwks',
      bindHost,
      allowListen: true,
      roleScopePolicy,
      jwks,
    });
  }

  if (jwks) {
    return Object.freeze({
      stage,
      verifierKind: 'jwks',
      bindHost,
      allowListen: true,
      roleScopePolicy,
      jwks,
    });
  }
  if (env.AUTH_ALLOW_DEV_TOKENS !== 'true') {
    throw new Error('development DevTokenVerifier requires AUTH_ALLOW_DEV_TOKENS=true');
  }
  return Object.freeze({
    stage,
    verifierKind: 'dev',
    bindHost,
    allowListen: true,
    roleScopePolicy,
  });
}

export function assertServingAdmission(
  admission: AuthRuntimeAdmission,
): asserts admission is AuthRuntimeAdmission & { readonly allowListen: true } {
  if (!admission.allowListen || admission.verifierKind === 'disabled') {
    throw new Error('OpenAPI-only auth admission cannot open a listening socket');
  }
}
