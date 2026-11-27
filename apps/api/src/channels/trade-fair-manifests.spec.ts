import { describe, expect, it } from 'vitest';
import { TRADE_FAIR_CATALOG } from '../discovery/trade-fair-catalog';
import { parseChannelManifest } from './connector/channel-manifest';
import { manifestToCrawlConfig } from './html-manifest-adapter';
import {
  TRADE_FAIR_MANIFESTS,
  buildTradeFairManifestEntry,
  findTradeFairManifestByName,
  findTradeFairManifestBySlug,
} from './trade-fair-manifests';

describe('TRADE_FAIR_MANIFESTS', () => {
  it('covers all 20 TRADE_FAIR_CATALOG fairs with valid channel-manifest/v1 HTML manifests', () => {
    expect(TRADE_FAIR_MANIFESTS).toHaveLength(TRADE_FAIR_CATALOG.length);
    for (const fair of TRADE_FAIR_CATALOG) {
      const entry = findTradeFairManifestBySlug(fair.slug);
      expect(entry, fair.slug).toBeDefined();
      expect(findTradeFairManifestByName(fair.name)?.slug).toBe(fair.slug);
      expect(() => parseChannelManifest(entry!.manifest)).not.toThrow();
      expect(() => manifestToCrawlConfig(entry!.manifest)).not.toThrow();
      expect(entry!.manifestSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(entry!.manifest.transport.responseType).toBe('html');
    }
  });

  it('enables all 13 compliance-approved fairs (generic_llm by default, optional selector acceleration) and keeps 7 blocked fairs DISABLED', () => {
    const enabled = TRADE_FAIR_MANIFESTS.filter((entry) => entry.targetStatus === 'ENABLED');
    const disabled = TRADE_FAIR_MANIFESTS.filter((entry) => entry.targetStatus === 'DISABLED');
    expect(enabled).toHaveLength(13);
    expect(disabled).toHaveLength(7);

    // Optional selector acceleration works without gating generic fairs
    const propak = findTradeFairManifestBySlug('propak-asia-2026')!;
    expect(propak.targetStatus).toBe('ENABLED');
    expect(propak.verifiedAdapter).toBe(true);
    expect(propak.extractionMode).toBe('selector');
    expect(propak.manifest.crawl?.list.itemSelector).toBe('div.ex-body');
    expect(propak.manifest.governance?.robotsPolicy).toBe('A');

    for (const selectorSlug of ['fespa-brasil-2027', 'plast-2026']) {
      const entry = findTradeFairManifestBySlug(selectorSlug)!;
      expect(entry.targetStatus).toBe('ENABLED');
      expect(entry.extractionMode).toBe('selector');
    }

    // 3 compliant PV flagship fairs enable via generic_llm extraction (no site-specific selector required)
    for (const pvSlug of [
      'intersolar-europe',
      're-plus-north-america',
      'intersolar-south-america',
    ]) {
      const entry = findTradeFairManifestBySlug(pvSlug)!;
      expect(entry.targetStatus, pvSlug).toBe('ENABLED');
      expect(entry.disabledReason, pvSlug).toBeNull();
      expect(entry.verifiedAdapter, pvSlug).toBe(true);
      expect(entry.extractionMode, pvSlug).toBe('generic_llm');
      expect(entry.manifest.governance).toMatchObject({
        robotsPolicy: 'A',
        personalData: false,
        allowedPurpose: ['discovery'],
      });
    }

    // Easyfairs Crawl-delay: 10 is honored in manifest rateLimit
    const easyfairs = findTradeFairManifestBySlug('southern-manufacturing-electronics-se27')!;
    expect(easyfairs.targetStatus).toBe('ENABLED');
    expect(easyfairs.manifest.rateLimit?.perDomainDelayMs).toBe(10_000);
    expect(easyfairs.manifest.rateLimit?.rps).toBe(0.1);

    // All 7 WAF/CAPTCHA/robots/ToS-blocked fairs remain DISABLED with GOVERNANCE reason
    for (const blockedSlug of [
      'key-energy-rimini',
      'chinaplas-2027',
      'gulf-print-pack-2026',
      'loupe-americas-2026',
      'nepcon-japan',
      'pharmapack-europe-2026',
      'plastic-japan-osaka',
    ]) {
      const blocked = findTradeFairManifestBySlug(blockedSlug)!;
      expect(blocked.targetStatus, blockedSlug).toBe('DISABLED');
      expect(blocked.disabledReason, blockedSlug).toBe('GOVERNANCE');
      expect(blocked.verifiedAdapter, blockedSlug).toBe(false);
    }
  });

  it('fails closed when a fair is missing robotsPolicy A, license, or tosUrl', () => {
    const base = TRADE_FAIR_CATALOG.find((fair) => fair.slug === 'intersolar-europe')!;
    expect(
      buildTradeFairManifestEntry({ ...base, robotsPolicy: 'B' }).targetStatus,
    ).toBe('DISABLED');
    expect(
      buildTradeFairManifestEntry({ ...base, license: undefined }).targetStatus,
    ).toBe('DISABLED');
    expect(
      buildTradeFairManifestEntry({ ...base, tosUrl: undefined }).targetStatus,
    ).toBe('DISABLED');
  });
});
