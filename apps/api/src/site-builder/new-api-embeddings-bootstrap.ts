import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const LOCAL_EMBEDDING_MODEL_ALIAS = 'site-builder-bge-m3-local';
export const LOCAL_EMBEDDING_UPSTREAM_MODEL = 'bge-m3';
export const LOCAL_EMBEDDING_CHANNEL_NAME = 'Site Builder Local BGE-M3';
export const LOCAL_EMBEDDING_TOKEN_NAME = 'Site Builder Local Embeddings';
export const LOCAL_EMBEDDING_BASE_URL = 'http://embeddings:11434';
const LOCAL_CHANNEL_KEY = 'ollama-local-no-auth';
const PAGE_SIZE = 100;

type Fetch = typeof fetch;

interface AdminConfig {
  adminBaseUrl: string;
  adminAccessToken: string;
  adminUserId: number;
}

interface Channel {
  id: number;
  name: string;
  status: number;
  type: number;
  base_url?: string;
  models?: string;
  group?: string;
  model_mapping?: string;
}

interface Token {
  id: number;
  name: string;
  status: number;
  expired_time: number;
  unlimited_quota: boolean;
  model_limits_enabled: boolean;
  model_limits: string;
  group?: string;
  cross_group_retry: boolean;
}

interface ApiEnvelope {
  success?: boolean;
  message?: string;
  data?: unknown;
}

export interface ProvisionResult {
  channelId: number;
  tokenId: number;
  apiKey: string;
  createdChannel: boolean;
  createdToken: boolean;
  vectorDimension: number;
}

function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function adminHeaders(config: AdminConfig): Record<string, string> {
  return {
    authorization: `Bearer ${config.adminAccessToken.trim()}`,
    'content-type': 'application/json',
    'new-api-user': String(config.adminUserId),
  };
}

async function requestJson(
  fetchImpl: Fetch,
  url: string,
  init?: RequestInit,
): Promise<ApiEnvelope> {
  const response = await fetchImpl(url, init);
  const parsed = (await response.json().catch(() => undefined)) as ApiEnvelope | undefined;
  if (!response.ok || !parsed || parsed.success === false) {
    const message = typeof parsed?.message === 'string' ? parsed.message.slice(0, 300) : '';
    throw new Error(`New API request failed (${response.status})${message ? `: ${message}` : ''}`);
  }
  return parsed;
}

function pageItems<T>(envelope: ApiEnvelope, label: string): { items: T[]; total: number } {
  if (!envelope.data || typeof envelope.data !== 'object') {
    throw new Error(`New API ${label} list returned no data`);
  }
  const page = envelope.data as { items?: unknown; total?: unknown };
  if (!Array.isArray(page.items)) throw new Error(`New API ${label} list returned invalid items`);
  const total = typeof page.total === 'number' ? page.total : page.items.length;
  return { items: page.items as T[], total };
}

async function listAll<T>(
  config: AdminConfig,
  path: 'channel' | 'token',
  fetchImpl: Fetch,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const envelope = await requestJson(
      fetchImpl,
      `${trimSlash(config.adminBaseUrl)}/api/${path}/?p=${page}&page_size=${PAGE_SIZE}`,
      { headers: adminHeaders(config) },
    );
    const batch = pageItems<T>(envelope, path);
    items.push(...batch.items);
    if (items.length >= batch.total || batch.items.length < PAGE_SIZE) return items;
  }
  throw new Error(`New API ${path} inventory exceeded the bootstrap safety bound`);
}

function splitCsv(value?: string): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function expectedMapping(value?: string): boolean {
  try {
    const parsed = JSON.parse(value ?? '') as Record<string, unknown>;
    return (
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 1 &&
      parsed[LOCAL_EMBEDDING_MODEL_ALIAS] === LOCAL_EMBEDDING_UPSTREAM_MODEL
    );
  } catch {
    return false;
  }
}

function assertChannel(channel: Channel): void {
  const models = splitCsv(channel.models);
  const groups = splitCsv(channel.group);
  if (
    channel.name !== LOCAL_EMBEDDING_CHANNEL_NAME ||
    channel.status !== 1 ||
    channel.type !== 1 ||
    trimSlash(channel.base_url ?? '') !== LOCAL_EMBEDDING_BASE_URL ||
    models.length !== 1 ||
    models[0] !== LOCAL_EMBEDDING_MODEL_ALIAS ||
    groups.length !== 1 ||
    groups[0] !== 'default' ||
    !expectedMapping(channel.model_mapping)
  ) {
    throw new Error(
      `Expected exactly one local channel for ${LOCAL_EMBEDDING_MODEL_ALIAS}; channel ${channel.id} is unsafe or drifted`,
    );
  }
}

