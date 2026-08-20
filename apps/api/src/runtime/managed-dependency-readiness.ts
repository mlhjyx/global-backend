import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { RuntimeComponentStatus } from './runtime-readiness-registry';
import { RuntimeReadinessContributorRegistry } from './runtime-readiness-registry';
import {
  RuntimeReleaseIdentityService,
  type RuntimeReleaseIdentity,
} from './runtime-release-identity';
import { validateRedisConnectionUrl } from '../tools/redis-rate-limit-store';
import {
  probeJwksDocument,
} from '../auth/jwks-readiness';
import { validateJwksTokenVerifierConfiguration } from '../auth/jwks-token-verifier';
import {
  loadExecutionBudgetJwks,
  validateExecutionBudgetGrantVerifierConfiguration,
  type ExecutionBudgetJwksFetch,
} from '../execution-budget/execution-budget-grant.verifier';

interface RedisProbeClient {
  readonly status: string;
  connect(): Promise<unknown>;
  ping(): Promise<string>;
  disconnect(): void;
}

type RedisProbeFactory = (url: string) => RedisProbeClient;
type GatewayProbeFetch = (
  input: string,
  init: RequestInit,
) => Promise<Pick<Response, 'ok' | 'body'>>;
type BrowserProbe = (executable: string, args: readonly string[]) => Promise<void>;
type ExecutableProbe = (executable: string) => Promise<boolean>;

const execFileAsync = promisify(execFile);
const BROWSER_PATHS = new Set(['/usr/bin/google-chrome', '/usr/bin/chromium']);
const BROWSER_PROBE_ARGS = Object.freeze([
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-component-update',
  '--no-first-run',
  '--no-default-browser-check',
  '--dump-dom',
  'data:text/html,<title>runtime-readiness</title>',
]);

