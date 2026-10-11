import { describe, expect, it } from 'vitest';

import type { ModelGateway } from '../model-gateway/model-gateway';
import { MAX_QUERY_PLANNER_QUERIES } from './execution-envelope';
import { DiscoveryProviderRegistry } from './provider.registry';
import {
  PLANNER_SOURCE_GUIDE,
  SYSTEM_PLANNED_SOURCE_KEYS,
  hasPlannableSource,
  isSourceRunnable,
  planQueryRoutes,
  planQuerySkipReason,
  planQuerySourceHints,
  plannerSourcePrompt,
  routePlannerQueries,
  scaleEstimatedVolume,
  withDroppedQueryNote,
  type CompanyDiscoverySource,
} from './plan-query-sources';

/**
 * What a registry built with a model gateway registers, in registration order.
 * Only public_web, directory and trade_fair declare governed company lineage.
 */
const REGISTERED: readonly CompanyDiscoverySource[] = Object.freeze([
  { sourceClass: 'public_intelligence', providerKey: 'public_web', hasCompanyLineage: true },
  { sourceClass: 'industry_data', providerKey: 'public_web', hasCompanyLineage: true },
  { sourceClass: 'industry_data', providerKey: 'directory', hasCompanyLineage: true },
  { sourceClass: 'company_registry', providerKey: 'wikidata', hasCompanyLineage: false },
  { sourceClass: 'industry_data', providerKey: 'wikidata', hasCompanyLineage: false },
  { sourceClass: 'industry_data', providerKey: 'openstreetmap', hasCompanyLineage: false },
  { sourceClass: 'industry_data', providerKey: 'trade_fair', hasCompanyLineage: true },
  { sourceClass: 'public_intelligence', providerKey: 'ted', hasCompanyLineage: false },
  { sourceClass: 'public_intelligence', providerKey: 'openfda', hasCompanyLineage: false },
]);
const only = (...keys: string[]) =>
  REGISTERED.filter((source) => keys.includes(source.providerKey));
/** The registered sources as they would be once `keys` declared governed lineage too. */
const withLineage = (...keys: string[]): CompanyDiscoverySource[] =>
  REGISTERED.map((source) =>
    keys.includes(source.providerKey) ? { ...source, hasCompanyLineage: true } : source);
const LINEAGE_LESS = ['wikidata', 'openstreetmap', 'ted', 'openfda'] as const;

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
      .toEqual([{ sourceClass: 'company_registry', providerKey: 'wikidata', hasCompanyLineage: false }]);
    expect(planQueryRoutes(query('industry_data', { source_hint: 'wiki' }), REGISTERED))
      .toEqual([{ sourceClass: 'industry_data', providerKey: 'wikidata', hasCompanyLineage: false }]);
  });

  it('never routes across source classes or for an unusable hint', () => {
    expect(planQueryRoutes(query('company_registry', { source_hint: 'public_web' }), REGISTERED)).toEqual([]);
    expect(planQueryRoutes(query('trade_data'), REGISTERED)).toEqual([]);
    expect(planQueryRoutes(query('public_intelligence', { source_hint: 3 }), REGISTERED)).toEqual([]);
  });

  it('names a registered but unavailable source DISABLED and anything else UNKNOWN', () => {
    expect(planQuerySkipReason(query('industry_data', { source_hint: 'directory' }), REGISTERED))
      .toBe('SOURCE_DISABLED');
    expect(planQuerySkipReason(query('public_intelligence'), REGISTERED)).toBe('SOURCE_DISABLED');
    expect(planQuerySkipReason(query('trade_data'), REGISTERED)).toBe('SOURCE_UNKNOWN');
    expect(planQuerySkipReason(query('b2b_company_person'), REGISTERED)).toBe('SOURCE_UNKNOWN');
    expect(planQuerySkipReason(query('public_intelligence', { source_hint: 'missing' }), REGISTERED))
      .toBe('SOURCE_UNKNOWN');
    expect(planQuerySkipReason(query('public_intelligence', { source_hint: [1] }), REGISTERED))
      .toBe('SOURCE_UNKNOWN');
  });

  it('names a source without governed lineage LINEAGE_UNAVAILABLE, ENABLED or not', () => {
    expect(planQuerySkipReason(query('company_registry', { source_hint: 'wikidata' }), REGISTERED))
      .toBe('SOURCE_LINEAGE_UNAVAILABLE');
    expect(planQuerySkipReason(query('industry_data', { source_hint: 'openstreetmap' }), REGISTERED))
      .toBe('SOURCE_LINEAGE_UNAVAILABLE');
    expect(planQuerySkipReason(query('public_intelligence', { source_hint: 'ted' }), REGISTERED))
      .toBe('SOURCE_LINEAGE_UNAVAILABLE');
    expect(planQuerySkipReason(query('public_intelligence', { source_hint: 'openfda' }), REGISTERED))
      .toBe('SOURCE_LINEAGE_UNAVAILABLE');
    // A class only lineage-less sources serve, and a legacy partial hint naming one of them.
    expect(planQuerySkipReason(query('company_registry'), REGISTERED)).toBe('SOURCE_LINEAGE_UNAVAILABLE');
    expect(planQuerySkipReason(query('industry_data', { source_hint: 'wiki' }), REGISTERED))
      .toBe('SOURCE_LINEAGE_UNAVAILABLE');
    // Once a source declares lineage, an unrouted query on it is DISABLED again.
    expect(planQuerySkipReason(query('company_registry', { source_hint: 'wikidata' }), withLineage('wikidata')))
      .toBe('SOURCE_DISABLED');
  });

  it('runs a cold-path source only while it is ENABLED and declares governed lineage', () => {
    const ted = { sourceClass: 'public_intelligence' as const, providerKey: 'ted' };
    const enabledWithLineage = withLineage('ted')
      .filter((source) => ['public_web', 'ted'].includes(source.providerKey));
    expect(isSourceRunnable(only('public_web', 'ted'), ted)).toBe(false);
    expect(isSourceRunnable(enabledWithLineage, ted)).toBe(true);
    expect(isSourceRunnable(only('public_web'), ted)).toBe(false);
  });
});

