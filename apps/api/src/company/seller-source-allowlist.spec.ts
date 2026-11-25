import { describe, expect, it } from 'vitest';
import {
  classifySellerWebsiteChannel,
  isSellerMarketplaceStoreUrl,
} from './seller-source-allowlist';
import { isDirectoryFallbackBlockedHost } from '../discovery/source-policy-scope';
import { rankWebsiteCandidates } from './website-candidates';

describe('seller-source-allowlist (1688 / Alibaba storefront whitelist with strict buyer isolation)', () => {
  it('admits valid 1688 and Alibaba International seller storefront URLs', () => {
    expect(isSellerMarketplaceStoreUrl('https://shop12345.1688.com/page/offerlist.htm')).toEqual({
      isMarketplace: true,
      channel: 'alibaba_1688',
      validStore: true,
    });
    expect(isSellerMarketplaceStoreUrl('https://www.1688.com/winport/acme-factory.html')).toEqual({
      isMarketplace: true,
      channel: 'alibaba_1688',
      validStore: true,
    });
    expect(isSellerMarketplaceStoreUrl('https://acmesolar.en.alibaba.com/company_profile.html')).toEqual({
      isMarketplace: true,
      channel: 'alibaba_intl',
      validStore: true,
    });
    expect(isSellerMarketplaceStoreUrl('https://www.alibaba.com/company/acme-solar.html')).toEqual({
      isMarketplace: true,
      channel: 'alibaba_intl',
      validStore: true,
    });
    expect(classifySellerWebsiteChannel('https://acme-solar.com')).toBe('official_website');
  });

  it('rejects generic 1688/Alibaba search pages, platform homepages, and single product detail pages', () => {
    for (const bad of [
      'https://www.1688.com/',
      'https://s.1688.com/selloffer/offer_search.htm?keywords=solar',
      'https://detail.1688.com/offer/123456.html',
      'https://www.alibaba.com/',
      'https://s.alibaba.com/trade/search?SearchText=solar',
    ]) {
      const check = isSellerMarketplaceStoreUrl(bad);
      expect(check.isMarketplace).toBe(true);
      expect(check.validStore).toBe(false);
      expect(check.reason).toBeTruthy();
    }
  });

  it('HARD ISOLATION: buyer discovery & official-website search still strictly block 1688.com and alibaba.com', () => {
    expect(isDirectoryFallbackBlockedHost('shop12345.1688.com')).toBe(true);
    expect(isDirectoryFallbackBlockedHost('acmesolar.en.alibaba.com')).toBe(true);
    const ranked = rankWebsiteCandidates(
      [
        { url: 'https://shop12345.1688.com/', title: 'Acme Tech Co.' },
        { url: 'https://acme.en.alibaba.com/', title: 'Acme Tech Co.' },
        { url: 'https://acme-tech.com/', title: 'Acme Tech Co. Official' },
      ],
      'Acme Tech Co.',
    );
    expect(ranked.map((item) => item.url)).toEqual(['https://acme-tech.com/']);
  });
});
