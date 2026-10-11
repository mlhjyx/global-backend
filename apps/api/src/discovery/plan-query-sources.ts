import { MAX_QUERY_PLANNER_QUERIES } from './execution-envelope';
import type { DiscoveryQuerySkipReason } from './discovery-query-skip';
import type { PlanQueryShape } from './icp-to-cpv';
import type { SourceClass } from './provider-contract';

/**
 * Which data source a discovery plan query runs on (BI-30).
 *
 * The executor routes a query by `source_class` plus the optional
 * `filters.source_hint`: every ENABLED company discovery provider of that
 * class whose key the hint names. The planner and the executor share these
 * functions, so a plan written at planning time routes the same way when it
 * runs, and both read the same kill switch (`data_provider.status`).
 */

/** One provider a plan query can run on, under one of the provider's source classes. */
export interface CompanyDiscoverySource {
  readonly sourceClass: SourceClass;
  readonly providerKey: string;
}

/** The two plan query fields that route it. */
export interface PlanQueryRouting {
  readonly source_class?: unknown;
  readonly filters?: unknown;
}

/**
 * Sources whose plan queries only the system writes, from the deterministic
 * ICP cold path: TED needs CPV codes and buyer countries, openFDA needs FDA
 * product codes. The planner model must not invent codes, and without them
 * both providers return nothing, so the model never writes these queries.
 */
export const SYSTEM_PLANNED_SOURCE_KEYS: ReadonlySet<string> = new Set(['ted', 'openfda']);

/** What the planner model is told about each source it may write queries for. */
export const PLANNER_SOURCE_GUIDE: Readonly<Record<string, string>> = Object.freeze({
  public_web:
    '关键词搜索企业官网（SearXNG），按 keywords 检索，filters.industry 与 country 补充检索词',
  directory:
    '名录页抽取，按 filters.industry、keywords 与 country/region 检索行业名录、协会会员与展会参展商列表页',
  wikidata: 'Wikidata 公司库，按 filters.industry + country 零爬取查公司、官网与员工数',
  openstreetmap:
    'OpenStreetMap，按 filters.industry（映射成工业标签）+ country/region/area_name 枚举工厂',
  trade_fair:
    '展会参展商名录，按 filters.industry、keywords 与 region 匹配已登记的展会，取结构化参展商列表',
});

function filtersRecord(filters: unknown): Readonly<Record<string, unknown>> {
  return filters !== null && typeof filters === 'object' && !Array.isArray(filters)
    ? (filters as Record<string, unknown>)
    : {};
}

/**
 * The source hints a plan query names, trimmed and lowercased: [] when it
 * names none (its whole source class runs), null when the value is unusable
 * (a number, an object, a list with a non-string), which routes nowhere.
 */
export function planQuerySourceHints(filters: unknown): readonly string[] | null {
  const raw = filtersRecord(filters).source_hint;
  if (raw === undefined || raw === null) return [];
  const values: readonly unknown[] = Array.isArray(raw) ? raw : [raw];
  const hints: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') return null;
    const hint = value.trim().toLowerCase();
    if (hint && !hints.includes(hint)) hints.push(hint);
  }
  return hints;
}

/**
 * The executor's hint rule: the provider key itself, or a key that contains
 * the hint, which plans written before BI-30 relied on ("wiki" → wikidata).
 * No registered key contains another (a unit test holds this), so an exact
 * key names exactly one source.
 */
export function sourceHintMatches(providerKey: string, hint: string): boolean {
  return providerKey === hint || providerKey.includes(hint);
}

/** `candidates` narrowed by the query's source hints, in their given order. */
export function narrowBySourceHints<T>(
  filters: unknown,
  candidates: readonly T[],
  keyOf: (candidate: T) => string,
): T[] {
  const hints = planQuerySourceHints(filters);
  if (hints === null) return [];
  if (hints.length === 0) return [...candidates];
  return candidates.filter((candidate) =>
    hints.some((hint) => sourceHintMatches(keyOf(candidate), hint)),
  );
}

