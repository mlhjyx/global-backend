import type { ChannelManifestDocument } from '@global/contracts';
import {
  TRADE_FAIR_CATALOG,
  type TradeFairCatalogEntry,
} from '../discovery/trade-fair-catalog';
import type { ChannelCrawlConfig } from './channel-config';
import {
  manifestSha256,
  parseChannelManifest,
} from './connector/channel-manifest';
import { manifestToCrawlConfig } from './html-manifest-adapter';

export interface TradeFairManifestEntry {
  readonly slug: string;
  readonly name: string;
  readonly targetStatus: 'ENABLED' | 'DISABLED';
  readonly disabledReason: 'GOVERNANCE' | 'OPERATOR' | null;
  readonly verifiedAdapter: boolean;
  readonly manifest: ChannelManifestDocument;
  readonly manifestSha256: string;
  readonly crawlConfig: ChannelCrawlConfig;
}

const VERIFIED_LIST_SELECTORS: Readonly<
  Record<string, { itemSelector: string; detailFields?: Record<string, string> }>
> = {
  'propak-asia-2026': {
    itemSelector: 'div.ex-body',
    detailFields: { name: '.company' },
  },
};

export function buildTradeFairManifestEntry(
  fair: TradeFairCatalogEntry,
): TradeFairManifestEntry {
  const parsedUrl = new URL(fair.exhibitorUrl);
  const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
  const selectorConfig = VERIFIED_LIST_SELECTORS[fair.slug];
  const verifiedAdapter = Boolean(
    fair.status === 'enabled' &&
      selectorConfig &&
      fair.robotsPolicy === 'A' &&
      fair.license &&
      fair.tosUrl,
  );

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
      rps: 0.5,
      burst: 2,
      concurrency: 1,
      dailyRequests: 250,
      respectRetryAfter: true,
      perDomainDelayMs: 2000,
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
