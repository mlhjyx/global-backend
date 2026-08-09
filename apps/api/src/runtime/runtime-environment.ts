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

function resolveMode(env: NodeJS.ProcessEnv): RuntimeMode {
  const declared = env.APP_ENVIRONMENT?.trim();
  if (declared && !ALLOWED_MODES.has(declared as RuntimeMode)) {
    throw new Error(`APP_ENVIRONMENT must be one of: ${[...ALLOWED_MODES].join(', ')}`);
  }
  if (env.NODE_ENV === 'production' && declared && declared !== 'production' && declared !== 'pilot') {
    throw new Error('NODE_ENV=production cannot be downgraded by APP_ENVIRONMENT');
  }
  if (declared) return declared as RuntimeMode;
  if (env.NODE_ENV === 'production') return 'production';
  if (env.NODE_ENV === 'test') return 'test';
  return 'development';
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
  if (bindHost === '0.0.0.0' || bindHost === '::') {
    const qualifier = mode === 'pilot' ? 'controlled pilot requires loopback' : 'wildcard binds are forbidden';
    throw new Error(`API_BIND_HOST rejected: ${qualifier}`);
  }
  if (mode === 'pilot' && bindHost !== '127.0.0.1') {
    throw new Error('API_BIND_HOST for the controlled pilot must use loopback 127.0.0.1');
  }
  return bindHost;
}

export function resolveRuntimeSettings(env: NodeJS.ProcessEnv = process.env): RuntimeSettings {
  const mode = resolveMode(env);
  return Object.freeze({
    mode,
    bindHost: resolveBindHost(mode, env.API_BIND_HOST),
    port: resolvePort(env.PORT),
  });
}
