import { createHash } from 'node:crypto';
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';
import {
  CHANNEL_MANIFEST_CONTACT_FIELD_KEYS,
  CHANNEL_MANIFEST_FIELD_KEYS,
  CHANNEL_MANIFEST_SCHEMA,
  CHANNEL_MANIFEST_VERSION,
  type ChannelManifestDocument,
} from '@global/contracts';
import { parseJsonPath } from './json-path';

/**
 * channel-manifest/v1 服务端校验（章节 §6.3.3「校验流程（保存时全链路）」）：
 *   1. JSON Schema（Ajv 2020-12）→ CHANNEL_MANIFEST_INVALID + instancePath 列表；
 *   2. 语义校验：字段键白名单、联系人字段仅详情模式、allowedHosts 覆盖 baseUrl、
 *      危险静态头拒绝、robotsPolicy=C 拒绝、JSONPath/regex 可编译；
 *   3. manifest_sha256 = sha256(canonicalJson(manifest))，运行/审计引用该哈希。
 * 过渡兼容：历史 17 行只有 config，无 manifest —— configToManifest 把它们升级成等价 manifest，
 * 保证语义不变（读路径双解析）。
 */

export interface ChannelManifestIssue {
  readonly path: string;
  readonly message: string;
}

export class ChannelManifestError extends Error {
  readonly code = 'CHANNEL_MANIFEST_INVALID';
  readonly issues: ChannelManifestIssue[];

  constructor(issues: ChannelManifestIssue[]) {
    super(issues.length > 0 ? `channel manifest invalid: ${issues[0]!.path} ${issues[0]!.message}` : 'channel manifest invalid');
    this.name = 'ChannelManifestError';
    this.issues = issues;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(CHANNEL_MANIFEST_SCHEMA as unknown as object);

function schemaIssuePath(error: ErrorObject): string {
  const base = error.instancePath || '';
  if (error.keyword === 'required') {
    const missing = (error.params as { missingProperty?: string }).missingProperty;
    return missing ? `${base}/${missing}` : base || '/';
  }
  if (error.keyword === 'additionalProperties') {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty;
    return extra ? `${base}/${extra}` : base || '/';
  }
  if (error.keyword === 'oneOf' && Array.isArray((error as { schemaPath?: string }).schemaPath)) {
    return base || '/';
  }
  return base || '/';
}

const FORBIDDEN_STATIC_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'api-key',
]);

const BANNED_AUTH_HEADER_NAMES = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

function hostMatches(host: string, pattern: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2);
    return normalizedHost.endsWith(`.${suffix}`) && normalizedHost.length > suffix.length + 1;
  }
  return normalizedHost === normalizedPattern;
}

export function hostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  return allowedHosts.some((pattern) => hostMatches(host, pattern));
}

