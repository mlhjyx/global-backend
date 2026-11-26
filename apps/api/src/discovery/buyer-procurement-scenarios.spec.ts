import { describe, expect, it } from 'vitest';
import type { PlanQueryShape } from './icp-to-cpv';
import {
  draftBuyerProcurementScenarios,
  draftIndustrialPumpBuyerScenarios,
  prepareBuyerScenarioQueries,
  readBuyerProcurementScenario,
  readBuyerScenarioFromPlan,
} from './buyer-procurement-scenarios';
import { buildSearchQueries } from './providers/public-web.provider';

const sellerInput = {
  productId: 'offering-1',
  product: 'Chemische Prozesspumpe',
  targetMarket: 'Deutschland',
  evidenceRefs: ['approved-claim-1'],
};

const query: PlanQueryShape = {
  source_class: 'public_intelligence',
  filters: {
    source_hint: 'public_web',
    country: 'GB',
    region: 'London',
    iso_country: 'GB',
    buyer_country: 'GB',
    trade_side: 'manufacturer',
    business_model: '制造商',
    establishment_type: 'factory',
  },
  keywords: ['Kreiselpumpen'],
  rationale: '工业泵搜索',
  priority: 1,
};

describe('industrial pump buyer scenario pilot', () => {
  it('uses one confirmed product and market to draft three distinct search directions', () => {
    const drafts = draftIndustrialPumpBuyerScenarios(sellerInput);
    expect(drafts.map(({ id }) => id)).toEqual([
      'distribution', 'factory_direct', 'equipment_integration',
    ]);
    expect(drafts.every((draft) => draft.market === 'DE' && draft.productId === 'offering-1')).toBe(true);
    expect(drafts.every((draft) => draft.evidenceRefs.includes('approved-claim-1'))).toBe(true);
    expect(new Set(drafts.map((draft) => draft.keywords[0])).size).toBe(3);
  });

  it('honors a channel-only selection and treats an empty selection as no permission to expand', () => {
    expect(draftIndustrialPumpBuyerScenarios({ ...sellerInput, allowed: ['distribution'] })
      .map(({ id }) => id)).toEqual(['distribution']);
    expect(draftIndustrialPumpBuyerScenarios({ ...sellerInput, allowed: [] })).toEqual([]);
  });

  it('does not draft on unsupported markets, unrelated products, or unconfirmed inputs', () => {
    expect(draftIndustrialPumpBuyerScenarios({ ...sellerInput, targetMarket: 'DACH' })).toEqual([]);
    expect(draftIndustrialPumpBuyerScenarios({ ...sellerInput, product: 'Kamera' })).toEqual([]);
    expect(draftIndustrialPumpBuyerScenarios({ ...sellerInput, evidenceRefs: [] })).toEqual([]);
  });

  it('reads only a supported explicit scenario from saved attributes', () => {
    expect(readBuyerProcurementScenario({ procurement_scenario: 'factory_direct' }))
      .toBe('factory_direct');
    expect(readBuyerProcurementScenario({ procurement_scenario: 'consumer', trade_side: '工厂' }))
      .toBeNull();
    expect(readBuyerProcurementScenario({ trade_side: 'distributor' })).toBeNull();
  });

  it('does not direct factory searches to pump manufacturers, including fallback query filters', () => {
    const compiled = prepareBuyerScenarioQueries([query], 'factory_direct');
    expect(compiled[0]?.filters).toEqual({
      source_hint: 'public_web', country: 'DE', procurement_scenario: 'factory_direct',
    });
    const terms = buildSearchQueries({ ...compiled[0]!, sourceClass: 'public_intelligence', limit: 4 });
    expect(terms).toEqual([
      'Industrieabwasser Kreiselpumpen', 'Prozesspumpe Werk Beschaffung',
    ]);
    expect(terms.every((term) => !term.includes('Hersteller'))).toBe(true);
    expect(query.filters.trade_side).toBe('manufacturer');
  });

  it('carries equipment selection context as well as pump terms into web queries', () => {
    const [compiled] = prepareBuyerScenarioQueries([query], 'equipment_integration');
    const terms = buildSearchQueries({ ...compiled!, sourceClass: 'public_intelligence', limit: 4 });
    expect(terms.join(' ')).toContain('Pumpenauslegung');
    expect(terms.every((term) => !term.includes('Hersteller'))).toBe(true);
    expect(compiled?.filters.procurement_scenario).toBe('equipment_integration');
  });

  const wireQueries = (planned: PlanQueryShape[], scene: 'factory_direct' | 'equipment_integration') =>
    prepareBuyerScenarioQueries(planned, scene).map((compiled) =>
      buildSearchQueries({ ...compiled, sourceClass: 'public_intelligence', limit: 4 }),
    );

  it('does not classify a named factory search as a search for pump manufacturers', () => {
    const keyword = 'Papierfabrik Projekt Pumpenbeschaffung Leipzig';
    const [compiled] = prepareBuyerScenarioQueries([{ ...query, keywords: [keyword] }], 'factory_direct');
    expect(compiled?.keywords[0]).toBe(keyword);
    expect(wireQueries([{ ...query, keywords: [keyword] }], 'factory_direct')).toEqual([[keyword]]);
  });

  it('submits different planned projects as different queries, without replacing them with shared defaults', () => {
    const first = 'Kreiselpumpen Projekt Auslegung Wassertechnik Bremen';
    const second = 'Abwasserpumpen Anlagenprojekt Beschaffung Produktionswerk Köln';
    expect(wireQueries([
      { ...query, keywords: [first, first.toUpperCase(), '工业泵'] },
      { ...query, keywords: [second] },
    ], 'equipment_integration')).toEqual([[first], [second]]);
  });

  it('falls back only when no planned local search phrase is usable', () => {
    expect(wireQueries([{ ...query, keywords: ['工业泵', 'Kreiselpumpen', '... !!!', 'Pumpen ...'] }], 'factory_direct')).toEqual([
      ['Industrieabwasser Kreiselpumpen', 'Prozesspumpe Werk Beschaffung'],
    ]);
  });

  it('only reads a single consistent scenario across saved queries', () => {
    const compiled = prepareBuyerScenarioQueries([query, query], 'factory_direct');
    expect(readBuyerScenarioFromPlan(compiled)).toBe('factory_direct');
    expect(readBuyerScenarioFromPlan([compiled[0], query])).toBeNull();
    expect(readBuyerScenarioFromPlan([query])).toBeNull();
  });

  it('retains the Germany buyer filter in the TED distribution query', () => {
    const ted = { ...query, filters: { source_hint: 'ted', cpv: '42122000', buyer_country: 'DEU' } };
    const [compiled] = prepareBuyerScenarioQueries([ted], 'distribution');
    expect(compiled?.filters).toMatchObject({ source_hint: 'ted', cpv: '42122000', buyer_country: 'DEU' });
  });

  it('keeps channel role terms and leaves legacy queries unchanged', () => {
    const [compiled] = prepareBuyerScenarioQueries([query], 'distribution');
    expect(compiled?.filters.trade_side).toBe('distributor');
    expect(prepareBuyerScenarioQueries([query], null)).toEqual([query]);
  });

  it('drafts industry-agnostic procurement scenarios for non-pump global products (e.g. HJT solar in IT/AE/BR)', () => {
    const drafts = draftBuyerProcurementScenarios({
      productId: 'hjt-700w',
      product: 'HJT Solar Modules 700W+',
      targetMarket: 'Italia',
      evidenceRefs: ['claim-hjt-1'],
    });
    expect(drafts.map((d) => d.id)).toEqual(['distribution', 'factory_direct', 'equipment_integration']);
    expect(drafts.every((d) => d.market === 'IT')).toBe(true);
    expect(drafts[0]!.keywords[0]).toContain('HJT Solar Modules 700W+');
    expect(drafts.every((d) => !d.searchPurpose.includes('pump'))).toBe(true);
    expect(drafts[0]!.scenario).toBe('distribution');
    expect(drafts[0]!.recommended).toBe(true);
    expect(drafts[0]!.productLine).toBe('HJT Solar Modules 700W+');
  });

  it('generalizes prepareBuyerScenarioQueries to preserve non-DE target markets and ISO-3 TED buyer_country', () => {
    const itQuery: PlanQueryShape = {
      source_class: 'public_intelligence',
      filters: { source_hint: 'ted', country: 'IT', cpv: '09331200' },
      keywords: ['moduli fotovoltaici distributore'],
      rationale: 'IT solar',
      priority: 1,
    };
    const [compiledIt] = prepareBuyerScenarioQueries([itQuery], 'distribution', ['IT']);
    expect(compiledIt?.filters).toMatchObject({
      country: 'IT',
      buyer_country: 'ITA',
      trade_side: 'distributor',
      procurement_scenario: 'distribution',
    });

    const thQuery: PlanQueryShape = {
      source_class: 'public_intelligence',
      filters: { source_hint: 'public_web', country: 'TH' },
      keywords: ['food packaging machinery factory Thailand'],
      rationale: 'TH packaging',
      priority: 1,
    };
    const [compiledTh] = prepareBuyerScenarioQueries([thQuery], 'factory_direct', ['TH']);
    expect(compiledTh?.filters).toMatchObject({
      country: 'TH',
      procurement_scenario: 'factory_direct',
    });
    expect(compiledTh?.keywords).toEqual(['food packaging machinery factory Thailand']);
  });
});
