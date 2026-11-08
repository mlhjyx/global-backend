import type { ChannelManifestDocument } from '@global/contracts';
import { channelError } from './errors';
import { extractJsonPathFirst } from './json-path';
import { hostAllowed } from './channel-manifest';

/**
 * 分页策略（章节 §6.3.5）：none / page / offset / cursor / link 五种，逐页推进、终止条件明确：
 *   page   空 items / page≥maxPages / 运行预算
 *   offset 返回条数 < pageSize / maxPages / 预算
 *   cursor cursor 空或与上次相同 / maxPages / 预算
 *   link   next link 空 / 非 https / 不在 allowedHosts / 已访问过 / maxPages
 * 只构建请求 URL（认证参数由连接器在发请求前合并），不做出网。
 */

export interface RequestPlanDraft {
  readonly url: string;
  readonly method: 'GET';
}

export interface PageOutcome {
  readonly bodyText: string;
  readonly recordsCount: number;
}

export class ChannelPaginator {
  private readonly manifest: ChannelManifestDocument;
  private readonly maxPages: number;
  private pageIndex = 0;
  private lastCursor: string | null = null;
  private readonly seenLinks = new Set<string>();

  constructor(manifest: ChannelManifestDocument, options: { maxPages: number }) {
    if ((manifest.transport.method ?? 'GET') !== 'GET') {
      throw channelError('CHANNEL_METHOD_UNSUPPORTED', 'channel connector v1 executes GET requests only');
    }
    this.manifest = manifest;
    this.maxPages = Math.max(1, Math.trunc(options.maxPages));
  }

  get pagesPlanned(): number {
    return this.pageIndex;
  }

  first(): RequestPlanDraft {
    this.pageIndex = 1;
    return { url: this.buildUrl(), method: 'GET' };
  }

  next(outcome: PageOutcome): RequestPlanDraft | null {
    if (this.pageIndex >= this.maxPages) return null;
    const pagination = this.manifest.pagination ?? { type: 'none' as const };
    if (pagination.type === 'none') return null;

    if (pagination.type === 'page') {
      if (outcome.recordsCount === 0) return null;
      if (this.pageIndex >= Math.min(pagination.maxPages, this.maxPages)) return null;
      this.pageIndex += 1;
      return { url: this.buildUrl(), method: 'GET' };
    }

    if (pagination.type === 'offset') {
      const pageSize = pagination.pageSize ?? 100;
      if (outcome.recordsCount < pageSize) return null;
      if (this.pageIndex >= Math.min(pagination.maxPages, this.maxPages)) return null;
      this.pageIndex += 1;
      return { url: this.buildUrl(), method: 'GET' };
    }

    if (pagination.type === 'cursor') {
      const cursor = extractJsonPathFirst(parseJson(outcome.bodyText), pagination.cursorPath);
      if (cursor === null || cursor === this.lastCursor) return null;
      if (this.pageIndex >= Math.min(pagination.maxPages ?? 20, this.maxPages)) return null;
      this.lastCursor = cursor;
      this.pageIndex += 1;
      return { url: this.buildUrl(cursor), method: 'GET' };
    }

    // link
    const nextLink = extractJsonPathFirst(parseJson(outcome.bodyText), pagination.nextLinkPath);
    if (nextLink === null) return null;
    if (this.pageIndex >= Math.min(pagination.maxPages ?? 20, this.maxPages)) return null;
    let url: URL;
    try {
      url = new URL(nextLink);
    } catch {
      throw channelError('CHANNEL_PARSE_ERROR', 'next link is not a valid URL');
    }
    if (url.protocol !== 'https:') {
      throw channelError('CHANNEL_EGRESS_DENIED', 'next link must use https');
    }
    const allowedHosts = this.manifest.transport.allowedHosts ?? [];
    if (!hostAllowed(url.hostname, allowedHosts)) {
      throw channelError('CHANNEL_HOST_NOT_ALLOWED', `next link host not allowed: ${url.hostname}`);
    }
    if (this.seenLinks.has(url.toString())) return null;
    this.seenLinks.add(url.toString());
    this.pageIndex += 1;
    return { url: url.toString(), method: 'GET' };
  }

  private buildUrl(cursor?: string): string {
    const transport = this.manifest.transport;
    const url = new URL(transport.baseUrl);
    for (const [name, value] of Object.entries(transport.queryDefaults ?? {})) {
      url.searchParams.set(name, value);
    }
    const pagination = this.manifest.pagination ?? { type: 'none' as const };
    if (pagination.type === 'page') {
      const startPage = pagination.startPage ?? 1;
      url.searchParams.set(pagination.pageParam, String(startPage + this.pageIndex - 1));
      if (pagination.sizeParam && pagination.pageSize !== undefined) {
        url.searchParams.set(pagination.sizeParam, String(pagination.pageSize));
      }
    } else if (pagination.type === 'offset') {
      const pageSize = pagination.pageSize ?? 100;
      url.searchParams.set(pagination.offsetParam, String((this.pageIndex - 1) * pageSize));
      url.searchParams.set(pagination.limitParam, String(pageSize));
    } else if (pagination.type === 'cursor' && cursor !== undefined) {
      url.searchParams.set(pagination.cursorParam, cursor);
    }
    return url.toString();
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw channelError('CHANNEL_PARSE_ERROR', 'response body is not valid JSON');
  }
}
