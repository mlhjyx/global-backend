/**
 * Seller-onboarding-ONLY URL allowlist for 1688 and Alibaba International storefronts.
 *
 * HARD ISOLATION INVARIANT:
 * - Used ONLY for seller self-onboarding (`CompanyService`, `UnderstandingPreviewService`,
 *   `IcpThreeLayer`).
 * - NEVER imported or used by buyer discovery (`public-web.provider.ts`, `directory.provider.ts`,
 *   `source-policy-scope.ts`), which MUST keep `1688.com` and `alibaba.com` strictly blocked as
 *   buyer noise/marketplace domains.
 */

import { BadRequestException } from '@nestjs/common';

export type SellerWebsiteChannel = 'official_website' | 'alibaba_1688' | 'alibaba_intl';

const ALIBABA_1688_GENERIC_HOSTS = new Set([
  '1688.com',
  'www.1688.com',
  's.1688.com',
  'search.1688.com',
  'login.1688.com',
  'cart.1688.com',
  'trade.1688.com',
]);

const ALIBABA_INTL_GENERIC_HOSTS = new Set([
  's.alibaba.com',
  'login.alibaba.com',
  'message.alibaba.com',
  'rfq.alibaba.com',
]);

const ALIBABA_1688_STORE_PATH_RE = /^\/(?:winport|page|company)\//iu;
const ALIBABA_INTL_STORE_PATH_RE = /^\/(?:company|company_profile|product-detail|supplier)\b/iu;

function parseHttpUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isSellerMarketplaceStoreUrl(rawUrl: string): {
  readonly isMarketplace: boolean;
  readonly channel: SellerWebsiteChannel;
  readonly validStore: boolean;
  readonly reason?: string;
} {
  const parsed = parseHttpUrl(rawUrl);
  if (!parsed) {
    return { isMarketplace: false, channel: 'official_website', validStore: false, reason: 'INVALID_URL' };
  }
  const host = parsed.hostname.toLowerCase();

  if (host === '1688.com' || host.endsWith('.1688.com')) {
    if (ALIBABA_1688_GENERIC_HOSTS.has(host)) {
      if ((host === 'www.1688.com' || host === '1688.com') && ALIBABA_1688_STORE_PATH_RE.test(parsed.pathname)) {
        return { isMarketplace: true, channel: 'alibaba_1688', validStore: true };
      }
      return {
        isMarketplace: true,
        channel: 'alibaba_1688',
        validStore: false,
        reason: '请提供具体的 1688 卖家店铺网址（如 https://yourshop.1688.com），不能填写 1688 首页或搜索页',
      };
    }
    if (host === 'detail.1688.com') {
      return {
        isMarketplace: true,
        channel: 'alibaba_1688',
        validStore: false,
        reason: '请提供 1688 店铺首页链接，不要填写单个商品详情页',
      };
    }
    return { isMarketplace: true, channel: 'alibaba_1688', validStore: true };
  }

  if (host === 'alibaba.com' || host.endsWith('.alibaba.com')) {
    if (ALIBABA_INTL_GENERIC_HOSTS.has(host)) {
      return {
        isMarketplace: true,
        channel: 'alibaba_intl',
        validStore: false,
        reason: '请提供具体的阿里巴巴国际站店铺网址（如 https://yourcompany.en.alibaba.com）',
      };
    }
    if (host === 'alibaba.com' || host === 'www.alibaba.com') {
      if (ALIBABA_INTL_STORE_PATH_RE.test(parsed.pathname)) {
        return { isMarketplace: true, channel: 'alibaba_intl', validStore: true };
      }
      return {
        isMarketplace: true,
        channel: 'alibaba_intl',
        validStore: false,
        reason: '请提供具体的阿里巴巴国际站企业店铺链接，不能填写平台首页或搜索页',
      };
    }
    return { isMarketplace: true, channel: 'alibaba_intl', validStore: true };
  }

  return { isMarketplace: false, channel: 'official_website', validStore: true };
}

export function classifySellerWebsiteChannel(rawUrl: string | null | undefined): SellerWebsiteChannel | null {
  if (!rawUrl || !rawUrl.trim()) return null;
  const result = isSellerMarketplaceStoreUrl(rawUrl);
  return result.validStore ? result.channel : null;
}

/** Validates seller-provided website URL (admitting 1688/Alibaba stores, rejecting generic pages). */
export function assertSellerWebsiteAllowed(rawUrl: string | undefined): void {
  if (!rawUrl) return;
  const check = isSellerMarketplaceStoreUrl(rawUrl);
  if (check.isMarketplace && !check.validStore) {
    throw new BadRequestException({
      error: { code: 'VALIDATION_ERROR', message: check.reason ?? '店铺链接格式无效' },
    });
  }
}

export function buildCompanySummaryPatch(productDescription: string | undefined): { summary?: string } {
  return productDescription !== undefined ? { summary: productDescription.trim() } : {};
}
