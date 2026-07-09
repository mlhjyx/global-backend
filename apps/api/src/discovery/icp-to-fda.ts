import { CanonicalNode, TaxonomyKind } from './taxonomy-resolver';
import { PlanQueryShape } from './icp-to-cpv';

// openFDA 仅美国市场 → ICP 目标市场门（镜像 TED 覆盖门，方向相反：非美国目标 → 不注入）。
const US_MARKET: ReadonlySet<string> = new Set(['us', 'usa', 'united states', 'united states of america', 'america', '美国', '美国市场', 'u.s.', 'u.s.a.']);
// 制造商侧 establishment_type 用**活值**（registrationlisting count 实测），非泛称 'Manufacturer'（exact 搜零命中）。
const MANUFACTURER_ESTABLISHMENT_TYPE = 'Manufacture Medical Device';

/** resolveIcpToFda 依赖的最小 taxonomy 面（结构化 —— 真 TaxonomyResolver 天然满足，便于单测替身）。 */
export interface FdaTaxonomyPort {
  resolveMany(kind: TaxonomyKind, terms: string[], opts?: { allowLlm?: boolean; workspaceId?: string }): Promise<CanonicalNode[]>;
  resolveFdaProductCode(product: string, panelCodes: string[], opts?: { allowLlm?: boolean; workspaceId?: string }): Promise<string | null>;
  listFdaProductCodes(panelCodes: string[]): Promise<string[]>;
}

export interface IcpToFdaInput {
  industryTerms: string[];
  product?: string;
  /** 贸易哪一侧：'importer'/'channel'=找美国进口渠道；'manufacturer'=找同类制造商。默认进口商（出海卖家最想要）。 */
  tradeSide?: string;
  /** ICP 目标市场（自由词）；非空且不含美国 → openFDA 仅美国市场，跳过注入（避免给 EU-only ICP 塞美国注册商）。 */
  targetCountries?: string[];
}

export interface IcpToFdaResult {
  productCodes: string[]; // FDA 3 字母 product code
  panels: string[]; // FDA 专科 panel 2 字母码
  importerOnly: boolean; // → registration.initial_importer_flag:Y（§8.1）
  establishmentTypes: string[]; // → establishment_type 过滤（制造商侧）
  warnings: string[];
}

/**
 * ICP → FDA 产品码映射（冷路径：ICP 保存 / query-plan 生成时，**非发现热路径**；spec §2.3/§2.4）。
 * 混合：industry `crosswalk.fdaPanels` 锚定（确定性）+ 可选 product LLM 精修（枚举**限 panel 子树**，
 * 绝不打全 6000 表）+ 未精修则 panel 宽网。多租户不硬编码：panel/码全由 taxonomy 解析。
 *
 * 国家维（与 TED EU-only 正相反）：FDA = 全美市场，**每条 registration 都是在卖进美国** → 无覆盖门/空返；
 * 租户选的是**贸易哪一侧**（进口渠道 vs 同类制造商）→ 落成 importerOnly / establishmentTypes（§2.4）。
 * fail-safe：解析失败/缺种子 → 收 warning，绝不抛。
 */
