import { CanonicalNode, TaxonomyKind } from './taxonomy-resolver';

/**
 * TED 覆盖的买方国别（EU-27 + EEA(ISL/LIE/NOR) + CHE + GBR），ISO-3。
 * 目标市场不在此集 → icp_fit_warning（TED 无该国数据），绝不静默返空（spec §2.4）。
 */
export const TED_COVERAGE: ReadonlySet<string> = new Set([
  'AUT', 'BEL', 'BGR', 'CHE', 'CYP', 'CZE', 'DEU', 'DNK', 'ESP', 'EST', 'FIN', 'FRA', 'GBR', 'GRC', 'HRV', 'HUN',
  'IRL', 'ISL', 'ITA', 'LIE', 'LTU', 'LUX', 'LVA', 'MLT', 'NLD', 'NOR', 'POL', 'PRT', 'ROU', 'SVK', 'SVN', 'SWE',
]);

/** resolveIcpToCpv 依赖的最小 taxonomy 面（结构化 —— 真 TaxonomyResolver 天然满足，便于单测替身）。 */
export interface CpvTaxonomyPort {
  resolveMany(kind: TaxonomyKind, terms: string[], opts?: { allowLlm?: boolean; workspaceId?: string }): Promise<CanonicalNode[]>;
  resolve(kind: TaxonomyKind, term: string, opts?: { allowLlm?: boolean; workspaceId?: string }): Promise<CanonicalNode | null>;
  resolveCpvForProduct(product: string, subtreePrefixes: string[], opts?: { allowLlm?: boolean; workspaceId?: string }): Promise<string | null>;
}

export interface IcpToCpvInput {
  industryTerms: string[];
  product?: string;
  targetCountries: string[];
}

export interface IcpToCpvResult {
  cpvCodes: string[];
  buyerCountries: string[]; // ISO-3（TED buyer-country 格式）
  warnings: string[];
}

/**
 * ICP → CPV 映射（冷路径：ICP 保存 / query-plan 生成时，**非发现热路径**；spec §2.3/§8.2）。
 * 混合：industry `crosswalk.cpv` 锚定（确定性子树，0 成本）+ 可选 product LLM 精修（枚举限子树）
 * + country 覆盖门。多租户不硬编码：CPV/国别全由 taxonomy 解析。
 * fail-safe：解析失败/缺种子 → 收集 warning，**绝不抛、绝不静默丢**目标市场。
 */
export async function resolveIcpToCpv(
  taxonomy: CpvTaxonomyPort,
  input: IcpToCpvInput,
  opts?: { allowLlm?: boolean; workspaceId?: string },
): Promise<IcpToCpvResult> {
  const warnings: string[] = [];

  // (a) 行业 → crosswalk.cpv 子树（确定性）
  const industryTerms = input.industryTerms.filter((t) => t && t.trim());
  const industryNodes = industryTerms.length ? await taxonomy.resolveMany('industry', industryTerms, opts) : [];
  const candidates = uniq(industryNodes.flatMap((n) => n.crosswalks?.cpv ?? []));

  // (b) 产品精修（可选，枚举限子树）；未命中回退宽网候选
  let cpvCodes = candidates;
  if (input.product?.trim() && candidates.length && opts?.allowLlm !== false) {
    const refined = await taxonomy.resolveCpvForProduct(input.product.trim(), candidates, opts);
    if (refined) cpvCodes = [refined];
  }

  if (industryNodes.length && !candidates.length) {
    warnings.push('icp_seed_gap: 行业已归一但无 CPV crosswalk（需补 seed-cpv 子树）');
  }

  // (c) 目标国 → alpha3（确定性），覆盖门：非覆盖国 → warning，绝不静默丢
  const buyerCountries: string[] = [];
  for (const t of input.targetCountries.filter((c) => c && c.trim())) {
    const node = await taxonomy.resolve('country', t, opts);
    const iso3 = node?.crosswalks?.alpha3?.[0];
    if (!iso3) {
      warnings.push(`icp_fit_warning: 目标市场无法归一到国别码 (${t})`);
      continue;
    }
    if (!TED_COVERAGE.has(iso3)) {
      warnings.push(`icp_fit_warning: TED 仅覆盖 EU/EEA/UK 买方 (${t})`);
      continue;
    }
    if (!buyerCountries.includes(iso3)) buyerCountries.push(iso3);
  }

  return { cpvCodes, buyerCountries, warnings };
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

/** 查询计划条目形状（与 discovery.query_plan 输出的 queries[] 结构一致）。 */
export interface PlanQueryShape {
  source_class: string;
  filters: Record<string, unknown>;
  keywords: string[];
  rationale: string;
  priority: number;
}

/**
 * 把 ICP→CPV 解析结果并入既有查询计划（§8.7 注入，纯函数便于单测）：
 *  - 有 CPV + 覆盖国 → 前置一条 TED 中标发现查询（priority 1，filters 由确定性解析注入，非 LLM 臆造）；
 *  - 无可用 CPV/国别但有覆盖 warning → 附到首条查询 rationale（人工门可见，绝不静默）；
 *  - 否则原样返回。
 */
export function buildTedQuery(cpv: IcpToCpvResult, planned: PlanQueryShape[]): PlanQueryShape[] {
  if (cpv.cpvCodes.length && cpv.buyerCountries.length) {
    const ted: PlanQueryShape = {
      source_class: 'public_intelligence',
      filters: { source_hint: 'ted', cpv: cpv.cpvCodes.join(','), buyer_country: cpv.buyerCountries.join(',') },
      keywords: [],
      rationale: 'TED 欧盟中标发现（ICP→CPV 冷路径解析）' + (cpv.warnings.length ? '；' + cpv.warnings.join('；') : ''),
      priority: 1,
    };
    return [ted, ...planned];
  }
  if (cpv.warnings.length && planned.length) {
    return planned.map((q, i) =>
      i === 0 ? { ...q, rationale: `${q.rationale ?? ''}\n[icp_fit_warning] ${cpv.warnings.join('；')}` } : q,
    );
  }
  return planned;
}
