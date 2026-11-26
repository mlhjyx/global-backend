import type { ChannelManifestDocument } from '@global/contracts';
import {
  CHANNEL_RUN_MAX_PAGES,
  type ChannelCrawlConfig,
} from './channel-config';
import {
  ChannelManifestError,
  collectAuthRefs,
  manifestSha256,
} from './connector/channel-manifest';

export interface ManifestColumnsResult {
  readonly mode: 'api' | 'crawl';
  readonly config: ChannelCrawlConfig | { adapter: 'channel-manifest/v1' };
  readonly probeRequired: boolean;
  readonly manifest: Record<string, unknown>;
  readonly document: ChannelManifestDocument;
  readonly manifestSha256: string;
  readonly baseUrl: string;
  readonly authRef: unknown;
  readonly rateLimit: unknown;
  readonly quotaPolicy: unknown;
  readonly pagination: unknown;
  readonly fieldMapping: unknown;
  readonly governance: {
    readonly license?: string;
    readonly tosUrl?: string;
    readonly robotsPolicy?: string;
  };
  readonly displayName: string;
  readonly category: string;
}

/**
 * 将 `transport.responseType === 'html'` 的 `channel-manifest/v1` 文档投影为
 * `ChannelCrawlConfig`，供 `crawlChannel` 与 `runChannelCrawl` 确定性执行。
 */
export function manifestToCrawlConfig(
  manifest: ChannelManifestDocument,
): ChannelCrawlConfig {
  if (manifest.transport.responseType !== 'html' || !manifest.crawl) {
    throw new ChannelManifestError([
      { path: '/crawl', message: 'html manifest requires crawl configuration' },
    ]);
  }
  const list = manifest.crawl.list;
  const url = list.url ?? manifest.transport.baseUrl;
  const pageParam =
    list.pageParam ??
    (manifest.pagination?.type === 'page'
      ? manifest.pagination.pageParam
      : undefined);
  const rawMaxPages =
    list.maxPages ??
    (manifest.pagination?.type === 'page' ? manifest.pagination.maxPages : 1);
  const maxPages = Math.max(
    1,
    Math.min(CHANNEL_RUN_MAX_PAGES, Math.trunc(rawMaxPages)),
  );
  const singlePage = !url.includes('{page}') && !pageParam && maxPages === 1;
  return {
    mode: 'crawl',
    list: {
      url,
      maxPages,
      itemSelector: list.itemSelector,
      ...(list.itemUrlSelector
        ? { itemUrlSelector: list.itemUrlSelector }
        : {}),
      ...(pageParam ? { pageParam } : {}),
      ...(singlePage ? { singlePage: true } : {}),
    },
    detail: {
      enabled: manifest.crawl.detail?.enabled === true,
      fields: { ...(manifest.crawl.detail?.fields ?? {}) },
    },
  };
}

/**
 * 将已校验的 `channel-manifest/v1` 文档映射为 `source_channel` 落库列。
 * JSON 投影到 api，HTML 投影到 crawl。新保存的版本都需要试跑。
 */
export function buildManifestColumns(
  manifest: ChannelManifestDocument,
): ManifestColumnsResult {
  const mode = manifest.transport.responseType === 'html' ? 'crawl' : 'api';
  const config =
    mode === 'crawl'
      ? manifestToCrawlConfig(manifest)
      : ({ adapter: 'channel-manifest/v1' } as const);
  const refs = collectAuthRefs(manifest.auth);
  return {
    mode,
    config,
    probeRequired: true,
    manifest: manifest as unknown as Record<string, unknown>,
    document: manifest,
    manifestSha256: manifestSha256(manifest),
    baseUrl: manifest.transport.baseUrl,
    authRef: refs.length > 0 ? { refs } : null,
    rateLimit: manifest.rateLimit ?? null,
    quotaPolicy:
      manifest.rateLimit?.dailyRequests === undefined
        ? null
        : { dailyRequests: manifest.rateLimit.dailyRequests },
    pagination: manifest.pagination ?? null,
    fieldMapping: manifest.fieldMapping ?? null,
    governance: {
      ...(manifest.governance
        ? {
            license: manifest.governance.license,
            tosUrl: manifest.governance.tosUrl,
            robotsPolicy: manifest.governance.robotsPolicy,
          }
        : {}),
    },
    displayName: manifest.meta.name,
    category: manifest.meta.category,
  };
}
