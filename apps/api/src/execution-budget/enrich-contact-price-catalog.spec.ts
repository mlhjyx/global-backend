import { describe, expect, it } from 'vitest';
import { CONTROLLED_ENRICHMENT_TOOL_DECLARATIONS } from '../tools/contact-enrichment-safety-tools';
import {
  ENRICH_CONTACT_PRICE_POLICY_VERSION,
  ENRICH_CONTACT_PRICE_TOOL_IDS,
  enrichContactPriceCatalog,
  enrichUnitCeilCents,
  projectEnrichContactPriceCatalog,
  type EnrichContactPriceConfigs,
} from './enrich-contact-price-catalog';

const DEFAULTS: EnrichContactPriceConfigs = Object.freeze({
  hunter: 1_700,
  millionverifier: 1_780,
  emailable: 7_600,
  zerobounce: 9_900,
});

describe('enrich contact price catalog', () => {
  it.each([
    [0, 0],
    [1, 1],
    [9_999, 1],
    [10_000, 1],
    [10_001, 2],
    [1_700, 1],
    [9_900, 1],
    [150_000, 15],
  ])('ceil(µUSD %i / 10000) = %i integer cents', (microusd, cents) => {
    expect(enrichUnitCeilCents(microusd)).toBe(cents);
    // The integer-cent ceiling never quotes below the exact unit price.
    expect(cents * 10_000).toBeGreaterThanOrEqual(microusd);
  });

  it('projects exactly the four governed paid tools with their original ids, versions and unit', () => {
    const catalog = projectEnrichContactPriceCatalog(DEFAULTS);
    expect(catalog.map((entry) => entry.provider)).toEqual([
      'hunter',
      'millionverifier',
      'emailable',
      'zerobounce',
    ]);
    expect(catalog).toEqual([
      { provider: 'hunter', toolId: 'contact_email.find.hunter', version: '1.0.0', costUnit: 'request', unitQuoteUpperMicrousd: 1_700, unitCeilCents: 1 },
      { provider: 'millionverifier', toolId: 'contact_email.verify.millionverifier', version: '1.0.0', costUnit: 'request', unitQuoteUpperMicrousd: 1_780, unitCeilCents: 1 },
      { provider: 'emailable', toolId: 'contact_email.verify.emailable', version: '1.0.0', costUnit: 'request', unitQuoteUpperMicrousd: 7_600, unitCeilCents: 1 },
      { provider: 'zerobounce', toolId: 'contact_email.verify.zerobounce', version: '1.0.0', costUnit: 'request', unitQuoteUpperMicrousd: 9_900, unitCeilCents: 1 },
    ]);
    expect(ENRICH_CONTACT_PRICE_POLICY_VERSION).toBe(1);
  });

  it('keeps tool ids and versions pinned to the closed governance declarations', () => {
    const declared = CONTROLLED_ENRICHMENT_TOOL_DECLARATIONS.map((entry) => entry.id).sort();
    expect([...ENRICH_CONTACT_PRICE_TOOL_IDS].sort()).toEqual(declared);
    for (const entry of projectEnrichContactPriceCatalog(DEFAULTS)) {
      const declaration = CONTROLLED_ENRICHMENT_TOOL_DECLARATIONS.find((item) => item.id === entry.toolId);
      expect(declaration?.version).toBe(entry.version);
    }
  });

  it('projects the same prices from the runtime env normalization without requiring any key', () => {
    const catalog = enrichContactPriceCatalog({});
    expect(catalog.map((entry) => entry.unitQuoteUpperMicrousd)).toEqual([1_700, 1_780, 7_600, 9_900]);
    expect(enrichContactPriceCatalog({ HUNTER_API_KEY: '' }).find((entry) => entry.provider === 'hunter')?.unitQuoteUpperMicrousd).toBe(1_700);
  });

  it('follows explicit env price overrides for each governed provider', () => {
    const catalog = enrichContactPriceCatalog({
      HUNTER_COST_MICROUSD: '1900',
      MILLIONVERIFIER_COST_MICROUSD: '2500',
      EMAILABLE_COST_MICROUSD: '10000',
      ZEROBOUNCE_COST_MICROUSD: '9999',
    });
    expect(catalog.map((entry) => [entry.unitQuoteUpperMicrousd, entry.unitCeilCents])).toEqual([
      [1_900, 1],
      [2_500, 1],
      [10_000, 1],
      [9_999, 1],
    ]);
  });

  it.each([
    ['negative', -1],
    ['non-integer', 1_700.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['beyond controlled range', 150_001],
    ['not a number', '1700'],
  ])('fails closed on a %s unit price instead of zero or one cent', (_name, value) => {
    expect(() => enrichUnitCeilCents(value)).toThrow('EXECUTION_BUDGET_QUOTE_UNAVAILABLE');
    expect(() =>
      projectEnrichContactPriceCatalog({ ...DEFAULTS, hunter: value as number }),
    ).toThrow('EXECUTION_BUDGET_QUOTE_UNAVAILABLE');
  });

  it('fails closed on a closed record that is missing or carrying an unknown provider', () => {
    expect(() =>
      projectEnrichContactPriceCatalog({ hunter: 1_700 } as never),
    ).toThrow('EXECUTION_BUDGET_QUOTE_UNAVAILABLE');
    expect(() =>
      projectEnrichContactPriceCatalog({ ...DEFAULTS, truelist: 1_400 } as never),
    ).toThrow('EXECUTION_BUDGET_QUOTE_UNAVAILABLE');
  });

  it('fails closed when an env override exceeds the controlled state range', () => {
    expect(() => enrichContactPriceCatalog({ HUNTER_COST_MICROUSD: '150001' })).toThrow(
      'EXECUTION_BUDGET_QUOTE_UNAVAILABLE',
    );
  });

  it('never carries provider credentials or base URLs into the catalog', () => {
    const catalog = enrichContactPriceCatalog({
      HUNTER_API_KEY: 'secret-hunter-key',
      HUNTER_BASE_URL: 'https://private.example.invalid',
      MILLIONVERIFIER_API_KEY: 'secret-millionverifier-key',
    });
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toMatch(/secret-|private\.example\.invalid/u);
  });
});
