import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
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
import { probeJwksDocument } from '../auth/jwks-readiness';
import { validateJwksTokenVerifierConfiguration } from '../auth/jwks-token-verifier';
import { ExecutionBudgetAuthorityRepository } from '../execution-budget/execution-budget-authority.repository';
import {
  EXECUTION_BUDGET_PLATFORM_PURPOSES,
  type ExecutionBudgetPurpose,
} from '../execution-budget/execution-budget-authority.types';
import {
  loadExecutionBudgetJwks,
  validateExecutionBudgetGrantVerifierConfiguration,
  type ExecutionBudgetJwksFetch,
} from '../execution-budget/execution-budget-grant.verifier';
import { S3GenericOperationArtifactStore } from '../durable-results/artifact/generic-operation-artifact.store';
import { checkMinioAllVersionLifecycle } from '../durable-results/artifact/generic-operation-artifact.minio-lifecycle';

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
type BrowserProbe = (
  executable: string,
  args: readonly string[],
) => Promise<void>;
type ExecutableProbe = (executable: string) => Promise<boolean>;

type GenericArtifactStorageConfig = Readonly<{
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}>;

interface GenericArtifactStorageProbe {
  checkReadiness(): Promise<
    | Readonly<{ status: 'ready' }>
    | Readonly<{
        status: 'not_ready';
        code: 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE';
      }>
  >;
  checkLifecycleExtension(): Promise<boolean>;
  destroy(): void;
}

type GenericArtifactStorageProbeFactory = (
  config: GenericArtifactStorageConfig,
) => GenericArtifactStorageProbe;

type PlatformAuthorityReadinessState =
  | 'active'
  | 'missing'
  | 'expired'
  | 'revoked'
  | 'exhausted'
  | 'not_yet_valid'
  | 'invalid';

type PlatformAuthorityReadinessRow = Readonly<{
  purpose: string;
  state: string;
}>;

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
const PLATFORM_AUTHORITY_STATES = new Set<PlatformAuthorityReadinessState>([
  'active',
  'missing',
  'expired',
  'revoked',
  'exhausted',
  'not_yet_valid',
  'invalid',
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

function genericArtifactStorageConfig(
  env: NodeJS.ProcessEnv,
): GenericArtifactStorageConfig {
  const endpointValue = env.GENERIC_OPERATION_ARTIFACT_S3_ENDPOINT?.trim();
  const bucket = env.GENERIC_OPERATION_ARTIFACT_S3_BUCKET?.trim();
  const region = env.GENERIC_OPERATION_ARTIFACT_S3_REGION?.trim();
  const accessKeyId = env.GENERIC_OPERATION_ARTIFACT_S3_ACCESS_KEY?.trim();
  const secretAccessKey = env.GENERIC_OPERATION_ARTIFACT_S3_SECRET_KEY?.trim();
  const forcePathStyleValue =
    env.GENERIC_OPERATION_ARTIFACT_S3_FORCE_PATH_STYLE?.trim();
  if (
    !endpointValue ||
    !bucket ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    !region ||
    region.length > 64 ||
    !/^[a-z0-9][a-z0-9-]*$/.test(region) ||
    !accessKeyId ||
    accessKeyId.length > 128 ||
    !secretAccessKey ||
    secretAccessKey.length > 256 ||
    (forcePathStyleValue !== 'true' && forcePathStyleValue !== 'false')
  ) {
    throw new Error('GENERIC_OPERATION_ARTIFACT_STORAGE_CONFIG_INVALID');
  }
  const endpoint = new URL(endpointValue);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && loopback(endpoint.hostname)))
  ) {
    throw new Error('GENERIC_OPERATION_ARTIFACT_STORAGE_CONFIG_INVALID');
  }
  return Object.freeze({
    endpoint: endpoint.href,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: forcePathStyleValue === 'true',
  });
}

function defaultGenericArtifactStorageProbe(
  config: GenericArtifactStorageConfig,
): GenericArtifactStorageProbe {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    requestHandler: {
      connectionTimeout: 1_500,
      requestTimeout: 2_500,
    },
  });
  const store = new S3GenericOperationArtifactStore({
    bucket: config.bucket,
    client,
  });
  return Object.freeze({
    checkReadiness: () => store.checkReadiness(),
    checkLifecycleExtension: () => checkMinioAllVersionLifecycle(config),
    destroy: () => client.destroy(),
  });
}

