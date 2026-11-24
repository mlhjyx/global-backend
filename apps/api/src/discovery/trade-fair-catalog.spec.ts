import { describe, expect, it } from 'vitest';
import {
  TRADE_FAIR_CATALOG,
  buildTradeFairSearchQueries,
  selectCatalogFairs,
} from './trade-fair-catalog';

describe('TRADE_FAIR_CATALOG (16 archived + 4 solar fairs)', () => {
  it('contains 20 unique real trade fairs and excludes E2E smoke placeholder', () => {
    expect(TRADE_FAIR_CATALOG).toHaveLength(20);
    expect(new Set(TRADE_FAIR_CATALOG.map((f) => f.slug)).size).toBe(20);
    expect(TRADE_FAIR_CATALOG.some((f) => f.exhibitorUrl.includes('example.com'))).toBe(false);
  });

  it('selects all 4 solar/PV flagship fairs and ranks target country first', () => {
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
