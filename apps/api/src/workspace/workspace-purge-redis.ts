import { createHash } from 'node:crypto';
import Redis, { type RedisOptions } from 'ioredis';

const REDIS_TIMEOUT_MS = 2_000;
const SCAN_COUNT = 200;
const MAX_SCAN_ITERATIONS = 10_000;

export interface WorkspacePurgeRedisClient {
  connect(): Promise<unknown>;
  unlink(...keys: string[]): Promise<number>;
  del(...keys: string[]): Promise<number>;
  scan(
    cursor: string | number,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
  quit(): Promise<unknown>;
  disconnect(): void;
  on(event: 'error', listener: () => void): unknown;
}

export type WorkspacePurgeRedisFactory = (
  url: string,
  options: RedisOptions,
) => WorkspacePurgeRedisClient;

export function workspaceHttpThrottleKeys(
  workspaceId: string,
  throttlerName = 'default',
): [string, string] {
  const digest = createHash('sha256')
    .update(JSON.stringify([throttlerName, `ws:${workspaceId}`]))
    .digest('hex');
  const prefix = `http-throttle:v1:{${digest}}`;
  return [`${prefix}:hits`, `${prefix}:state`];
}

function configuredRedisUrls(env: NodeJS.ProcessEnv): string[] {
  const urls = new Set<string>();
  for (const raw of [env.REDIS_URL, env.TOOL_RATE_LIMIT_REDIS_URL]) {
    const trimmed = raw?.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'redis:' || parsed.protocol === 'rediss:') {
        urls.add(trimmed);
      }
    } catch {
      // Ignore malformed optional URLs; readiness checks enforce valid config.
    }
  }
  return [...urls];
}

async function unlinkOrDel(
  client: WorkspacePurgeRedisClient,
  keys: readonly string[],
): Promise<number> {
  if (keys.length === 0) return 0;
  try {
    return await client.unlink(...keys);
  } catch {
    return await client.del(...keys);
  }
}

export async function purgeWorkspaceRedisKeysWithClient(
  client: WorkspacePurgeRedisClient,
  workspaceId: string,
): Promise<number> {
  let deleted = 0;
  deleted += await unlinkOrDel(client, workspaceHttpThrottleKeys(workspaceId));

  const pattern = `ws:${workspaceId}:*`;
  let cursor = '0';
  for (let iteration = 0; iteration < MAX_SCAN_ITERATIONS; iteration += 1) {
    const [nextCursor, keys] = await client.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      SCAN_COUNT,
    );
    if (keys.length > 0) {
      deleted += await unlinkOrDel(client, keys);
    }
    cursor = nextCursor;
    if (cursor === '0') break;
  }
  return deleted;
}

export async function purgeWorkspaceRedisKeys(
  workspaceId: string,
  env: NodeJS.ProcessEnv = process.env,
  factory: WorkspacePurgeRedisFactory = (url, options) => new Redis(url, options),
): Promise<number> {
  const urls = configuredRedisUrls(env);
  if (urls.length === 0) return 0;

  let totalDeleted = 0;
  for (const url of urls) {
    const client = factory(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: REDIS_TIMEOUT_MS,
      commandTimeout: REDIS_TIMEOUT_MS,
      ...(url.startsWith('rediss:') ? { tls: { rejectUnauthorized: true } } : {}),
    });
    client.on('error', () => {});
    try {
      await client.connect();
      totalDeleted += await purgeWorkspaceRedisKeysWithClient(client, workspaceId);
    } finally {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }
  }
  return totalDeleted;
}