export async function checkGenericArtifactStorageReadiness(
  env: NodeJS.ProcessEnv,
  factory: GenericArtifactStorageProbeFactory = defaultGenericArtifactStorageProbe,
): Promise<RuntimeComponentStatus> {
  let probe: GenericArtifactStorageProbe | undefined;
  try {
    probe = factory(genericArtifactStorageConfig(env));
    const result = await probe.checkReadiness();
    const lifecycleExtensionReady =
      result.status === 'ready' && (await probe.checkLifecycleExtension());
    return lifecycleExtensionReady
      ? { status: 'ok' }
      : {
          status: 'failed',
          code: 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
        };
  } catch {
    return {
      status: 'failed',
      code: 'GENERIC_OPERATION_ARTIFACT_STORAGE_UNAVAILABLE',
    };
  } finally {
    probe?.destroy();
  }
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
    if (client.status === 'wait' || client.status === 'end')
      await client.connect();
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

function platformAuthorityCode(
  purpose: ExecutionBudgetPurpose,
  state: Exclude<PlatformAuthorityReadinessState, 'active'>,
): string {
  const purposeCode = purpose.replaceAll('.', '_').toUpperCase();
  return `PLATFORM_BUDGET_AUTHORITY_${purposeCode}_${state.toUpperCase()}`;
}

export async function checkPlatformBudgetAuthorityReadiness(
  repository:
    | Pick<
        ExecutionBudgetAuthorityRepository,
        'inspectPlatformAuthorityFreshness'
      >
    | undefined,
  now: Date = new Date(),
): Promise<RuntimeComponentStatus> {
  if (!repository) {
    return {
      status: 'failed',
      code: 'PLATFORM_BUDGET_AUTHORITY_WRITER_UNAVAILABLE',
    };
  }
  try {
    const freshness = await repository.inspectPlatformAuthorityFreshness(now);
    if (freshness.status === 'writer_unavailable') {
      return {
        status: 'failed',
        code: 'PLATFORM_BUDGET_AUTHORITY_WRITER_UNAVAILABLE',
      };
    }
    if (freshness.status !== 'available') {
      return {
        status: 'failed',
        code: 'PLATFORM_BUDGET_AUTHORITY_UNAVAILABLE',
      };
    }
    const rows: readonly PlatformAuthorityReadinessRow[] = freshness.rows;
    if (rows.length !== EXECUTION_BUDGET_PLATFORM_PURPOSES.length) {
      throw new Error('PLATFORM_AUTHORITY_READINESS_SHAPE_INVALID');
    }
    const states = new Map<
      ExecutionBudgetPurpose,
      PlatformAuthorityReadinessState
    >();
    for (const row of rows) {
      if (
        !EXECUTION_BUDGET_PLATFORM_PURPOSES.includes(
          row.purpose as (typeof EXECUTION_BUDGET_PLATFORM_PURPOSES)[number],
        ) ||
        !PLATFORM_AUTHORITY_STATES.has(
          row.state as PlatformAuthorityReadinessState,
        ) ||
        states.has(row.purpose as ExecutionBudgetPurpose)
      ) {
        throw new Error('PLATFORM_AUTHORITY_READINESS_SHAPE_INVALID');
      }
      states.set(
        row.purpose as ExecutionBudgetPurpose,
        row.state as PlatformAuthorityReadinessState,
      );
    }
    for (const purpose of EXECUTION_BUDGET_PLATFORM_PURPOSES) {
      const state = states.get(purpose);
      if (!state) throw new Error('PLATFORM_AUTHORITY_READINESS_SHAPE_INVALID');
      if (state !== 'active') {
        return {
          status: 'failed',
          code: platformAuthorityCode(purpose, state),
        };
      }
    }
    return { status: 'ok' };
  } catch {
    return { status: 'failed', code: 'PLATFORM_BUDGET_AUTHORITY_UNAVAILABLE' };
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
    endpoint = new URL(
      `${base.pathname.replace(/\/$/, '')}/models`,
      base.origin,
    );
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

export function rendererRuntimeIdentity(
  identity: RuntimeReleaseIdentity,
): string {
  if (
    !identity.attested ||
    !/^sha256:[0-9a-f]{64}$/.test(identity.renderer_digest)
  ) {
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
      this.registry.register('auth_jwks', () =>
        checkAuthJwksReadiness(process.env),
      ),
      this.registry.register('execution_budget_jwks', () =>
        checkExecutionBudgetJwksReadiness(process.env),
      ),
      this.registry.register('generic_artifact_storage', () =>
        checkGenericArtifactStorageReadiness(process.env),
      ),
      this.registry.register('model_gateway', () =>
        checkModelGatewayReadiness(process.env),
      ),
      this.registry.register('browser', () =>
        checkBrowserReadiness(process.env),
      ),
      this.registry.register('renderer', () => {
        try {
          rendererRuntimeIdentity(this.releaseIdentity.current());
          return { status: 'ok' } as const;
        } catch {
          return {
            status: 'not_proven',
            code: 'RENDERER_IDENTITY_NOT_PROVEN',
          } as const;
        }
      }),
    ]);
  }

  onModuleDestroy(): void {
    for (const unregister of this.unregister) unregister();
    this.unregister = [];
  }
}

@Injectable()
export class ExecutionBudgetAuthorityReadinessContributors
  implements OnModuleInit, OnModuleDestroy
{
  private unregister?: () => void;

  constructor(
    private readonly registry: RuntimeReadinessContributorRegistry,
    private readonly repository: ExecutionBudgetAuthorityRepository,
  ) {}

  onModuleInit(): void {
    this.unregister = this.registry.register('platform_budget_authority', () =>
      checkPlatformBudgetAuthorityReadiness(this.repository),
    );
  }

  onModuleDestroy(): void {
    this.unregister?.();
    this.unregister = undefined;
  }
}
