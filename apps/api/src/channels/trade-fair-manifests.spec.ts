import { describe, expect, it } from 'vitest';
import { TRADE_FAIR_CATALOG } from '../discovery/trade-fair-catalog';
import { parseChannelManifest } from './connector/channel-manifest';
import { manifestToCrawlConfig } from './html-manifest-adapter';
import {
  TRADE_FAIR_MANIFESTS,
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

  it('keeps ProPak Asia 2026 ENABLED and keeps Cloudflare-blocked/unverified fairs DISABLED', () => {
    const propak = findTradeFairManifestBySlug('propak-asia-2026')!;
    expect(propak.targetStatus).toBe('ENABLED');
    expect(propak.verifiedAdapter).toBe(true);
    expect(propak.manifest.crawl?.list.itemSelector).toBe('div.ex-body');
    expect(propak.manifest.governance?.robotsPolicy).toBe('A');

    for (const blockedSlug of ['gulf-print-pack-2026', 'loupe-americas-2026']) {
      const blocked = findTradeFairManifestBySlug(blockedSlug)!;
      expect(blocked.targetStatus).toBe('DISABLED');
      expect(blocked.disabledReason).toBe('GOVERNANCE');
      expect(blocked.verifiedAdapter).toBe(false);
    }

    for (const flagshipSlug of [
      'intersolar-europe',
      'key-energy-rimini',
      're-plus-north-america',
      'intersolar-south-america',
    ]) {
      const flagship = findTradeFairManifestBySlug(flagshipSlug)!;
      expect(flagship.targetStatus).toBe('DISABLED');
      expect(flagship.verifiedAdapter).toBe(false);
    }
  });
});
