import { ConflictException } from '@nestjs/common';
import { TED_QUERY_SOURCE, type PlanQueryShape } from './icp-to-cpv';
import { searchableTerms, searchLanguageFor, targetCountryCodes } from './search-localization';

const SCENARIOS = {
  distribution: {
    label: '经销进口',
    keywords: ['Industriepumpen Großhandel', 'Industriepumpen Fachhandel'],
    searchPurpose: 'Find distributors of relevant industrial pumps and evidence of resale.',
    evidence: '核对在售相关泵种及分销证据；有自有制造也可凭独立经销证据匹配。',
  },
  factory_direct: {
    label: '工厂直采',
    keywords: ['Industrieabwasser Kreiselpumpen', 'Prozesspumpe Werk Beschaffung'],
    searchPurpose: 'Find a production site using pumps in its own operations, not a pump manufacturer.',
    evidence: '核对工厂及其自用工艺、产线或项目中的相关泵种；无需证明转售。',
  },
  equipment_integration: {
    label: '设备或工程配套',
    keywords: ['Pumpenauslegung Anlagenbau', 'Prozesspumpen Systemintegration'],
    searchPurpose: 'Find equipment builders or contractors responsible for pump selection or integration.',
    evidence: '有证据的工程选型、集成或采购责任可以作为角色证据；无需证明转售。',
  },
} as const;

export type BuyerProcurementScenario = keyof typeof SCENARIOS;

const scenarioIds = Object.keys(SCENARIOS) as BuyerProcurementScenario[];
const INDUSTRIAL_PUMP = /工业泵|化工流程泵|\bindustrial pumps?\b|\bchemical process pumps?\b|\b(?:industrie|prozess)pumpen?\b/iu;
const SCENARIO_SEARCH_SOURCES = new Set(['public_web', 'model_web_search', 'directory']);

export function isGermanIndustrialPumpPilot(product: unknown, markets: unknown): boolean {
  const singleProduct = Array.isArray(product) && product.length === 1 ? product[0] : product;
  const singleMarket = Array.isArray(markets) && markets.length === 1 ? markets[0] : markets;
  if (typeof singleProduct !== 'string' || typeof singleMarket !== 'string') return false;
  const countries = targetCountryCodes({ filters: { country: singleMarket } });
  return INDUSTRIAL_PUMP.test(singleProduct) && countries.length === 1 && countries[0] === 'de';
}

export function draftIndustrialPumpBuyerScenarios(input: {
  productId: string;
  product: string;
  targetMarket: string;
  evidenceRefs: readonly string[];
  allowed?: readonly BuyerProcurementScenario[];
}) {
  const evidenceRefs = [...new Set(input.evidenceRefs.filter((ref) => !!ref.trim()))];
  if (!input.productId.trim() || !evidenceRefs.length || !isGermanIndustrialPumpPilot(input.product, input.targetMarket)) {
    return [];
  }
  return scenarioIds.filter((id) => input.allowed === undefined || input.allowed.includes(id))
    .map((id) => ({
      market: 'DE',
      productId: input.productId,
      product: input.product,
      evidenceRefs,
      ...buyerProcurementCriteria(id),
      keywords: [...SCENARIOS[id].keywords],
    }));
}

export function readBuyerProcurementScenario(attributes: unknown): BuyerProcurementScenario | null {
  if (!attributes || typeof attributes !== 'object' || !Object.hasOwn(attributes, 'procurement_scenario')) {
    return null;
  }
  const value = (attributes as Record<string, unknown>).procurement_scenario;
  return typeof value === 'string' && Object.hasOwn(SCENARIOS, value)
    ? value as BuyerProcurementScenario
    : null;
}

/** A confirmed plan uses one server-selected scenario across its queries. Unmarked plans are legacy. */
export function readBuyerScenarioFromPlan(queries: unknown): BuyerProcurementScenario | null {
  if (!Array.isArray(queries) || queries.length === 0) return null;
  const readQuery = (entry: unknown) =>
    entry && typeof entry === 'object'
      ? readBuyerProcurementScenario((entry as { filters?: unknown }).filters)
      : null;
  const scenario = readQuery(queries[0]);
  return scenario && queries.every((entry) => readQuery(entry) === scenario) ? scenario : null;
}

