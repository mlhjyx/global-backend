import { MAX_QUERY_PLANNER_QUERIES, MAX_DISCOVERY_PROVIDER_RECORDS } from './execution-envelope';
import type { DiscoveryQuerySkipReason } from './discovery-query-skip';
import type { PlanQueryShape } from './icp-to-cpv';
import type { SourceClass } from './provider-contract';
import { selectFairs } from './trade-fairs';

/**
 * Which data source a discovery plan query runs on (BI-30).
 *
 * The executor routes a query by `source_class` plus the optional
 * `filters.source_hint`: every ENABLED company discovery provider of that
 * class whose key the hint names. The planner and the executor share these
 * functions, so a plan written at planning time routes the same way when it
 * runs, and both read the same kill switch (`data_provider.status`).
 *
 * Lineage gate: a source runs only if its provider also declares the governed
 * company lineage that materialization requires (`hasCompanyLineage`). A query
 * on a source without it is never planned or routed, even while ENABLED, and is
 * counted SOURCE_LINEAGE_UNAVAILABLE: running it would stall the run at
 * materialization.
 */

/** One provider a plan query can run on, under one of the provider's source classes. */
export interface CompanyDiscoverySource {
  readonly sourceClass: SourceClass;
  readonly providerKey: string;
  /**
   * Whether the provider's adapter declares the governed company lineage that
   * materialization requires (`declaresDiscoveryCompanyLineage`).
   */
  readonly hasCompanyLineage: boolean;
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

/**
 * Q33②（cheap-first）：默认路由顺序的结构化源优先级，数值越小越先保留。
 * 超出查询帽裁剪时先丢 public_web 副本（最贵：抓取 + LLM 抽取），结构化源副本优先；
 * 未列出的源取中间档 50。仅影响「裁剪时谁先留下」，不改变扇出语义（召回不降）。
 */
const SOURCE_ROUTE_PRIORITY: Readonly<Record<string, number>> = Object.freeze({
  wikidata: 10,
  openstreetmap: 15,
  ted: 20,
  openfda: 20,
  directory: 30,
  trade_fair: 35,
  structured_harvest: 40,
  digital_footprint: 45,
  public_web: 90,
});

/** 源键的路由优先级；非字符串或未登记取中间档 50。 */
function sourceRoutePriority(providerKey: unknown): number {
  return typeof providerKey === 'string' ? (SOURCE_ROUTE_PRIORITY[providerKey] ?? 50) : 50;
}

/** Q33② 开关：off 恢复旧行为；shadow（默认）保持旧行为但报告将替换量；enforce 应用结构化源优先裁剪。 */
export type CheapFirstMode = 'off' | 'shadow' | 'enforce';

export function cheapFirstMode(
  raw: string | undefined = process.env.DISCOVERY_CHEAP_FIRST,
): CheapFirstMode {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'off' || value === 'enforce' ? value : 'shadow';
}

/** Q33② 预算配置（env 可调）：结构化源每轮公司帽、新源试跑次数与每轮公司帽。 */
export interface SourceQueryBudgetConfig {
  readonly structuredRunCap: number;
  readonly trialMaxCompanies: number;
  readonly trialMaxRuns: number;
}

export function sourceQueryBudgetConfig(
  env: NodeJS.ProcessEnv = process.env,
): SourceQueryBudgetConfig {
  const positive = (raw: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt((raw ?? '').trim(), 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    structuredRunCap: positive(env.DISCOVERY_STRUCTURED_SOURCE_RUN_CAP, 100),
    trialMaxCompanies: positive(env.DISCOVERY_TRIAL_MAX_COMPANIES, 20),
    trialMaxRuns: positive(env.DISCOVERY_TRIAL_MAX_RUNS, 10),
  };
}

/**
 * 每个源的每轮查询预算：结构化源 = floor(公司帽 / 每查询每源记录上限)（默认 100/25 = 4 条，
 * 等价于每轮每源 ≤100 条原始公司记录）；试跑源收紧为 floor(20/25)→1 条（≤25 条）。
 * public_web 是兜底源，不设查询预算（其总量由公司池上限约束）。
 */
export function sourceQueryBudgets(
  trialProviders: ReadonlySet<string>,
  config: SourceQueryBudgetConfig,
  providerKeys: readonly string[],
): Record<string, number | undefined> {
  const budgets: Record<string, number | undefined> = {};
  for (const key of providerKeys) {
    if (key === 'public_web') continue;
    const cap = trialProviders.has(key) ? config.trialMaxCompanies : config.structuredRunCap;
    budgets[key] = Math.max(1, Math.floor(cap / MAX_DISCOVERY_PROVIDER_RECORDS));
  }
  return budgets;
}

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

/** The sources among `sources` whose provider declares governed company lineage. */
function withCompanyLineage(sources: readonly CompanyDiscoverySource[]): CompanyDiscoverySource[] {
  return sources.filter((source) => source.hasCompanyLineage);
}

/**
 * Why a query whose registered routes include no runnable source runs on
 * nothing: a source with governed lineage is only switched off, one without it
 * never runs. Null when the query routes to no registered source at all.
 */
function unroutedReason(
  routes: readonly CompanyDiscoverySource[],
): 'SOURCE_DISABLED' | 'SOURCE_LINEAGE_UNAVAILABLE' | null {
  if (routes.some((source) => source.hasCompanyLineage)) return 'SOURCE_DISABLED';
  return routes.length > 0 ? 'SOURCE_LINEAGE_UNAVAILABLE' : null;
}

/** Why a query that routes to no runnable source is skipped, judged against every registered source. */
export function planQuerySkipReason(
  query: PlanQueryRouting,
  registered: readonly CompanyDiscoverySource[],
): DiscoveryQuerySkipReason {
  return unroutedReason(planQueryRoutes(query, registered)) ?? 'SOURCE_UNKNOWN';
}

/**
 * Whether a query naming exactly this source would run: on an ENABLED provider
 * that declares governed company lineage.
 */
export function isSourceRunnable(
  enabled: readonly CompanyDiscoverySource[],
  source: Readonly<{ sourceClass: SourceClass; providerKey: string }>,
): boolean {
  return (
    planQueryRoutes(
      { source_class: source.sourceClass, filters: { source_hint: source.providerKey } },
      withCompanyLineage(enabled),
    ).length > 0
  );
}

function plannable(sources: readonly CompanyDiscoverySource[]): CompanyDiscoverySource[] {
  return sources.filter((source) => !SYSTEM_PLANNED_SOURCE_KEYS.has(source.providerKey));
}

/** Whether the planner model has any runnable source (ENABLED, with governed lineage) to write queries for. */
export function hasPlannableSource(enabled: readonly CompanyDiscoverySource[]): boolean {
  return plannable(withCompanyLineage(enabled)).length > 0;
}

/**
 * The planner prompt's list of sources: only runnable ones (ENABLED, with
 * governed lineage), so the model does not spend output on queries that cannot run.
 */
export function plannerSourcePrompt(enabled: readonly CompanyDiscoverySource[]): string {
  const runnable = withCompanyLineage(enabled);
  const classesByKey = new Map<string, string[]>();
  for (const source of plannable(runnable)) {
    classesByKey.set(source.providerKey, [
      ...(classesByKey.get(source.providerKey) ?? []),
      source.sourceClass,
    ]);
  }
  const rows = [...classesByKey]
    .sort(([left], [right]) => sourceRoutePriority(left) - sourceRoutePriority(right))
    .map(
      ([key, classes]) =>
        `- source_hint=${key}（source_class：${classes.join(' 或 ')}）：${PLANNER_SOURCE_GUIDE[key] ?? '按 filters 检索'}`,
    );
  const systemPlanned = [
    ...new Set(
      runnable
        .map((source) => source.providerKey)
        .filter((key) => SYSTEM_PLANNED_SOURCE_KEYS.has(key)),
    ),
  ];
  return [
    '可用数据源（当前已启用）。每条查询的 source_class 与 filters.source_hint 必须取下表同一行，不要为表外的数据源出查询，系统会丢弃：',
    '路由优先级：结构化源优先（公司库 → 名录/展会 → 官方采购/认证源），public_web 仅作兜底——只用于结构化源覆盖不到的行业、地区或角色。',
    '配额：结构化源每轮各约 ≤100 家公司；public_web 把公司池补到 500；新源前 10 次运行限量试跑。',
    ...rows,
    ...(systemPlanned.length
      ? [`${systemPlanned.join('、')} 的查询由系统按 ICP 确定性生成，不要自己写。`]
      : []),
  ].join('\n');
}

/**
 * Whether the ICP's own terms match any registered trade-fair template. The
 * trade-fair provider selects fairs with `selectFairs` from the query's
 * industry terms and keywords; an ICP matching none would only get trade_fair
 * queries that run on nothing and return zero records without an error
 * (2026-11-02: run 3212f6f3 ran eight such queries, all empty).
 */
export function icpMatchesRegisteredFairs(attributes: unknown): boolean {
  const record =
    attributes !== null && typeof attributes === 'object' && !Array.isArray(attributes)
      ? (attributes as Record<string, unknown>)
      : {};
  const strings = (value: unknown): string[] =>
    (Array.isArray(value) ? value : [value]).filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    );
  return (
    selectFairs({
      industryTerms: [...strings(record.industry), ...strings(record.sub_industry)],
      keywords: strings(record.keywords),
      region: '',
    }).length > 0
  );
}

/**
 * The enabled sources the planner prompt may list for this ICP: trade_fair is
 * left out when no registered fair matches (see icpMatchesRegisteredFairs).
 * The full enabled list still routes the model's queries, so a trade_fair query
 * the model writes anyway is not dropped as SOURCE_DISABLED — it just runs empty.
 */
export function plannerVisibleSources(
  enabled: readonly CompanyDiscoverySource[],
  tradeFairMatches: boolean,
): CompanyDiscoverySource[] {
  return tradeFairMatches
    ? [...enabled]
    : enabled.filter((source) => source.providerKey !== 'trade_fair');
}

/** Why the planner left a model query (or, for PLAN_QUERY_CAP, a source copy of one) out of the plan. */
export const PLANNER_DROP_REASONS = Object.freeze([
  'SOURCE_DISABLED',
  /** The query's registered sources have no governed company lineage (lineage gate). */
  'SOURCE_LINEAGE_UNAVAILABLE',
  'SOURCE_UNKNOWN',
  /** The query names TED or openFDA, whose queries only the cold path writes. */
  'SOURCE_SYSTEM_PLANNED',
  /** More source copies than the planner query ceiling; the least urgent are left out. */
  'PLAN_QUERY_CAP',
  /** More copies for one source than its per-run query budget (Q33② cheap-first). */
  'SOURCE_QUERY_BUDGET',
] as const);

export type PlannerDropReason = (typeof PLANNER_DROP_REASONS)[number];
export type PlannerDropCounts = Readonly<Partial<Record<PlannerDropReason, number>>>;

export interface PlannerQueryRouting<Q> {
  /** Runnable planner queries, each naming the exact key of the one source it runs on. */
  readonly queries: Q[];
  readonly dropped: PlannerDropCounts;
  /** How many model queries kept at least one runnable copy. */
  readonly keptModelQueries: number;
  /** cheap-first shadow（默认）下：按结构化源优先裁剪会替换掉的副本数与每源预算将移出数；off/enforce 时缺省。 */
  readonly cheapFirstShadow?: Readonly<{ replacedCopies: number; budgetDropped: number }>;
}

/**
 * The planner's drop counts plus one SOURCE_LINEAGE_UNAVAILABLE for each
 * cold-path source (TED, openFDA) that is ENABLED but has no governed lineage:
 * the lineage gate keeps out the query it would have injected, and the plan
 * review should see that in the [source_filter] note.
 */
export function countLineageGatedColdPaths(
  dropped: PlannerDropCounts,
  enabled: readonly CompanyDiscoverySource[],
  coldPathSources: readonly Readonly<{ sourceClass: SourceClass; providerKey: string }>[],
): PlannerDropCounts {
  const gated = coldPathSources.filter((source) =>
    planQueryRoutes(
      { source_class: source.sourceClass, filters: { source_hint: source.providerKey } },
      enabled,
    ).length > 0 && !isSourceRunnable(enabled, source),
  ).length;
  return gated === 0
    ? dropped
    : {
        ...dropped,
        SOURCE_LINEAGE_UNAVAILABLE: (dropped.SOURCE_LINEAGE_UNAVAILABLE ?? 0) + gated,
      };
}

/** The order a plan runs in (loadPlanQueries): a missing priority runs last. */
function planPriority(priority: unknown): number {
  return typeof priority === 'number' && Number.isFinite(priority) ? priority : 99;
}

/**
 * Route the planner model's queries at planning time (BI-30). A query that
 * routes to no runnable source (ENABLED, with governed lineage) is left out and
 * counted; every other query is written once per runnable source it routes to,
 * with `filters.source_hint` set to that source's exact key, so each stored
 * query states its one source. A query without a hint therefore keeps the
 * fan-out it had before, as explicit copies, but never onto a source without
 * governed lineage. Copies beyond the planner query ceiling are left out, least urgent
 * first, so the plan stays within the quoted run envelope.
 */
export function routePlannerQueries<Q extends PlanQueryShape>(
  queries: readonly Q[],
  sources: Readonly<{
    enabled: readonly CompanyDiscoverySource[];
    registered: readonly CompanyDiscoverySource[];
    /** Q33②：每源每轮查询预算（provider 键 → 预算条数；public_web 不在表内=不设预算）。 */
    sourceBudgets?: Readonly<Record<string, number | undefined>>;
  }>,
  cap: number = MAX_QUERY_PLANNER_QUERIES,
): PlannerQueryRouting<Q> {
  const enabled = plannable(withCompanyLineage(sources.enabled));
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
        unroutedReason(planQueryRoutes(query, registered)) ??
          (planQueryRoutes(query, sources.registered).length > 0
            ? 'SOURCE_SYSTEM_PLANNED'
            : 'SOURCE_UNKNOWN'),
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
  const mode = cheapFirstMode();
  // Q33② 每源查询预算：超出预算的副本按 query priority（再原序号）裁掉，enforce 才实际移除；
  // shadow 只统计将移出量；public_web 由兜底语义豁免（budgets 里没有它的键）。
  let budgetDropped = 0;
  let budgetApplied = copies;
  if (mode !== 'off' && sources.sourceBudgets) {
    const bySource = new Map<string, Array<{ index: number; priority: number }>>();
    copies.forEach((copy, index) => {
      const hint = filtersRecord(copy.query.filters).source_hint;
      // public_web 是兜底源：即使调用方误传预算也永不裁剪。
      if (typeof hint !== 'string' || hint === 'public_web') return;
      const budget = sources.sourceBudgets?.[hint];
      if (budget === undefined) return;
      const list = bySource.get(hint) ?? [];
      list.push({ index, priority: planPriority(copy.query.priority) });
      bySource.set(hint, list);
    });
    if (bySource.size) {
      const budgeted = new Set<number>();
      const keep = new Set<number>();
      for (const [hint, list] of bySource) {
        const budget = sources.sourceBudgets[hint] ?? 0;
        for (const entry of list) budgeted.add(entry.index);
        list
          .sort((left, right) => left.priority - right.priority || left.index - right.index)
          .slice(0, budget)
          .forEach((entry) => keep.add(entry.index));
      }
      const underBudget = copies.filter(
        (_, index) => !budgeted.has(index) || keep.has(index),
      );
      budgetDropped = copies.length - underBudget.length;
      if (mode === 'enforce') {
        budgetApplied = underBudget;
        if (budgetDropped > 0) count('SOURCE_QUERY_BUDGET', budgetDropped);
      }
    }
  }
  let kept = budgetApplied;
  let cheapFirstShadow: { replacedCopies: number; budgetDropped: number } | undefined;
  if (kept.length > cap) {
    // 两套排序只在「同 priority 时谁先保留」上不同：legacy 按原序号；cheap-first 先结构化源
    // （SOURCE_ROUTE_PRIORITY），public_web 副本最后保留。扇出本身不变，召回不降。
    const keepWithinCap = (withSourcePriority: boolean): ReadonlySet<number> =>
      new Set(
        kept
          .map((copy, index) => ({
            index,
            priority: planPriority(copy.query.priority),
            source: withSourcePriority
              ? sourceRoutePriority(filtersRecord(copy.query.filters).source_hint)
              : 0,
          }))
          .sort((left, right) =>
            left.priority - right.priority ||
            left.source - right.source ||
            left.index - right.index,
          )
          .slice(0, cap)
          .map((entry) => entry.index),
      );
    const legacyKeep = keepWithinCap(false);
    const keep = mode === 'enforce' ? keepWithinCap(true) : legacyKeep;
    if (mode === 'shadow') {
      const cheapKeep = keepWithinCap(true);
      cheapFirstShadow = {
        replacedCopies: [...cheapKeep].filter((index) => !legacyKeep.has(index)).length,
        budgetDropped,
      };
    }
    const withinCap = kept;
    kept = withinCap.filter((_, index) => keep.has(index));
    count('PLAN_QUERY_CAP', withinCap.length - kept.length);
  } else if (mode === 'shadow') {
    cheapFirstShadow = { replacedCopies: 0, budgetDropped };
  }
  return {
    queries: kept.map((copy) => copy.query),
    dropped,
    keptModelQueries: new Set(kept.map((copy) => copy.origin)).size,
    ...(cheapFirstShadow ? { cheapFirstShadow } : {}),
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

/**
 * cheap-first shadow（默认）下把「按结构化源优先裁剪将替换多少副本」写进计划首条查询的
 * rationale（与 [source_filter] 同位置），供人工计划 review 看到影子差异；enforce/off 无此注记。
 */
export function withCheapFirstShadowNote<Q extends PlanQueryShape>(
  queries: Q[],
  shadow: Readonly<{ replacedCopies: number; budgetDropped?: number }> | undefined,
): Q[] {
  const [first, ...rest] = queries;
  const replaced = shadow?.replacedCopies ?? 0;
  const budgetDropped = shadow?.budgetDropped ?? 0;
  if (!shadow || (replaced <= 0 && budgetDropped <= 0) || first === undefined) return queries;
  const parts: string[] = [];
  if (replaced > 0) parts.push(`按结构化源优先裁剪将替换 ${replaced} 条查询副本`);
  if (budgetDropped > 0) parts.push(`按每源查询预算将移出 ${budgetDropped} 条查询`);
  const note = `[cheap-first shadow] ${parts.join('；')}（当前 DISCOVERY_CHEAP_FIRST=shadow，未实际启用）`;
  return [{ ...first, rationale: `${first.rationale ?? ''}\n${note}` }, ...rest];
}
