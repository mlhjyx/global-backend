import { CanonicalNode, TaxonomyKind } from './taxonomy-resolver';

/**
 * SAM.gov = 美国联邦市场 → ICP 目标市场门（镜像 openFDA，方向相同：非美国目标 → 不注入，
 * 避免给 EU-only ICP 塞美国联邦意图）。
 */
const US_MARKET: ReadonlySet<string> = new Set([
  'us', 'usa', 'united states', 'united states of america', 'america', '美国', '美国市场', 'u.s.', 'u.s.a.',
]);

/** resolveIcpToNaics 依赖的最小 taxonomy 面（结构化 —— 真 TaxonomyResolver 天然满足，便于单测替身）。 */
export interface NaicsTaxonomyPort {
  resolveMany(kind: TaxonomyKind, terms: string[], opts?: { allowLlm?: boolean; workspaceId?: string }): Promise<CanonicalNode[]>;
  resolveNaicsForProduct(product: string, subtreePrefixes: string[], opts?: { allowLlm?: boolean; workspaceId?: string }): Promise<string | null>;
}

export interface IcpToNaicsInput {
  industryTerms: string[];
  product?: string;
  /** ICP 目标市场（自由词）；非空且不含美国 → SAM 仅美国联邦市场，跳过注入。 */
  targetCountries?: string[];
}

export interface IcpToNaicsResult {
  naicsCodes: string[]; // NAICS 2–6 位码（前缀层级）
  warnings: string[];
}

/**
 * ICP → NAICS 映射（冷路径：ICP 保存 / query-plan 生成时，非发现热路径）。
 * 混合：industry `crosswalk.naics` 锚定（确定性子树，0 成本）+ 可选 product LLM 精修（枚举限子树）。
 * 多租户不硬编码：NAICS 全由 taxonomy 解析。
 *
 * 国家维（同 openFDA，方向与 TED EU-only 相反）：SAM = 全美联邦市场，**每条 Sources Sought 都是美国联邦需求**
 * → 无 CPV 那种覆盖门；ICP 目标市场明确不含美国时才跳过（绝不给 EU-only ICP 塞美国数据）。
 * fail-safe：解析失败/缺种子 → 收 warning，**绝不抛、绝不静默丢**。
 */
export async function resolveIcpToNaics(
  taxonomy: NaicsTaxonomyPort,
  input: IcpToNaicsInput,
  opts?: { allowLlm?: boolean; workspaceId?: string },
): Promise<IcpToNaicsResult> {
  const warnings: string[] = [];

  // (US 市场门) SAM 只有美国联邦机会 → ICP 有明确目标市场且不含美国 → 不注入（绝不静默给 EU-only ICP 塞美国数据）。
  const targets = (input.targetCountries ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (targets.length && !targets.some((t) => US_MARKET.has(t))) {
    return { naicsCodes: [], warnings: ['icp_fit_warning: SAM.gov 仅覆盖美国联邦市场，本 ICP 目标市场不含美国 → 跳过 SAM 注入'] };
  }

  // (a) 行业 → crosswalk.naics 子树（确定性）
  const industryTerms = input.industryTerms.filter((t) => t && t.trim());
  const industryNodes = industryTerms.length ? await taxonomy.resolveMany('industry', industryTerms, opts) : [];
  const candidates = uniq(industryNodes.flatMap((n) => n.crosswalks?.naics ?? []));

  // (b) 产品精修（枚举限子树）；未命中回退宽网候选。
  // 🔴 不用 allowLlm 门包裹调用：resolveNaicsForProduct 内部**自压 LLM**（allowLlm:false 时只走确定性
  // TermAlias/seed 别名命中、零 LLM）。若这里加 allowLlm!==false 门，sweep（allowLlm:false）会连确定性精修
  // 一起跳过 → 泵 ICP 停在广码 333 → NAICS 前缀 overlap 匹配所有 333… 机械公告（噪声、demand proof 虚高）。
  // 让确定性精修在 sweep 也生效：pumps→333914（seed 别名），零成本。
  let naicsCodes = candidates;
  if (input.product?.trim() && candidates.length) {
    const refined = await taxonomy.resolveNaicsForProduct(input.product.trim(), candidates, opts);
    if (refined) naicsCodes = [refined];
  }

  if (industryNodes.length && !candidates.length) {
    warnings.push('icp_seed_gap: 行业已归一但无 NAICS crosswalk（需补 seed-naics 子树）');
  }

  return { naicsCodes, warnings };
}

function uniq(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))];
}