/** 语义校验 + 默认值：返回归一化后的 manifest（auth/pagination 空值显式化）。 */
export function parseChannelManifest(raw: unknown): ChannelManifestDocument {
  if (!validateSchema(raw)) {
    const issues = (validateSchema.errors ?? []).map((error) => ({
      path: schemaIssuePath(error),
      message: error.message ?? 'invalid',
    }));
    throw new ChannelManifestError(issues);
  }
  const manifest = structuredClone(raw) as ChannelManifestDocument;
  const issues: ChannelManifestIssue[] = [];

  const baseUrlHost = new URL(manifest.transport.baseUrl).hostname;
  if (!manifest.transport.allowedHosts || manifest.transport.allowedHosts.length === 0) {
    manifest.transport.allowedHosts = [baseUrlHost];
  }
  if (!hostAllowed(baseUrlHost, manifest.transport.allowedHosts)) {
    issues.push({ path: '/transport/allowedHosts', message: `baseUrl host ${baseUrlHost} must be covered by allowedHosts` });
  }
  manifest.transport.method ??= 'GET';
  manifest.transport.timeoutMs ??= 15_000;
  manifest.transport.maxResponseBytes ??= 5_242_880;

  for (const name of Object.keys(manifest.transport.headers ?? {})) {
    if (FORBIDDEN_STATIC_HEADERS.has(name.toLowerCase())) {
      issues.push({
        path: `/transport/headers/${name}`,
        message: 'credentials must go through auth (Authorization/Cookie/X-Api-Key are forbidden static headers)',
      });
    }
  }

  if (manifest.auth === undefined) manifest.auth = { type: 'none' };
  if (manifest.auth.type === 'apiKey' || manifest.auth.type === 'bearer' || manifest.auth.type === 'header') {
    const inTarget = manifest.auth.in ?? 'header';
    if (manifest.auth.name === undefined) {
      if (inTarget === 'query' || manifest.auth.type === 'header') {
        issues.push({ path: '/auth/name', message: `${manifest.auth.type} with in=${inTarget} requires an explicit name` });
      } else {
        manifest.auth.name = 'Authorization';
      }
    } else if (inTarget === 'header' && BANNED_AUTH_HEADER_NAMES.has(manifest.auth.name.toLowerCase())) {
      issues.push({ path: '/auth/name', message: `injecting credentials into ${manifest.auth.name} is forbidden` });
    }
    manifest.auth.in = inTarget;
  }

  if (manifest.pagination === undefined) manifest.pagination = { type: 'none' };

  const mappedKeys = Object.keys(manifest.fieldMapping ?? {});
  if (manifest.fieldMapping) {
    for (const key of mappedKeys) {
      if (!(CHANNEL_MANIFEST_FIELD_KEYS as readonly string[]).includes(key)) {
        issues.push({ path: `/fieldMapping/${key}`, message: `unknown channel field (${CHANNEL_MANIFEST_FIELD_KEYS.join(', ')})` });
        continue;
      }
      try {
        parseJsonPath(manifest.fieldMapping[key as keyof typeof manifest.fieldMapping]!);
      } catch {
        issues.push({ path: `/fieldMapping/${key}`, message: 'unsupported JSONPath expression' });
      }
    }
    const usesContact = mappedKeys.some((key) => (CHANNEL_MANIFEST_CONTACT_FIELD_KEYS as readonly string[]).includes(key));
    if (usesContact && manifest.records?.detail?.enabled !== true) {
      for (const key of mappedKeys) {
        if ((CHANNEL_MANIFEST_CONTACT_FIELD_KEYS as readonly string[]).includes(key)) {
          issues.push({ path: `/fieldMapping/${key}`, message: 'contact fields require records.detail.enabled=true (detail-page mode)' });
        }
      }
    }
  }

  if (manifest.records) {
    try {
      parseJsonPath(manifest.records.itemsPath);
    } catch {
      issues.push({ path: '/records/itemsPath', message: 'unsupported JSONPath expression' });
    }
    if (manifest.records.detail?.urlPath) {
      try {
        parseJsonPath(manifest.records.detail.urlPath);
      } catch {
        issues.push({ path: '/records/detail/urlPath', message: 'unsupported JSONPath expression' });
      }
    }
  }

  if (manifest.pagination.type === 'cursor' || manifest.pagination.type === 'link') {
    const path = manifest.pagination.type === 'cursor' ? manifest.pagination.cursorPath : manifest.pagination.nextLinkPath;
    try {
      parseJsonPath(path);
    } catch {
      issues.push({
        path: manifest.pagination.type === 'cursor' ? '/pagination/cursorPath' : '/pagination/nextLinkPath',
        message: 'unsupported JSONPath expression',
      });
    }
  }

  if (manifest.governance?.robotsPolicy === 'C') {
    issues.push({ path: '/governance/robotsPolicy', message: 'robotsPolicy C (do not crawl) is refused at save time' });
  }

  for (const [index, entry] of (manifest.transforms?.regexStrip ?? []).entries()) {
    if (entry.flags && !/^[dgimsuy]{0,4}$/u.test(entry.flags)) {
      issues.push({ path: `/transforms/regexStrip/${index}/flags`, message: 'invalid regex flags' });
      continue;
    }
    try {
      new RegExp(entry.pattern, entry.flags ?? '');
    } catch {
      issues.push({ path: `/transforms/regexStrip/${index}/pattern`, message: 'regexStrip pattern does not compile' });
    }
  }

  if (manifest.crawl) {
    for (const key of Object.keys(manifest.crawl.detail?.fields ?? {})) {
      if (!(CHANNEL_MANIFEST_FIELD_KEYS as readonly string[]).includes(key)) {
        issues.push({ path: `/crawl/detail/fields/${key}`, message: 'unknown channel field' });
      }
    }
    const usesContact = Object.keys(manifest.crawl.detail?.fields ?? {}).some((key) =>
      (CHANNEL_MANIFEST_CONTACT_FIELD_KEYS as readonly string[]).includes(key),
    );
    if (usesContact && (manifest.crawl.detail?.enabled !== true || !manifest.crawl.list.itemUrlSelector)) {
      issues.push({
        path: '/crawl/detail/fields',
        message: 'contact fields require crawl.detail.enabled=true and crawl.list.itemUrlSelector (detail-page mode)',
      });
    }
  }

  if (issues.length > 0) throw new ChannelManifestError(issues);
  return manifest;
}