describe('planner query routing (BI-30)', () => {
  it('keeps only queries for ENABLED sources and writes each one its exact source', () => {
    const planned = [
      query('public_intelligence'),
      query('industry_data', { industry: 'pumps', source_hint: 'directory' }),
      query('industry_data', { source_hint: 'trade_fair' }),
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
      enabled: only('public_web', 'directory', 'trade_fair'),
      registered: REGISTERED,
    });

    expect(routed.queries).toEqual([
      { ...planned[0], filters: { industry: 'pumps', source_hint: 'public_web' } },
      { ...planned[0], filters: { industry: 'pumps', source_hint: 'directory' } },
      { ...planned[0], filters: { industry: 'pumps', source_hint: 'trade_fair' } },
    ]);
    expect(routed.dropped).toEqual({});
    expect(routed.keptModelQueries).toBe(1);
  });

  it('never plans an ENABLED source without governed lineage and counts why (lineage gate)', () => {
    const planned = [
      query('company_registry', { industry: 'pumps', source_hint: 'wikidata' }),
      query('industry_data', { source_hint: 'openstreetmap' }),
      query('company_registry'),
      query('industry_data', { industry: 'pumps' }),
    ];

    const routed = routePlannerQueries(planned, {
      enabled: only('public_web', ...LINEAGE_LESS),
      registered: REGISTERED,
    });

    // The hint-less industry query keeps its public_web copy and gets none for Wikidata or OSM.
    expect(routed.queries).toEqual([
      { ...planned[3], filters: { industry: 'pumps', source_hint: 'public_web' } },
    ]);
    expect(routed.dropped).toEqual({ SOURCE_LINEAGE_UNAVAILABLE: 3 });
    expect(routed.keptModelQueries).toBe(1);
  });

  it('plans a source again once it declares governed lineage', () => {
    const registered = withLineage('wikidata');

    const routed = routePlannerQueries([query('company_registry', { source_hint: 'wikidata' })], {
      enabled: registered.filter((source) => source.providerKey === 'wikidata'),
      registered,
    });

    expect(routed.queries.map((q) => q.filters.source_hint)).toEqual(['wikidata']);
    expect(routed.dropped).toEqual({});
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

  it('tells the planner the system writes TED and openFDA queries only when they can run', () => {
    const prompt = plannerSourcePrompt(
      withLineage('wikidata', 'ted').filter((source) =>
        ['public_web', 'wikidata', 'ted'].includes(source.providerKey)),
    );

    expect(prompt).toContain('source_hint=wikidata（source_class：company_registry 或 industry_data）');
    expect(prompt).toContain('ted 的查询由系统按 ICP 确定性生成，不要自己写');
    expect(prompt).not.toContain('source_hint=ted');
    expect(prompt).not.toContain('openfda');
  });

  it('never offers an ENABLED source without governed lineage to the planner (lineage gate)', () => {
    const prompt = plannerSourcePrompt(REGISTERED);

    for (const key of ['public_web', 'directory', 'trade_fair']) {
      expect(prompt).toContain(`source_hint=${key}`);
    }
    for (const absent of LINEAGE_LESS) {
      expect(prompt).not.toContain(absent);
    }
  });

  it('finds no plannable source when only cold-path or lineage-less sources are ENABLED', () => {
    expect(hasPlannableSource(only('ted', 'openfda'))).toBe(false);
    expect(hasPlannableSource([])).toBe(false);
    expect(hasPlannableSource(only(...LINEAGE_LESS))).toBe(false);
    expect(hasPlannableSource(only('directory'))).toBe(true);
    expect(hasPlannableSource(withLineage('wikidata').filter((s) => s.providerKey === 'wikidata')))
      .toBe(true);
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

  it('names the lineage gate in the note, right after the switched-off sources', () => {
    const queries = [query('public_intelligence', { source_hint: 'public_web' })];

    const noted = withDroppedQueryNote(queries, { SOURCE_LINEAGE_UNAVAILABLE: 2, SOURCE_DISABLED: 1 });

    expect(noted[0]!.rationale).toBe(
      'synthetic\n[source_filter] 已移出 3 条规划查询：SOURCE_DISABLED 1 条、SOURCE_LINEAGE_UNAVAILABLE 2 条',
    );
  });
});