/** The sources among `sources` a plan query routes to: its class, narrowed by its hints. */
export function planQueryRoutes(
  query: PlanQueryRouting,
  sources: readonly CompanyDiscoverySource[],
): CompanyDiscoverySource[] {
  return narrowBySourceHints(
    query.filters,
    sources.filter((source) => source.sourceClass === query.source_class),
    (source) => source.providerKey,
  );
}

/** Why a query that routes to no ENABLED source is skipped, judged against every registered source. */
export function planQuerySkipReason(
  query: PlanQueryRouting,
  registered: readonly CompanyDiscoverySource[],
): DiscoveryQuerySkipReason {
  return planQueryRoutes(query, registered).length > 0 ? 'SOURCE_DISABLED' : 'SOURCE_UNKNOWN';
}

/** Whether a query naming exactly this source would run on an ENABLED provider. */
export function isSourceEnabled(
  enabled: readonly CompanyDiscoverySource[],
  source: CompanyDiscoverySource,
): boolean {
  return (
    planQueryRoutes(
      { source_class: source.sourceClass, filters: { source_hint: source.providerKey } },
      enabled,
    ).length > 0
  );
}

function plannable(sources: readonly CompanyDiscoverySource[]): CompanyDiscoverySource[] {
  return sources.filter((source) => !SYSTEM_PLANNED_SOURCE_KEYS.has(source.providerKey));
}

/** Whether the planner model has any ENABLED source to write queries for. */
export function hasPlannableSource(enabled: readonly CompanyDiscoverySource[]): boolean {
  return plannable(enabled).length > 0;
}

/**
 * The planner prompt's list of sources: only ENABLED ones, so the model does
 * not spend output on queries that cannot run.
 */
export function plannerSourcePrompt(enabled: readonly CompanyDiscoverySource[]): string {
  const classesByKey = new Map<string, string[]>();
  for (const source of plannable(enabled)) {
    classesByKey.set(source.providerKey, [
      ...(classesByKey.get(source.providerKey) ?? []),
      source.sourceClass,
    ]);
  }
  const rows = [...classesByKey].map(
    ([key, classes]) =>
      `- source_hint=${key}（source_class：${classes.join(' 或 ')}）：${PLANNER_SOURCE_GUIDE[key] ?? '按 filters 检索'}`,
  );
  const systemPlanned = [
    ...new Set(
      enabled
        .map((source) => source.providerKey)
        .filter((key) => SYSTEM_PLANNED_SOURCE_KEYS.has(key)),
    ),
  ];
  return [
    '可用数据源（当前已启用）。每条查询的 source_class 与 filters.source_hint 必须取下表同一行，不要为表外的数据源出查询，系统会丢弃：',
    ...rows,
    ...(systemPlanned.length
      ? [`${systemPlanned.join('、')} 的查询由系统按 ICP 确定性生成，不要自己写。`]
      : []),
  ].join('\n');
}

/** Why the planner left a model query (or, for PLAN_QUERY_CAP, a source copy of one) out of the plan. */
export const PLANNER_DROP_REASONS = Object.freeze([
  'SOURCE_DISABLED',
  'SOURCE_UNKNOWN',
  /** The query names TED or openFDA, whose queries only the cold path writes. */
  'SOURCE_SYSTEM_PLANNED',
  /** More source copies than the planner query ceiling; the least urgent are left out. */
  'PLAN_QUERY_CAP',
] as const);

export type PlannerDropReason = (typeof PLANNER_DROP_REASONS)[number];
export type PlannerDropCounts = Readonly<Partial<Record<PlannerDropReason, number>>>;

export interface PlannerQueryRouting<Q> {
  /** Runnable planner queries, each naming the exact key of the one source it runs on. */
  readonly queries: Q[];
  readonly dropped: PlannerDropCounts;
  /** How many model queries kept at least one runnable copy. */
  readonly keptModelQueries: number;
}

/** The order a plan runs in (loadPlanQueries): a missing priority runs last. */
function planPriority(priority: unknown): number {
  return typeof priority === 'number' && Number.isFinite(priority) ? priority : 99;
}