function channelPayload() {
  return {
    type: 1,
    key: LOCAL_CHANNEL_KEY,
    status: 1,
    name: LOCAL_EMBEDDING_CHANNEL_NAME,
    base_url: LOCAL_EMBEDDING_BASE_URL,
    models: LOCAL_EMBEDDING_MODEL_ALIAS,
    group: 'default',
    test_model: LOCAL_EMBEDDING_MODEL_ALIAS,
    model_mapping: JSON.stringify({
      [LOCAL_EMBEDDING_MODEL_ALIAS]: LOCAL_EMBEDDING_UPSTREAM_MODEL,
    }),
  };
}

async function ensureChannel(
  config: AdminConfig,
  fetchImpl: Fetch,
): Promise<{ channel: Channel; created: boolean }> {
  let channels = await listAll<Channel>(config, 'channel', fetchImpl);
  let advertised = channels.filter((channel) =>
    splitCsv(channel.models).includes(LOCAL_EMBEDDING_MODEL_ALIAS),
  );
  if (advertised.length > 1) {
    throw new Error(`Expected exactly one local channel for ${LOCAL_EMBEDDING_MODEL_ALIAS}`);
  }
  if (advertised.length === 1) {
    assertChannel(advertised[0]);
    return { channel: advertised[0], created: false };
  }

  const named = channels.filter((channel) =>
    [LOCAL_EMBEDDING_CHANNEL_NAME, 'Local BGE-M3 Embeddings'].includes(channel.name),
  );
  if (named.length > 1 || (named[0] && trimSlash(named[0].base_url ?? '') !== LOCAL_EMBEDDING_BASE_URL)) {
    throw new Error(`Expected exactly one local channel for ${LOCAL_EMBEDDING_MODEL_ALIAS}`);
  }

  let created = false;
  if (named[0]) {
    if (named[0].status !== 1) {
      throw new Error(`Local embedding channel ${named[0].id} is disabled; refusing to override status`);
    }
    const payload = channelPayload();
    delete (payload as { status?: number }).status;
    delete (payload as { key?: string }).key;
    await requestJson(fetchImpl, `${trimSlash(config.adminBaseUrl)}/api/channel/`, {
      method: 'PUT',
      headers: adminHeaders(config),
      body: JSON.stringify({ id: named[0].id, ...payload }),
    });
  } else {
    await requestJson(fetchImpl, `${trimSlash(config.adminBaseUrl)}/api/channel/`, {
      method: 'POST',
      headers: adminHeaders(config),
      body: JSON.stringify({ mode: 'single', channel: channelPayload() }),
    });
    created = true;
  }

  channels = await listAll<Channel>(config, 'channel', fetchImpl);
  advertised = channels.filter((channel) =>
    splitCsv(channel.models).includes(LOCAL_EMBEDDING_MODEL_ALIAS),
  );
  if (advertised.length !== 1) {
    throw new Error(`Expected exactly one local channel for ${LOCAL_EMBEDDING_MODEL_ALIAS}`);
  }
  assertChannel(advertised[0]);
  return { channel: advertised[0], created };
}

function tokenIsRestricted(token: Token): boolean {
  return (
    token.status === 1 &&
    token.expired_time === -1 &&
    token.unlimited_quota === true &&
    token.model_limits_enabled === true &&
    token.model_limits === LOCAL_EMBEDDING_MODEL_ALIAS &&
    (token.group ?? '') === '' &&
    token.cross_group_retry === false
  );
}

function tokenPayload() {
  return {
    name: LOCAL_EMBEDDING_TOKEN_NAME,
    expired_time: -1,
    remain_quota: 0,
    unlimited_quota: true,
    model_limits_enabled: true,
    model_limits: LOCAL_EMBEDDING_MODEL_ALIAS,
    allow_ips: '',
    group: '',
    cross_group_retry: false,
  };
}

