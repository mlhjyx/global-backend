import { describe, expect, it } from 'vitest';
import {
  TRADE_FAIR_CATALOG,
  buildTradeFairSearchQueries,
  isTradeFairDirectlyCrawlable,
  selectCatalogFairs,
} from './trade-fair-catalog';

describe('TRADE_FAIR_CATALOG (16 archived + 4 solar fairs)', () => {
  it('contains 20 unique real trade fairs, all reviewed into enabled (13) or blocked (7)', () => {
    expect(TRADE_FAIR_CATALOG).toHaveLength(20);
    expect(new Set(TRADE_FAIR_CATALOG.map((f) => f.slug)).size).toBe(20);
    expect(TRADE_FAIR_CATALOG.some((f) => new URL(f.exhibitorUrl).hostname === 'example.com')).toBe(false);
    expect(TRADE_FAIR_CATALOG.filter((f) => f.status === 'needs_adapter')).toHaveLength(0);
    expect(TRADE_FAIR_CATALOG.filter((f) => f.status === 'enabled')).toHaveLength(13);
    expect(TRADE_FAIR_CATALOG.filter((f) => f.status === 'blocked')).toHaveLength(7);
  });

  it('selects all 4 solar/PV flagship fairs, enables the 3 compliant ones, and blocks CloudFront-walled KEY Energy', () => {
    const selected = selectCatalogFairs({
      industryTerms: ['solar module', 'HJT'],
      countries: ['IT'],
    });
    expect(selected.map((f) => f.slug)).toEqual([
      'key-energy-rimini',
      'intersolar-europe',
      'intersolar-south-america',
      're-plus-north-america',
    ]);

    const bySlug = new Map(TRADE_FAIR_CATALOG.map((f) => [f.slug, f]));
    expect(isTradeFairDirectlyCrawlable(bySlug.get('intersolar-europe')!)).toBe(true);
    expect(bySlug.get('intersolar-europe')!.exhibitorUrl).toBe('https://www.intersolar.de/exhibitorlist');
    expect(isTradeFairDirectlyCrawlable(bySlug.get('re-plus-north-america')!)).toBe(true);
    expect(bySlug.get('re-plus-north-america')!.exhibitorUrl).toBe(
      'https://re26.mapyourshow.com/8_0/explore/exhibitor-gallery.cfm?featured=false',
    );
    expect(isTradeFairDirectlyCrawlable(bySlug.get('intersolar-south-america')!)).toBe(true);
    expect(bySlug.get('intersolar-south-america')!.exhibitorUrl).toBe('https://www.intersolar.net.br/exhibitorlist');
    expect(isTradeFairDirectlyCrawlable(bySlug.get('key-energy-rimini')!)).toBe(false);
    expect(bySlug.get('key-energy-rimini')!.status).toBe('blocked');
  });

  it('blocks WAF/CAPTCHA, robots-disallowed, and ToS-prohibited fairs fail-closed', () => {
    const blockedSlugs = TRADE_FAIR_CATALOG.filter((f) => f.status === 'blocked')
      .map((f) => f.slug)
      .sort();
    expect(blockedSlugs).toEqual([
      'chinaplas-2027',
      'gulf-print-pack-2026',
      'key-energy-rimini',
      'loupe-americas-2026',
      'nepcon-japan',
      'pharmapack-europe-2026',
      'plastic-japan-osaka',
    ]);
    for (const fair of TRADE_FAIR_CATALOG) {
      if (fair.status === 'blocked') {
        expect(isTradeFairDirectlyCrawlable(fair), fair.slug).toBe(false);
      } else {
        expect(isTradeFairDirectlyCrawlable(fair), fair.slug).toBe(true);
      }
    }
  });

  it('retains archived multi-industry fairs (packaging / plastics / medical)', () => {
    const packaging = selectCatalogFairs({ industryTerms: ['packaging'] });
    expect(packaging.map((f) => f.slug)).toContain('propak-asia-2026');
    expect(packaging.map((f) => f.slug)).toContain('pharmapack-europe-2026');

    const plastics = selectCatalogFairs({ keywords: ['plastics'] });
    expect(plastics.map((f) => f.slug)).toContain('chinaplas-2027');
    expect(plastics.map((f) => f.slug)).toContain('plast-2026');
  });

  it('builds targeted L0 search queries for a catalog fair', () => {
    const intersolar = TRADE_FAIR_CATALOG.find((f) => f.slug === 'intersolar-europe')!;
    const queries = buildTradeFairSearchQueries(intersolar, ['HJT solar EPC']);
    expect(queries).toEqual([
      '"Intersolar Europe" exhibitor HJT solar EPC',
      'site:intersolar.de HJT solar EPC',
    ]);
  });
});