export function buyerProcurementCriteria(id: BuyerProcurementScenario) {
  const { label, searchPurpose, evidence } = SCENARIOS[id];
  return { id, label, searchPurpose, evidence };
}

export function buyerProcurementQualificationSystem(
  base: string,
  criteria?: ReturnType<typeof buyerProcurementCriteria>,
): string {
  return criteria
    ? `${base}\n显式采购场景优先于未指定贸易角色的默认规则。角色及商业模式门按场景判断：${criteria.evidence}`
    : base;
}

export function buyerScenarioSupportsSource(scenario: BuyerProcurementScenario | null, providerKey: string): boolean {
  return scenario === null || scenario === 'distribution' || SCENARIO_SEARCH_SOURCES.has(providerKey);
}

export function prepareBuyerScenarioQueries<T extends PlanQueryShape>(
  queries: readonly T[],
  scenario: BuyerProcurementScenario | null,
): T[] {
  if (!scenario) return [...queries];
  return queries.map((query) => {
    const filters: Record<string, unknown> = { ...query.filters, country: 'DE', procurement_scenario: scenario };
    for (const key of ['iso_country', 'buyer_country', 'region']) delete filters[key];
    if (scenario === 'distribution') {
      // TED reads ISO-3 buyer_country, not the ordinary country filter.
      if (filters.source_hint === TED_QUERY_SOURCE.providerKey) filters.buyer_country = 'DEU';
      return { ...query, filters: { ...filters, trade_side: 'distributor' } };
    }

    for (const key of ['trade_side', 'business_model', 'establishment_type', 'role']) {
      delete filters[key];
    }
    // Free text is not a company role. Removing a phrase because it contains
    // “Fabrik” loses valid searches for factories as buyers. Prefer the
    // planner's full local phrases; a bare category alone needs a fallback.
    const localPhrases = searchableTerms(query.keywords, searchLanguageFor({ filters }))
      .filter((keyword) => keyword.split(/\s+/u).filter((word) => /\p{L}/u.test(word)).length >= 2);
    const byLowercase = new Set<string>();
    const keywords = (localPhrases.length ? localPhrases : SCENARIOS[scenario].keywords)
      .filter((keyword) => {
        const key = keyword.toLowerCase().replace(/\s+/gu, ' ');
        if (byLowercase.has(key)) return false;
        byLowercase.add(key);
        return true;
      })
      .slice(0, 32);
    return { ...query, filters, keywords };
  });
}

export function addConfirmedBuyerScenarioDrafts(
  attributes: Record<string, unknown>,
  offeringBasis: string,
  offerings: readonly { id?: string; name: string }[],
  confirmedMarkets: readonly string[] | null | undefined,
): void {
  const offering = offeringBasis === 'selected_products' && offerings.length === 1 ? offerings[0] : undefined;
  if (!offering?.id || confirmedMarkets?.length !== 1) return;
  const drafts = draftIndustrialPumpBuyerScenarios({
    product: offering.name, productId: offering.id, targetMarket: confirmedMarkets[0]!, evidenceRefs: [`offering:${offering.id}`],
  });
  if (drafts.length) attributes.procurement_scenario_drafts = drafts;
}

export function assertSupportedBuyerScenario(
  input: unknown, markets: unknown, scenario: BuyerProcurementScenario | null,
): void {
  const attributes = input as Record<string, unknown> | null;
  if (attributes?.procurement_scenario != null && (!scenario || !isGermanIndustrialPumpPilot(attributes.product, markets))) {
    throw new ConflictException({ error: {
      code: 'PROCUREMENT_SCENARIO_NOT_SUPPORTED',
      message: 'procurement scenes require a supported scenario, an industrial pump product, and Germany as the only market',
    } });
  }
}

export function buyerScenarioPlannerNote(scenario: BuyerProcurementScenario | null): string {
  if (!scenario) return '';
  const criteria = buyerProcurementCriteria(scenario);
  const heading = `\n\n采购场景：${criteria.label}。 ${criteria.searchPurpose} ${criteria.evidence}`;
  return heading + (scenario === 'distribution' ? '' :
    '\n生成相互有区别的完整检索短语：用泵种、工艺或项目中的实际责任（自用、选型、集成或采购），并写入已知市场或地区。优先寻找项目案例、招采或工艺内容，避免只搜泵厂家目录。不猜造公司或项目名称。');
}
