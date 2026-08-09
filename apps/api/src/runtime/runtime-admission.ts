import type { BuildIdentity } from './build-attestation';
import type { RuntimeSettings } from './runtime-environment';

type AdmissionStatus = 'ok' | 'optional' | 'failed';

interface AdmissionCheck {
  status: AdmissionStatus;
  code?: string;
}

export interface RuntimeAdmissionResult {
  mode: RuntimeSettings['mode'];
  admitted: boolean;
  checks: {
    build: AdmissionCheck;
    auth: AdmissionCheck;
    gateway: AdmissionCheck;
  };
}

function controlled(mode: RuntimeSettings['mode']): boolean {
  return mode === 'pilot' || mode === 'production';
}

function inspectAuth(settings: RuntimeSettings, env: NodeJS.ProcessEnv): AdmissionCheck {
  if (!controlled(settings.mode)) return { status: 'optional' };
  if (!env.AUTH_JWKS_URI || !env.AUTH_ISSUER || !env.AUTH_AUDIENCE) {
    return { status: 'failed', code: 'AUTH_CONFIG_INCOMPLETE' };
  }
  try {
    const jwks = new URL(env.AUTH_JWKS_URI);
    const issuer = new URL(env.AUTH_ISSUER);
    if (jwks.protocol !== 'https:' || issuer.protocol !== 'https:') {
      return { status: 'failed', code: 'AUTH_ORIGIN_NOT_HTTPS' };
    }
  } catch {
    return { status: 'failed', code: 'AUTH_CONFIG_INVALID' };
  }
  return { status: 'ok' };
}

function loopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1' || hostname === 'localhost';
}

function inspectGateway(settings: RuntimeSettings, env: NodeJS.ProcessEnv): AdmissionCheck {
  if (!controlled(settings.mode)) return { status: 'optional' };
  if (!env.MODEL_GATEWAY_URL || !env.MODEL_GATEWAY_KEY) {
    return { status: 'failed', code: 'GATEWAY_CONFIG_INCOMPLETE' };
  }
  try {
    const url = new URL(env.MODEL_GATEWAY_URL);
    if (url.username || url.password || url.search || url.hash) {
      return { status: 'failed', code: 'GATEWAY_URL_INVALID' };
    }
    if (settings.mode === 'pilot' && !loopback(url.hostname)) {
      return { status: 'failed', code: 'PILOT_GATEWAY_NOT_LOOPBACK' };
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) {
      return { status: 'failed', code: 'GATEWAY_ORIGIN_NOT_SECURE' };
    }
  } catch {
    return { status: 'failed', code: 'GATEWAY_URL_INVALID' };
  }
  return { status: 'ok' };
}

export function inspectRuntimeAdmission(
  settings: RuntimeSettings,
  env: NodeJS.ProcessEnv,
  buildIdentity: BuildIdentity,
): RuntimeAdmissionResult {
  const build: AdmissionCheck = buildIdentity.attested
    ? { status: 'ok' }
    : controlled(settings.mode)
      ? { status: 'failed', code: 'BUILD_ATTESTATION_REQUIRED' }
      : { status: 'optional' };
  const checks = Object.freeze({
    build,
    auth: inspectAuth(settings, env),
    gateway: inspectGateway(settings, env),
  });
  return Object.freeze({
    mode: settings.mode,
    admitted: Object.values(checks).every((check) => check.status !== 'failed'),
    checks,
  });
}

export class RuntimeAdmissionService {
  constructor(private readonly result: RuntimeAdmissionResult) {}

  current(): RuntimeAdmissionResult {
    return this.result;
  }
}