/**
 * Route the planner model's queries at planning time (BI-30). A query that
 * routes to no ENABLED source is left out and counted; every other query is
 * written once per ENABLED source it routes to, with `filters.source_hint` set
 * to that source's exact key, so each stored query states its one source. A
 * query without a hint therefore keeps the fan-out it had before, as explicit
 * copies. Copies beyond the planner query ceiling are left out, least urgent
 * first, so the plan stays within the quoted run envelope.
 */
export function routePlannerQueries<Q extends PlanQueryShape>(
  queries: readonly Q[],
  sources: Readonly<{
    enabled: readonly CompanyDiscoverySource[];
    registered: readonly CompanyDiscoverySource[];
  }>,
  cap: number = MAX_QUERY_PLANNER_QUERIES,
): PlannerQueryRouting<Q> {
  const enabled = plannable(sources.enabled);
  const registered = plannable(sources.registered);
  const dropped: Partial<Record<PlannerDropReason, number>> = {};
  const count = (reason: PlannerDropReason, by = 1): void => {
    dropped[reason] = (dropped[reason] ?? 0) + by;
  };
  const copies: Array<Readonly<{ origin: number; query: Q }>> = [];
  queries.forEach((query, origin) => {
    const routes = planQueryRoutes(query, enabled);
    if (routes.length === 0) {
      count(
        planQueryRoutes(query, registered).length > 0
          ? 'SOURCE_DISABLED'
          : planQueryRoutes(query, sources.registered).length > 0
            ? 'SOURCE_SYSTEM_PLANNED'
            : 'SOURCE_UNKNOWN',
      );
      return;
    }
    for (const route of routes) {
      copies.push({
        origin,
        query: {
          ...query,
          filters: { ...filtersRecord(query.filters), source_hint: route.providerKey },
        },
      });
    }
  });
  let kept = copies;
  if (copies.length > cap) {
    const keep = new Set(
      copies
        .map((copy, index) => ({ index, priority: planPriority(copy.query.priority) }))
        .sort((left, right) => left.priority - right.priority || left.index - right.index)
        .slice(0, cap)
        .map((entry) => entry.index),
    );
    kept = copies.filter((_, index) => keep.has(index));
    count('PLAN_QUERY_CAP', copies.length - kept.length);
  }
  return {
    queries: kept.map((copy) => copy.query),
    dropped,
    keptModelQueries: new Set(kept.map((copy) => copy.origin)).size,
  };
}

/**
 * The plan's estimated scale counts only the queries that will run: the
 * model's estimate covers every query it wrote, so it is scaled by the share
 * of its queries the plan keeps. Missing or non-finite estimates stay null,
 * and so does the scale of a plan that kept none of the model's queries (only
 * cold-path queries are left, and those were never estimated).
 */
export function scaleEstimatedVolume(
  estimate: unknown,
  plannedQueries: number,
  keptQueries: number,
): number | null {
  if (typeof estimate !== 'number' || !Number.isFinite(estimate)) return null;
  if (plannedQueries > 0 && keptQueries === 0) return null;
  const share = plannedQueries > 0 && keptQueries < plannedQueries ? keptQueries / plannedQueries : 1;
  return Math.round(estimate * share);
}

/**
 * Tell the human plan review how many planner queries were left out and why,
 * on the first query's rationale (the cold-path warnings use the same place).
 */
export function withDroppedQueryNote<Q extends PlanQueryShape>(
  queries: Q[],
  dropped: PlannerDropCounts,
): Q[] {
  const reasons = PLANNER_DROP_REASONS.filter((reason) => (dropped[reason] ?? 0) > 0);
  const [first, ...rest] = queries;
  if (!reasons.length || first === undefined) return queries;
  const total = reasons.reduce((sum, reason) => sum + (dropped[reason] ?? 0), 0);
  const note = `[source_filter] 已移出 ${total} 条规划查询：${reasons
    .map((reason) => `${reason} ${dropped[reason]} 条`)
    .join('、')}`;
  return [{ ...first, rationale: `${first.rationale ?? ''}\n${note}` }, ...rest];
}
