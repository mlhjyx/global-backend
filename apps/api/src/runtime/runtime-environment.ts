import { isIP } from 'node:net';

export type RuntimeMode = 'development' | 'test' | 'pilot' | 'production';

export interface RuntimeSettings {
  mode: RuntimeMode;
  bindHost: string;
  port: number;
}

const ALLOWED_MODES = new Set<RuntimeMode>([
  'development',
  'test',
  'pilot',
  'production',
]);

export function resolveRuntimeMode(env: NodeJS.ProcessEnv): RuntimeMode {
  const declared = env.APP_ENVIRONMENT?.trim();
  if (declared && !ALLOWED_MODES.has(declared as RuntimeMode)) {
    throw new Error(`APP_ENVIRONMENT must be one of: ${[...ALLOWED_MODES].join(', ')}`);
  }
  if (
    (declared === 'pilot' || declared === 'production') &&
    env.NODE_ENV !== 'production'
  ) {
    throw new Error(`${declared} requires NODE_ENV=production`);
  }
  if (declared) return declared as RuntimeMode;
  if (env.NODE_ENV === 'production') return 'production';
  if (env.NODE_ENV === 'test') return 'test';
  return 'development';
}

function canonicalIpLiteral(address: string): string {
  if (isIP(address) === 4) return address;
  return new URL(`http://[${address}]/`).hostname.slice(1, -1);
}

function isWildcardAddress(address: string): boolean {
  const canonical = canonicalIpLiteral(address);
  return (
    canonical === '0.0.0.0' ||
    canonical === '::' ||
    canonical === '::ffff:0:0'
  );
}

function resolvePort(value: string | undefined): number {
  if (value === undefined || value === '') return 3000;
  if (!/^\d+$/.test(value)) throw new Error('PORT must be a decimal integer from 1 to 65535');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be a decimal integer from 1 to 65535');
  }
  return port;
}

function resolveBindHost(mode: RuntimeMode, value: string | undefined): string {
  const bindHost = value?.trim();
  if (!bindHost) {
    if (mode === 'pilot' || mode === 'production') {
      throw new Error(`API_BIND_HOST is required in ${mode}`);
    }
    return '127.0.0.1';
  }
  if (!isIP(bindHost)) {
    throw new Error('API_BIND_HOST must be an IP literal without a port');
  }
  if (isWildcardAddress(bindHost)) {
    const qualifier = mode === 'pilot' ? 'controlled pilot requires loopback' : 'wildcard binds are forbidden';
    throw new Error(`API_BIND_HOST rejected: ${qualifier}`);
  }
  if (mode === 'pilot' && bindHost !== '127.0.0.1') {
    throw new Error('API_BIND_HOST for the controlled pilot must use loopback 127.0.0.1');
  }
  return bindHost;
}

export function resolveCorsOrigin(
  mode: RuntimeMode,
  configured: string | undefined,
): true | false | string[] {
  const origins = (configured ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length > 0) {
    for (const origin of origins) {
      if (origin === '*') throw new Error('CORS_ORIGINS cannot contain a wildcard');
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new Error('CORS_ORIGINS entries must be canonical HTTP(S) origins');
      }
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.pathname !== '/' ||
        parsed.origin !== origin
      ) {
        throw new Error('CORS_ORIGINS entries must be canonical HTTP(S) origins');
      }
      const loopback =
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '[::1]';
      if (
        (mode === 'pilot' || mode === 'production') &&
        parsed.protocol !== 'https:' &&
        !loopback
      ) {
        throw new Error('controlled CORS_ORIGINS must use HTTPS or loopback');
      }
    }
    return origins;
  }
  return mode === 'test';
}

export function resolveRuntimeSettings(env: NodeJS.ProcessEnv = process.env): RuntimeSettings {
  const mode = resolveRuntimeMode(env);
  return Object.freeze({
    mode,
    bindHost: resolveBindHost(mode, env.API_BIND_HOST),
    port: resolvePort(env.PORT),
  });
}
