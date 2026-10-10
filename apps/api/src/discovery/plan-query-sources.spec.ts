import { describe, expect, it } from 'vitest';

import type { ModelGateway } from '../model-gateway/model-gateway';
import { MAX_QUERY_PLANNER_QUERIES } from './execution-envelope';
import { DiscoveryProviderRegistry } from './provider.registry';
import {
  PLANNER_SOURCE_GUIDE,
  SYSTEM_PLANNED_SOURCE_KEYS,
  hasPlannableSource,
  isSourceEnabled,
  planQueryRoutes,
  planQuerySkipReason,
  planQuerySourceHints,
  plannerSourcePrompt,
  routePlannerQueries,
  scaleEstimatedVolume,
  withDroppedQueryNote,
  type CompanyDiscoverySource,
} from './plan-query-sources';

/** What a registry built with a model gateway registers, in registration order. */
const REGISTERED: readonly CompanyDiscoverySource[] = Object.freeze([
  { sourceClass: 'public_intelligence', providerKey: 'public_web' },
  { sourceClass: 'industry_data', providerKey: 'public_web' },
  { sourceClass: 'industry_data', providerKey: 'directory' },
  { sourceClass: 'company_registry', providerKey: 'wikidata' },
  { sourceClass: 'industry_data', providerKey: 'wikidata' },
  { sourceClass: 'industry_data', providerKey: 'openstreetmap' },
  { sourceClass: 'industry_data', providerKey: 'trade_fair' },
  { sourceClass: 'public_intelligence', providerKey: 'ted' },
  { sourceClass: 'public_intelligence', providerKey: 'openfda' },
]);
const only = (...keys: string[]) =>
  REGISTERED.filter((source) => keys.includes(source.providerKey));

function query(
  sourceClass: string,
  filters: Record<string, unknown> = {},
  priority = 2,
) {
  return {
    source_class: sourceClass,
    filters,
    keywords: ['Kreiselpumpen'],
    rationale: 'synthetic',
    priority,
  };
}

describe('plan query source hints', () => {
  it.each([
    [undefined, []],
    [null, []],
    ['', []],
    ['   ', []],
    [' Public_Web ', ['public_web']],
    [['wikidata', 'TED', 'wikidata'], ['wikidata', 'ted']],
    [[], []],
  ])('reads %j as %j', (hint, expected) => {
    expect(planQuerySourceHints({ source_hint: hint })).toEqual(expected);
  });

  it.each([42, true, { key: 'public_web' }, ['public_web', 7]])(
    'treats an unusable hint %j as naming no source at all',
    (hint) => {
      expect(planQuerySourceHints({ source_hint: hint })).toBeNull();
    },
  );

  it('reads no hint from missing or non-object filters', () => {
    expect(planQuerySourceHints(undefined)).toEqual([]);
    expect(planQuerySourceHints(null)).toEqual([]);
  });
});

describe('plan query routing (the executor rule)', () => {
  it('routes a query without a hint to every source of its class, in registry order', () => {
    expect(planQueryRoutes(query('industry_data'), REGISTERED).map((s) => s.providerKey)).toEqual([
      'public_web', 'directory', 'wikidata', 'openstreetmap', 'trade_fair',
    ]);
  });

  it('narrows to the named source, exactly or by a legacy partial hint', () => {
    expect(planQueryRoutes(query('company_registry', { source_hint: 'wikidata' }), REGISTERED))
      .toEqual([{ sourceClass: 'company_registry', providerKey: 'wikidata' }]);
    expect(planQueryRoutes(query('industry_data', { source_hint: 'wiki' }), REGISTERED))
      .toEqual([{ sourceClass: 'industry_data', providerKey: 'wikidata' }]);
  });

  it('never routes across source classes or for an unusable hint', () => {
    expect(planQueryRoutes(query('company_registry', { source_hint: 'public_web' }), REGISTERED)).toEqual([]);
    expect(planQueryRoutes(query('trade_data'), REGISTERED)).toEqual([]);
    expect(planQueryRoutes(query('public_intelligence', { source_hint: 3 }), REGISTERED)).toEqual([]);
  });

  it('names a registered but unavailable source DISABLED and anything else UNKNOWN', () => {
    expect(planQuerySkipReason(query('company_registry', { source_hint: 'wikidata' }), REGISTERED))
      .toBe('SOURCE_DISABLED');
    expect(planQuerySkipReason(query('public_intelligence'), REGISTERED)).toBe('SOURCE_DISABLED');
    expect(planQuerySkipReason(query('trade_data'), REGISTERED)).toBe('SOURCE_UNKNOWN');
    expect(planQuerySkipReason(query('b2b_company_person'), REGISTERED)).toBe('SOURCE_UNKNOWN');
    expect(planQuerySkipReason(query('public_intelligence', { source_hint: 'missing' }), REGISTERED))
      .toBe('SOURCE_UNKNOWN');
    expect(planQuerySkipReason(query('public_intelligence', { source_hint: [1] }), REGISTERED))
      .toBe('SOURCE_UNKNOWN');
  });

  it('checks a cold-path source by the class and hint its injected query carries', () => {
    const ted = { sourceClass: 'public_intelligence' as const, providerKey: 'ted' };
    expect(isSourceEnabled(only('public_web', 'ted'), ted)).toBe(true);
    expect(isSourceEnabled(only('public_web'), ted)).toBe(false);
  });
});