async function defaultExecutableProbe(executable: string): Promise<boolean> {
  try {
    await access(executable, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function checkImagePipelineIsolationReadiness(
  platform: NodeJS.Platform = process.platform,
  probe: ExecutableProbe = defaultExecutableProbe,
): Promise<RuntimeComponentStatus> {
  if (platform !== 'linux') return { status: 'ok' };
  return (await probe('/usr/bin/prlimit'))
    ? { status: 'ok' }
    : { status: 'failed', code: 'IMAGE_PIPELINE_ISOLATION_UNAVAILABLE' };
}

async function defaultBrowserProbe(
  executable: string,
  args: readonly string[],
): Promise<void> {
  await execFileAsync(executable, [...args], {
    timeout: 5_000,
    maxBuffer: 128 * 1024,
    env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' },
  });
}

function loopback(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1'
  );
}

function defaultRedisProbe(url: string): RedisProbeClient {
  return new Redis(url, {
    lazyConnect: true,
    connectTimeout: 1_500,
    commandTimeout: 1_500,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  });
}

export async function checkRedisReadiness(
  env: NodeJS.ProcessEnv,
  factory: RedisProbeFactory = defaultRedisProbe,
): Promise<RuntimeComponentStatus> {
  const raw = env.TOOL_RATE_LIMIT_REDIS_URL ?? env.REDIS_URL;
  if (!raw?.trim()) {
    return { status: 'failed', code: 'REDIS_CONFIG_REQUIRED' };
  }
  let configured: string;
  try {
    configured = validateRedisConnectionUrl(raw);
  } catch {
    return { status: 'failed', code: 'REDIS_CONFIG_INVALID' };
  }
  let client: RedisProbeClient | undefined;
  try {
    client = factory(configured);
    if (client.status === 'wait' || client.status === 'end') await client.connect();
    return (await client.ping()) === 'PONG'
      ? { status: 'ok' }
      : { status: 'failed', code: 'REDIS_UNAVAILABLE' };
  } catch {
    return { status: 'failed', code: 'REDIS_UNAVAILABLE' };
  } finally {
    client?.disconnect();
  }
}

export async function checkAuthJwksReadiness(
  env: NodeJS.ProcessEnv,
): Promise<RuntimeComponentStatus> {
  try {
    const config = validateJwksTokenVerifierConfiguration(env);
    return (await probeJwksDocument(config.jwks.href))
      ? { status: 'ok' }
      : { status: 'failed', code: 'AUTH_JWKS_UNAVAILABLE' };
  } catch {
    return { status: 'failed', code: 'AUTH_JWKS_UNAVAILABLE' };
  }
}

export async function checkExecutionBudgetJwksReadiness(
  env: NodeJS.ProcessEnv,
  fetcher: ExecutionBudgetJwksFetch = fetch,
): Promise<RuntimeComponentStatus> {
  try {
    const config = validateExecutionBudgetGrantVerifierConfiguration(env);
    await loadExecutionBudgetJwks(config, fetcher);
    return { status: 'ok' };
  } catch {
    return {
      status: 'failed',
      code: 'EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE',
    };
  }
}

export async function checkModelGatewayReadiness(
  env: NodeJS.ProcessEnv,
  fetcher: GatewayProbeFetch = fetch,
): Promise<RuntimeComponentStatus> {
  const configured = env.MODEL_GATEWAY_URL?.trim();
  if (!configured || !env.MODEL_GATEWAY_KEY?.trim()) {
    return { status: 'failed', code: 'MODEL_GATEWAY_CONFIG_REQUIRED' };
  }
  let endpoint: URL;
  try {
    const base = new URL(configured);
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      (base.protocol !== 'https:' &&
        !(base.protocol === 'http:' && loopback(base.hostname)))
    ) {
      return { status: 'failed', code: 'MODEL_GATEWAY_CONFIG_INVALID' };
    }
    endpoint = new URL(`${base.pathname.replace(/\/$/, '')}/models`, base.origin);
  } catch {
    return { status: 'failed', code: 'MODEL_GATEWAY_CONFIG_INVALID' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  timeout.unref();
  try {
    const response = await fetcher(endpoint.href, {
      method: 'GET',
      headers: { Authorization: `Bearer ${env.MODEL_GATEWAY_KEY}` },
      redirect: 'error',
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok
      ? { status: 'ok' }
      : { status: 'failed', code: 'MODEL_GATEWAY_UNAVAILABLE' };
  } catch {
    return { status: 'failed', code: 'MODEL_GATEWAY_UNAVAILABLE' };
  } finally {
    clearTimeout(timeout);
  }
}

export function rendererRuntimeIdentity(identity: RuntimeReleaseIdentity): string {
  if (!identity.attested || !/^sha256:[0-9a-f]{64}$/.test(identity.renderer_digest)) {
    throw new Error('RENDERER_IDENTITY_NOT_PROVEN');
  }
  return `site-renderer@${identity.renderer_digest}`;
}

export async function checkBrowserReadiness(
  env: NodeJS.ProcessEnv,
  probe: BrowserProbe = defaultBrowserProbe,
): Promise<RuntimeComponentStatus> {
  const executable = env.CHROME_PATH?.trim() || '/usr/bin/chromium';
  if (!BROWSER_PATHS.has(executable)) {
    return { status: 'failed', code: 'BROWSER_RUNTIME_CONFIG_INVALID' };
  }
  try {
    await probe(executable, BROWSER_PROBE_ARGS);
    return { status: 'ok' };
  } catch {
    return { status: 'failed', code: 'BROWSER_RUNTIME_UNAVAILABLE' };
  }
}

@Injectable()
export class ManagedDependencyReadinessContributors
  implements OnModuleInit, OnModuleDestroy
{
  private unregister: ReadonlyArray<() => void> = [];

  constructor(
    private readonly registry: RuntimeReadinessContributorRegistry,
    private readonly releaseIdentity: RuntimeReleaseIdentityService,
  ) {}

  onModuleInit(): void {
    this.unregister = Object.freeze([
      this.registry.register('redis', () => checkRedisReadiness(process.env)),
      this.registry.register('auth_jwks', () => checkAuthJwksReadiness(process.env)),
      this.registry.register('model_gateway', () =>
        checkModelGatewayReadiness(process.env),
      ),
      this.registry.register('browser', () => checkBrowserReadiness(process.env)),
      this.registry.register('renderer', () => {
        try {
          rendererRuntimeIdentity(this.releaseIdentity.current());
          return { status: 'ok' } as const;
        } catch {
          return { status: 'not_proven', code: 'RENDERER_IDENTITY_NOT_PROVEN' } as const;
        }
      }),
    ]);
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregister) unregister();
    this.unregister = [];
  }
}
