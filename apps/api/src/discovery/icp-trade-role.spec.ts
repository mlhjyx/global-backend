import { describe, expect, it } from 'vitest';
import { icpTradeRole, withIcpTradeRole } from './icp-trade-role';
import { buildSearchQueries } from './providers/public-web.provider';
import type { PlanQueryShape } from './icp-to-cpv';

function query(filters: Record<string, unknown>): PlanQueryShape {
  return {
    source_class: 'public_intelligence',
    filters,
    keywords: ['Kreiselpumpen'],
    rationale: 'planner',
    priority: 2,
  };
}

describe('icpTradeRole', () => {
  it.each([
    [{ trade_side: '进口商 / 分销商' }, 'distributor'],
    [{ business_model: 'Großhandel und Vertrieb' }, 'distributor'],
    [{ business_model: ['wholesale', 'distribution'] }, 'distributor'],
    [{ business_model: 'OEM manufacturer' }, 'manufacturer'],
    [{ trade_side: 'distributor', business_model: 'Hersteller' }, 'distributor'],
    [{ business_model: 'B2B' }, null],
    [{}, null],
    [null, null],
    [[], null],
  ])('reads %o as %s', (attributes, role) => {
    expect(icpTradeRole(attributes)).toBe(role);
  });
});

describe('withIcpTradeRole', () => {
  const distributorIcp = { industry: 'Pumpen', business_model: '工业泵分销商（批发）' };

  it('carries the ICP role into planner queries that name none, so keyword search gets role words', () => {
    const [carried] = withIcpTradeRole([query({ industry: 'Pumpen', country: 'Germany' })], distributorIcp);

    expect(carried!.filters).toMatchObject({ trade_side: 'distributor' });
    expect(buildSearchQueries({
      sourceClass: 'public_intelligence',
      filters: carried!.filters,
      keywords: carried!.keywords,
      limit: 25,
    }).join(' | ')).toMatch(/Großhandel/);
  });

  it('keeps a role the planner already named on the query', () => {
    const [kept] = withIcpTradeRole([query({ industry: 'Pumpen', trade_side: 'Hersteller' })], distributorIcp);

    expect(kept!.filters.trade_side).toBe('Hersteller');
  });

  it('leaves TED and openFDA queries alone', () => {
    const planned = [
      query({ source_hint: 'ted', cpv: '42120000', buyer_country: 'DEU' }),
      query({ source_hint: 'openfda', product_code: 'ABC' }),
    ];

    expect(withIcpTradeRole(planned, distributorIcp)).toEqual(planned);
  });

  it('changes nothing when the ICP names no recognizable trade role', () => {
    const planned = [query({ industry: 'Pumpen' })];

    expect(withIcpTradeRole(planned, { business_model: 'B2B' })).toEqual(planned);
    expect(withIcpTradeRole(planned, null)).toEqual(planned);
  });

  it('returns new query objects and never mutates the planner output', () => {
    const planned = [query({ industry: 'Pumpen' })];
    const snapshot = structuredClone(planned);

    const carried = withIcpTradeRole(planned, distributorIcp);

    expect(planned).toEqual(snapshot);
    expect(carried[0]).not.toBe(planned[0]);
  });

  it('Phase 1: does not stamp distributor trade_side onto OpenStreetMap or EPC/installer/developer/manufacturer queries', () => {
    const planned: PlanQueryShape[] = [
      {
        source_class: 'industry_data',
        filters: { source_hint: 'openstreetmap', country: 'Italy', industry: 'solar' },
        keywords: ['fotovoltaico'],
        rationale: 'osm',
        priority: 2,
      },
      {
        source_class: 'public_intelligence',
        filters: { source_hint: 'public_web', country: 'Italy', industry: 'photovoltaic' },
        keywords: ['EPC fotovoltaico', 'installatore impianti solari'],
        rationale: 'epc',
        priority: 2,
      },
      {
        source_class: 'public_intelligence',
        filters: { source_hint: 'public_web', country: 'Italy', sub_industry: 'solar park developer' },
        keywords: ['parco fotovoltaico', 'sviluppatore solare'],
        rationale: 'dev',
        priority: 2,
      },
      {
        source_class: 'public_intelligence',
        filters: { source_hint: 'public_web', country: 'Italy', industry: 'photovoltaic' },
        keywords: ['moduli fotovoltaici grossista'],
        rationale: 'dist',
        priority: 2,
      },
    ];

    const carried = withIcpTradeRole(planned, distributorIcp);

    expect(carried[0]!.filters.trade_side).toBeUndefined();
    expect(carried[1]!.filters.trade_side).toBeUndefined();
    expect(carried[2]!.filters.trade_side).toBeUndefined();
    expect(carried[3]!.filters.trade_side).toBe('distributor');
  });
});