describe('planner query routing (BI-30)', () => {
  it('keeps only queries for ENABLED sources and writes each one its exact source', () => {
    const planned = [
      query('public_intelligence'),
      query('company_registry', { industry: 'pumps', source_hint: 'wikidata' }),
      query('industry_data', { source_hint: 'openstreetmap' }),
      query('trade_data'),
      query('b2b_company_person'),
      query('industry_data', { source_hint: 'Public_Web', country: 'DE' }),
    ];

    const routed = routePlannerQueries(planned, { enabled: only('public_web'), registered: REGISTERED });

    expect(routed.queries).toEqual([
      { ...planned[0], filters: { source_hint: 'public_web' } },
      { ...planned[5], filters: { source_hint: 'public_web', country: 'DE' } },
    ]);
    expect(routed.dropped).toEqual({ SOURCE_DISABLED: 2, SOURCE_UNKNOWN: 2 });
    expect(routed.keptModelQueries).toBe(2);
  });

  it('leaves TED and openFDA to the cold path even while they are ENABLED', () => {
    const planned = [
      query('public_intelligence', { source_hint: 'ted' }),
      query('public_intelligence', { source_hint: 'openfda' }),
      query('public_intelligence'),
    ];

    const routed = routePlannerQueries(planned, {
      enabled: only('public_web', 'ted', 'openfda'),
      registered: REGISTERED,
    });

    expect(routed.queries.map((q) => q.filters.source_hint)).toEqual(['public_web']);
    expect(routed.dropped).toEqual({ SOURCE_SYSTEM_PLANNED: 2 });
  });

  it('gives a query without a hint one copy per ENABLED source of its class', () => {
    const planned = [query('industry_data', { industry: 'pumps' }, 3)];

    const routed = routePlannerQueries(planned, {
      enabled: only('public_web', 'directory', 'openstreetmap'),
      registered: REGISTERED,
    });

    expect(routed.queries).toEqual([
      { ...planned[0], filters: { industry: 'pumps', source_hint: 'public_web' } },
      { ...planned[0], filters: { industry: 'pumps', source_hint: 'directory' } },
      { ...planned[0], filters: { industry: 'pumps', source_hint: 'openstreetmap' } },
    ]);
    expect(routed.dropped).toEqual({});
    expect(routed.keptModelQueries).toBe(1);
  });

  it('keeps the most urgent copies within the planner query ceiling', () => {
    const planned = Array.from({ length: MAX_QUERY_PLANNER_QUERIES }, (_, index) =>
      query('industry_data', { area_name: `area-${index}` }, index === 0 ? 1 : 5));

    const routed = routePlannerQueries(planned, {
      enabled: only('public_web', 'directory'),
      registered: REGISTERED,
    });

    expect(routed.queries).toHaveLength(MAX_QUERY_PLANNER_QUERIES);
    expect(routed.dropped).toEqual({ PLAN_QUERY_CAP: MAX_QUERY_PLANNER_QUERIES });
    expect(routed.queries[0]).toMatchObject({ priority: 1, filters: { source_hint: 'public_web' } });
    expect(routed.queries[1]).toMatchObject({ priority: 1, filters: { source_hint: 'directory' } });
    expect(routed.queries.at(-1)).toMatchObject({ filters: { area_name: 'area-31', source_hint: 'directory' } });
    expect(routed.keptModelQueries).toBe(32);
  });

  it('never mutates the planner output', () => {
    const planned = [query('public_intelligence', { industry: 'pumps' })];
    const snapshot = structuredClone(planned);

    routePlannerQueries(planned, { enabled: only('public_web'), registered: REGISTERED });

    expect(planned).toEqual(snapshot);
  });
});