async function ensureToken(
  config: AdminConfig,
  fetchImpl: Fetch,
): Promise<{ token: Token; apiKey: string; created: boolean }> {
  let tokens = await listAll<Token>(config, 'token', fetchImpl);
  let matches = tokens.filter((token) => token.name === LOCAL_EMBEDDING_TOKEN_NAME);
  if (matches.length > 1) throw new Error(`Duplicate New API token '${LOCAL_EMBEDDING_TOKEN_NAME}'`);

  let created = false;
  if (matches.length === 0) {
    await requestJson(fetchImpl, `${trimSlash(config.adminBaseUrl)}/api/token/`, {
      method: 'POST',
      headers: adminHeaders(config),
      body: JSON.stringify(tokenPayload()),
    });
    created = true;
  } else if (!tokenIsRestricted(matches[0])) {
    if (matches[0].status !== 1) {
      throw new Error(`Dedicated embedding token ${matches[0].id} is disabled`);
    }
    await requestJson(fetchImpl, `${trimSlash(config.adminBaseUrl)}/api/token/`, {
      method: 'PUT',
      headers: adminHeaders(config),
      body: JSON.stringify({ id: matches[0].id, ...tokenPayload() }),
    });
  }

  tokens = await listAll<Token>(config, 'token', fetchImpl);
  matches = tokens.filter((token) => token.name === LOCAL_EMBEDDING_TOKEN_NAME);
  if (matches.length !== 1 || !tokenIsRestricted(matches[0])) {
    throw new Error(`Dedicated embedding token is missing or not limited to ${LOCAL_EMBEDDING_MODEL_ALIAS}`);
  }
  const envelope = await requestJson(
    fetchImpl,
    `${trimSlash(config.adminBaseUrl)}/api/token/${matches[0].id}/key`,
    { method: 'POST', headers: adminHeaders(config) },
  );
  const rawKey = (envelope.data as { key?: unknown } | undefined)?.key;
  if (typeof rawKey !== 'string' || rawKey.trim() === '') {
    throw new Error('New API returned no key for the dedicated embedding token');
  }
  const key = rawKey.startsWith('sk-') ? rawKey : `sk-${rawKey}`;
  return { token: matches[0], apiKey: key, created };
}

async function verifyPublicRoute(
  config: AdminConfig,
  apiKey: string,
  fetchImpl: Fetch,
): Promise<number> {
  const baseUrl = `${trimSlash(config.adminBaseUrl)}/v1`;
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  const modelsResponse = await fetchImpl(`${baseUrl}/models`, { headers });
  const modelsBody = (await modelsResponse.json().catch(() => undefined)) as
    | { data?: { id?: unknown }[] }
    | undefined;
  const models = (modelsBody?.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === 'string')
    .sort();
  if (!modelsResponse.ok || models.length !== 1 || models[0] !== LOCAL_EMBEDDING_MODEL_ALIAS) {
    throw new Error(`Dedicated embedding token must expose only ${LOCAL_EMBEDDING_MODEL_ALIAS}`);
  }

  const embeddingsResponse = await fetchImpl(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: LOCAL_EMBEDDING_MODEL_ALIAS, input: ['gateway readiness'] }),
  });
  const embeddingsBody = (await embeddingsResponse.json().catch(() => undefined)) as
    | { data?: { index?: unknown; embedding?: unknown }[] }
    | undefined;
  const vector = embeddingsBody?.data?.[0]?.embedding;
  if (
    !embeddingsResponse.ok ||
    !Array.isArray(vector) ||
    vector.length !== 1024 ||
    !vector.every((value) => typeof value === 'number' && Number.isFinite(value))
  ) {
    throw new Error('Local embedding readiness check did not return one finite 1024-dimensional vector');
  }
  return vector.length;
}

export async function provisionLocalEmbeddingGateway(
  config: AdminConfig,
  fetchImpl: Fetch = fetch,
): Promise<ProvisionResult> {
  if (!config.adminAccessToken.trim() || !Number.isInteger(config.adminUserId)) {
    throw new Error('New API admin access token and numeric user id are required');
  }
  const channel = await ensureChannel(config, fetchImpl);
  const token = await ensureToken(config, fetchImpl);
  const vectorDimension = await verifyPublicRoute(config, token.apiKey, fetchImpl);
  return {
    channelId: channel.channel.id,
    tokenId: token.token.id,
    apiKey: token.apiKey,
    createdChannel: channel.created,
    createdToken: token.created,
    vectorDimension,
  };
}

export async function writeEmbeddingEnv(
  path: string,
  result: Pick<ProvisionResult, 'apiKey'>,
  gatewayUrl: string,
): Promise<void> {
  const source = await readFile(path, 'utf8');
  const output = mergeEmbeddingEnv(source, result, gatewayUrl);
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(output, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function mergeEmbeddingEnv(
  source: string,
  result: Pick<ProvisionResult, 'apiKey'>,
  gatewayUrl: string,
): string {
  const desired: Record<string, string> = {
    EMBEDDINGS_URL: `${trimSlash(gatewayUrl).replace(/\/v1$/, '')}/v1`,
    EMBEDDINGS_API_KEY: result.apiKey,
    EMBEDDINGS_MODEL: LOCAL_EMBEDDING_MODEL_ALIAS,
    EMBEDDINGS_DIM: '1024',
  };
  const seen = new Set<string>();
  const lines = source.split('\n').map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !(match[1] in desired)) return line;
    seen.add(match[1]);
    return `${match[1]}=${desired[match[1]]}`;
  });
  for (const [key, value] of Object.entries(desired)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  return lines.join('\n');
}