/** 稳定序列化：对象键递归排序、无空白；数组顺序保留。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function manifestSha256(manifest: unknown): string {
  return createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex');
}

export function deriveAllowedHosts(manifest: ChannelManifestDocument): string[] {
  return [...(manifest.transport.allowedHosts ?? [new URL(manifest.transport.baseUrl).hostname])];
}

export interface AuthRefSlot {
  readonly slot: 'secretRef' | 'usernameRef' | 'passwordRef' | 'clientIdRef' | 'clientSecretRef';
  readonly ref: string;
}

/** 采集 manifest.auth 的引用（冗余存 source_channel.auth_ref；执行仍以 manifest 内引用为准）。 */
export function collectAuthRefs(auth: ChannelManifestDocument['auth']): AuthRefSlot[] {
  if (!auth) return [];
  // switch 对「联合字面量判别式」（apiKey|bearer|header 共用一支）能正确收窄。
  switch (auth.type) {
    case 'none':
      return [];
    case 'apiKey':
    case 'bearer':
    case 'header':
      return [{ slot: 'secretRef', ref: auth.secretRef }];
    case 'basic':
      return [
        { slot: 'usernameRef', ref: auth.usernameRef },
        { slot: 'passwordRef', ref: auth.passwordRef },
      ];
    case 'oauth2_client_credentials':
      return [
        { slot: 'clientIdRef', ref: auth.clientIdRef },
        { slot: 'clientSecretRef', ref: auth.clientSecretRef },
      ];
  }
}

/**
 * 历史 config → 等价 manifest（只支持会话语义完整的 crawl 形态）。
 * api 的 `{adapter}` 与 import 的 `{columns}` 没有 manifest 语义，返回 null。
 */
export function configToManifest(mode: string, config: unknown): ChannelManifestDocument | null {
  if (mode !== 'crawl' || !config || typeof config !== 'object' || Array.isArray(config)) return null;
  const record = config as {
    list?: { url?: unknown; maxPages?: unknown; itemSelector?: unknown; itemUrlSelector?: unknown; pageParam?: unknown };
    detail?: { enabled?: unknown; fields?: unknown };
  };
  if (!record.list || typeof record.list.url !== 'string') return null;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(record.list.url.replace('{page}', '1'));
  } catch {
    return null;
  }
  if (parsedUrl.protocol !== 'https:') return null;
  const maxPages = typeof record.list.maxPages === 'number' ? record.list.maxPages : 1;
  const pageParam = typeof record.list.pageParam === 'string' ? record.list.pageParam : 'page';
  const detailFields: Record<string, string> = {};
  if (record.detail && typeof record.detail.enabled === 'boolean' && record.detail.enabled && record.detail.fields && typeof record.detail.fields === 'object') {
    for (const [key, value] of Object.entries(record.detail.fields as Record<string, unknown>)) {
      if (typeof value === 'string') detailFields[key] = value;
    }
  }
  const manifest = {
    meta: {
      name: 'legacy-crawl-config',
      version: 1,
      category: 'other',

    },
    transport: {
      baseUrl: `${parsedUrl.protocol}//${parsedUrl.host}`,
      responseType: 'html',
      allowedHosts: [parsedUrl.hostname],
    },
    auth: { type: 'none' },
    pagination: {
      type: 'page',
      pageParam,
      startPage: 1,
      maxPages: Math.max(1, Math.min(100, Math.trunc(maxPages))),
    },
    crawl: {
      list: {
        url: record.list.url,
        ...(typeof record.list.itemSelector === 'string' ? { itemSelector: record.list.itemSelector } : { itemSelector: 'body' }),
        ...(typeof record.list.itemUrlSelector === 'string' ? { itemUrlSelector: record.list.itemUrlSelector } : {}),
        ...(typeof record.list.pageParam === 'string' ? { pageParam: record.list.pageParam } : {}),
        maxPages: Math.max(1, Math.min(100, Math.trunc(maxPages))),
      },
      detail: {
        enabled: record.detail?.enabled === true,
        ...(Object.keys(detailFields).length > 0 ? { fields: detailFields } : {}),
      },
    },
  } as unknown as ChannelManifestDocument;
  return manifest;
}

export { CHANNEL_MANIFEST_VERSION };