describe('planner source prompt (BI-30)', () => {
  it('lists only the ENABLED sources the planner may write, with their classes', () => {
    const prompt = plannerSourcePrompt(only('public_web'));

    expect(prompt).toContain('source_hint=public_web');
    expect(prompt).toContain('public_intelligence 或 industry_data');
    expect(prompt).toContain(PLANNER_SOURCE_GUIDE.public_web);
    for (const absent of ['wikidata', 'openstreetmap', 'directory', 'trade_fair', 'ted', 'openfda']) {
      expect(prompt).not.toContain(absent);
    }
  });

  it('tells the planner the system writes TED and openFDA queries only when they are ENABLED', () => {
    const prompt = plannerSourcePrompt(only('public_web', 'wikidata', 'ted'));

    expect(prompt).toContain('source_hint=wikidata（source_class：company_registry 或 industry_data）');
    expect(prompt).toContain('ted 的查询由系统按 ICP 确定性生成，不要自己写');
    expect(prompt).not.toContain('source_hint=ted');
    expect(prompt).not.toContain('openfda');
  });

  it('finds no plannable source when only cold-path sources are ENABLED', () => {
    expect(hasPlannableSource(only('ted', 'openfda'))).toBe(false);
    expect(hasPlannableSource([])).toBe(false);
    expect(hasPlannableSource(only('wikidata'))).toBe(true);
  });

  it('has guidance for every registered planner source and no hint ambiguity between keys', () => {
    const registered = new DiscoveryProviderRegistry({ gateway: {} as ModelGateway })
      .companyDiscoverySources();
    const keys = [...new Set(registered.map((source) => source.providerKey))];

    for (const key of keys) {
      expect(
        SYSTEM_PLANNED_SOURCE_KEYS.has(key) || Object.hasOwn(PLANNER_SOURCE_GUIDE, key),
        key,
      ).toBe(true);
    }
    // An exact hint must route to exactly one source: no key may contain another.
    for (const key of keys) {
      expect(keys.filter((other) => other !== key && other.includes(key)), key).toEqual([]);
    }
  });
});

describe('plan scale shown before confirmation (BI-30)', () => {
  it.each([
    [500, 5, 5, 500],
    [500, 5, 1, 100],
    [600, 21, 10, 286],
    [2.6, 1, 1, 3],
    [40, 0, 0, 40],
  ])('scales an estimate of %d over %d planned queries to %d kept → %d', (estimate, planned, kept, expected) => {
    expect(scaleEstimatedVolume(estimate, planned, kept)).toBe(expected);
  });

  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, '500'])(
    'keeps a missing or non-finite estimate %j as null',
    (estimate) => {
      expect(scaleEstimatedVolume(estimate, 3, 1)).toBeNull();
    },
  );

  it('reports no scale when none of the planned queries will run', () => {
    // Only cold-path queries are left, and nobody estimated those.
    expect(scaleEstimatedVolume(500, 5, 0)).toBeNull();
  });

  it('notes how many planner queries were left out, by reason, on the first query', () => {
    const queries = [query('public_intelligence', { source_hint: 'public_web' }), query('industry_data')];

    const noted = withDroppedQueryNote(queries, { SOURCE_DISABLED: 2, SOURCE_UNKNOWN: 1 });

    expect(noted[0]!.rationale).toBe(
      'synthetic\n[source_filter] 已移出 3 条规划查询：SOURCE_DISABLED 2 条、SOURCE_UNKNOWN 1 条',
    );
    expect(noted[1]).toBe(queries[1]);
    expect(queries[0]!.rationale).toBe('synthetic');
    expect(withDroppedQueryNote(queries, {})).toBe(queries);
  });
});
