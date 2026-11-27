import type { ChannelManifestDocument } from '@global/contracts';
import {
  isTradeFairDirectlyCrawlable,
  TRADE_FAIR_CATALOG,
  type TradeFairCatalogEntry,
} from '../discovery/trade-fair-catalog';
import type { ChannelCrawlConfig } from './channel-config';
import {
  manifestSha256,
  parseChannelManifest,
} from './connector/channel-manifest';
import { manifestToCrawlConfig } from './html-manifest-adapter';

export type TradeFairExtractionMode = 'selector' | 'generic_llm';

export interface TradeFairManifestEntry {
  readonly slug: string;
  readonly name: string;
  readonly targetStatus: 'ENABLED' | 'DISABLED';
  readonly disabledReason: 'GOVERNANCE' | 'OPERATOR' | null;
  readonly verifiedAdapter: boolean;
  readonly extractionMode: TradeFairExtractionMode;
  readonly manifest: ChannelManifestDocument;
  readonly manifestSha256: string;
  readonly crawlConfig: ChannelCrawlConfig;
}

/**
 * 可选的已验证静态 CSS 选择器提速表（非启用硬门禁）。
 * 未登记选择器的合规展会默认走 `generic_llm` 通用抓取抽取链路
 * （`crawl4ai.fetch` 渲染 + 翻页 + `discovery.extract_list` 模型抽取；PDF 走 Docling）。
 */
const OPTIONAL_VERIFIED_LIST_SELECTORS: Readonly<
  Record<string, { itemSelector: string; detailFields?: Record<string, string> }>
> = {
  'propak-asia-2026': {
    itemSelector: 'div.ex-body',
    detailFields: { name: '.company' },
  },
  'fespa-brasil-2027': {
    itemSelector: 'div.expositor_item_details',
    detailFields: { name: 'p.text-fp-dark', website: 'a::attr(href)' },
  },
  'plast-2026': {
    itemSelector: 'a.exhibitor',
    detailFields: { name: 'span.text' },
  },
};

export function buildTradeFairManifestEntry(
  fair: TradeFairCatalogEntry,
): TradeFairManifestEntry {
  const parsedUrl = new URL(fair.exhibitorUrl);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
  const selectorConfig = OPTIONAL_VERIFIED_LIST_SELECTORS[fair.slug];
  // 启用门禁收敛为合规审核：robotsPolicy='A' + 明确 license/tosUrl + 已登记有效 https 展商网址 + enabled。
  // 专用 CSS 选择器或平台级适配器只作可选提速，不阻断合规展会启用。
  const verifiedAdapter = isTradeFairDirectlyCrawlable(fair);
  const extractionMode: TradeFairExtractionMode = selectorConfig
    ? 'selector'
    : 'generic_llm';
  const perDomainDelayMs = fair.crawlDelayMs ?? 2000;
  const rps = perDomainDelayMs >= 5000 ? 0.1 : 0.5;

  const rawManifest = {
    meta: {
      name: fair.name,
      version: 1,
      category: 'trade_fair' as const,
      docsUrl: fair.exhibitorUrl,
      ...(fair.note ? { description: fair.note } : {}),
    },
    transport: {
      baseUrl,
      method: 'GET' as const,
      responseType: 'html' as const,
      allowedHosts: [parsedUrl.hostname],
    },
    auth: { type: 'none' as const },
    pagination: { type: 'none' as const },
    rateLimit: {
      rps,
      burst: 2,
      concurrency: 1,
      dailyRequests: 250,
      respectRetryAfter: true,
      perDomainDelayMs,
    },
    crawl: {
      list: {
        url: fair.exhibitorUrl,
        itemSelector: selectorConfig?.itemSelector ?? '.exhibitor-item',
        maxPages: 1,
      },
      detail: {
        enabled: false,
        ...(selectorConfig?.detailFields
          ? { fields: selectorConfig.detailFields }
          : {}),
      },
    },
    ...(verifiedAdapter && fair.license && fair.tosUrl && fair.robotsPolicy
      ? {
          governance: {
            license: fair.license,
            tosUrl: fair.tosUrl,
            robotsPolicy: fair.robotsPolicy,
            personalData: false,
            allowedPurpose: ['discovery'] as Array<'discovery'>,
          },
        }
      : {}),
  };

  const manifest = parseChannelManifest(rawManifest);
  const crawlConfig = manifestToCrawlConfig(manifest);
  const targetStatus: 'ENABLED' | 'DISABLED' = verifiedAdapter
    ? 'ENABLED'
    : 'DISABLED';
  const disabledReason: 'GOVERNANCE' | 'OPERATOR' | null =
    targetStatus === 'ENABLED'
      ? null
      : fair.status === 'blocked'
        ? 'GOVERNANCE'
        : 'OPERATOR';

  return {
    slug: fair.slug,
    name: fair.name,
    targetStatus,
    disabledReason,
    verifiedAdapter,
    extractionMode,
    manifest,
    manifestSha256: manifestSha256(manifest),
    crawlConfig,
  };
}

export const TRADE_FAIR_MANIFESTS: readonly TradeFairManifestEntry[] =
  Object.freeze(TRADE_FAIR_CATALOG.map(buildTradeFairManifestEntry));

export function findTradeFairManifestBySlug(
  slug: string,
): TradeFairManifestEntry | undefined {
  return TRADE_FAIR_MANIFESTS.find((entry) => entry.slug === slug);
}

export function findTradeFairManifestByName(
  name: string,
): TradeFairManifestEntry | undefined {
  return TRADE_FAIR_MANIFESTS.find((entry) => entry.name === name);
}