export async function resolveIcpToFda(
  taxonomy: FdaTaxonomyPort,
  input: IcpToFdaInput,
  opts?: { allowLlm?: boolean; workspaceId?: string },
): Promise<IcpToFdaResult> {
  const warnings: string[] = [];

  // (US 市场门) openFDA 只有在美注册商 → ICP 有明确目标市场且不含美国 → 不注入（绝不静默给 EU-only ICP 塞美国数据）。
  const targets = (input.targetCountries ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (targets.length && !targets.some((t) => US_MARKET.has(t))) {
    return { productCodes: [], panels: [], importerOnly: true, establishmentTypes: [], warnings: ['icp_fit_warning: openFDA 仅覆盖美国市场，本 ICP 目标市场不含美国 → 跳过 openFDA 注入'] };
  }

  // (a) 行业 → crosswalk.fdaPanels（+ 直锚 product code）确定性
  const industryTerms = input.industryTerms.filter((t) => t && t.trim());
  const industryNodes = industryTerms.length ? await taxonomy.resolveMany('industry', industryTerms, opts) : [];
  const panels = uniq(industryNodes.flatMap((n) => n.crosswalks?.fdaPanels ?? []));
  const directCodes = uniq(industryNodes.flatMap((n) => n.crosswalks?.fdaProductCodes ?? []));

  // (b) panel 侧码：product 精修（枚举限 panel 子树）→ 单码；否则 panel 宽网（整专科）。
  let panelCodes: string[] = [];
  if (panels.length) {
    if (input.product?.trim() && opts?.allowLlm !== false) {
      const refined = await taxonomy.resolveFdaProductCode(input.product.trim(), panels, opts);
      if (refined) panelCodes = [refined];
    }
    if (!panelCodes.length) panelCodes = await taxonomy.listFdaProductCodes(panels); // 宽网
  }
  // 直锚码（窄行业 crosswalk.fdaProductCodes）与 panel 侧码**并集**——两个独立来源，绝不互相覆盖（否则丢租户意图）。
  const productCodes = uniq([...directCodes, ...panelCodes]);

  if (industryNodes.length && !panels.length && !directCodes.length) {
    warnings.push('icp_seed_gap: 行业已归一但无 FDA panel/product 码 crosswalk（需补 seed-fda）');
  }
  if (panels.length && !panelCodes.length) {
    warnings.push('icp_seed_gap: panel 已锚定但子树下无 product code 种子');
  }

  // (c) 贸易侧 → establishmentTypeFilter（US 市场恒定）。free-form 输入 → 子串/多语言归一（'importers'/' importer '/
  // 'import channels'/'进口商'/'distributor'…）；制造商侧同理。未识别的非空值 → 默认进口渠道 + warn（绝不静默吞意图）。
  const side = (input.tradeSide ?? '').trim().toLowerCase();
  const manufacturerSide = /manufactur|\boem\b|\bpeer\b|制造商|厂商|生产商/.test(side);
  const importerSide = !side || /import|进口|channel|渠道|distribut|经销|reseller|分销/.test(side);
  let importerOnly = manufacturerSide ? false : importerSide;
  if (side && !manufacturerSide && !importerSide) {
    importerOnly = true;
    warnings.push(`icp_fit_warning: 未识别贸易侧「${input.tradeSide}」，默认按美国进口渠道（importer）`);
  }

  return {
    productCodes,
    panels,
    importerOnly,
    // 活值 exact（'Manufacturer' 泛称搜零命中；registrationlisting 主制造商类型 = 'Manufacture Medical Device'）。
    establishmentTypes: manufacturerSide ? [MANUFACTURER_ESTABLISHMENT_TYPE] : [],
    warnings,
  };
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}

/**
 * 把 ICP→FDA 解析结果并入既有查询计划（§8.7 注入，纯函数便于单测）：
 *  - 有 product code → 前置一条 openFDA 器械注册发现查询（priority 1，filters 确定性注入，非 LLM 臆造）；
 *  - 无码但有 warning → 附到首条查询 rationale（人工门可见，绝不静默）；否则原样返回。
 */
export function buildFdaQuery(fda: IcpToFdaResult, planned: PlanQueryShape[]): PlanQueryShape[] {
  if (fda.productCodes.length) {
    const filters: Record<string, unknown> = { source_hint: 'openfda', product_code: fda.productCodes.join(',') };
    if (fda.importerOnly) filters.trade_side = 'importer';
    if (fda.establishmentTypes.length) filters.establishment_type = fda.establishmentTypes.join(',');
    const q: PlanQueryShape = {
      source_class: 'public_intelligence',
      filters,
      keywords: [],
      rationale: 'openFDA 器械注册发现（ICP→FDA 产品码冷路径解析）' + (fda.warnings.length ? '；' + fda.warnings.join('；') : ''),
      priority: 1,
    };
    return [q, ...planned];
  }
  if (fda.warnings.length && planned.length) {
    return planned.map((q, i) => (i === 0 ? { ...q, rationale: `${q.rationale ?? ''}\n[icp_fit_warning] ${fda.warnings.join('；')}` } : q));
  }
  return planned;
}
