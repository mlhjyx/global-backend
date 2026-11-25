import { classifySellerWebsiteChannel, type SellerWebsiteChannel } from '../company/seller-source-allowlist';
import { icpTradeRole } from '../discovery/icp-trade-role';
import type { BuyerProcurementScenario } from '../discovery/buyer-procurement-scenarios';
import { targetCountryCodes } from '../discovery/search-localization';

export interface IcpSellerProfileLayer {
  readonly company_name: string;
  readonly website: string | null;
  readonly industry: string | null;
  readonly offerings: readonly string[];
  readonly technical_specs: readonly string[];
  readonly source_channel: SellerWebsiteChannel | 'pdf_brochure' | 'description' | null;
}

export interface IcpBuyerSpecLayer {
  readonly target_roles: readonly string[];
  readonly trade_side: string;
  readonly product_categories: readonly string[];
  readonly industries: readonly string[];
  readonly target_markets: readonly string[];
  readonly process_required: boolean;
  readonly company_size: string | null;
  readonly procurement_scenario: BuyerProcurementScenario | null;
}

export interface IcpPeerExclusionsLayer {
  readonly excluded_business_models: readonly string[];
  readonly excluded_keywords: readonly string[];
  readonly excluded_domains: readonly string[];
  readonly rationale: string | null;
}

export interface GenerateIcpOverrides {
  readonly name?: string;
  readonly productLines?: readonly string[];
  readonly buyerRoles?: readonly string[];
  readonly procurementScenario?: BuyerProcurementScenario;
  readonly peerExclusionNotes?: readonly string[];
}

const SELLER_TECH_SPEC_RE =
  /\b(?:HJT|TOPCon|PERC|0BB|G12|M10|N-?type|bifacial|\d{2,4}\s*(?:Wp?|kW|MW|MPa|bar|mm|rpm|kV|Hz)|±\s*\d+(?:\.\d+)?\s*(?:mm|µm|um)|ISO\s*\d{4,5}|IATF\s*16949|IEC\s*6\d{4}|IP6[5-9])\b/giu;

const NON_MANUFACTURING_ROLES = new Set(['distributor', 'epc_integrator', 'wholesaler', 'importer', 'reseller']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[,，、;；\n]+/u)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function uniqueStrings(items: Iterable<string>, cap = 30): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= cap) break;
  }
  return out;
}

function extractTechnicalSpecs(texts: readonly string[]): string[] {
  const specs: string[] = [];
  for (const text of texts) {
    for (const match of text.match(SELLER_TECH_SPEC_RE) ?? []) {
      specs.push(match.trim());
    }
  }
  return uniqueStrings(specs, 20);
}

function stripTechnicalSpecTokens(category: string): string {
  return category
    .replace(SELLER_TECH_SPEC_RE, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[-–—/+,\s]+|[-–—/+,\s]+$/gu, '')
    .trim();
}

function hostFromWebsite(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    return new URL(website).hostname.replace(/^www\./iu, '').toLowerCase();
  } catch {
    return null;
  }
}

export function resolveOfferingsForOverrides<T extends { name: string; description: string | null; attributes: unknown }>(
  offerings: readonly T[],
  productLines?: readonly string[],
): T[] {
  if (!productLines || productLines.length === 0) return [...offerings];
  const wanted = uniqueStrings(productLines, 10);
  const wantedLower = wanted.map((w) => w.toLowerCase());
  const matched = offerings.filter((o) =>
    wantedLower.some((w) => o.name.toLowerCase().includes(w) || w.includes(o.name.toLowerCase())),
  );
  if (matched.length > 0) return matched;
  return wanted.map((name) => ({
    name,
    description: null,
    attributes: { selectedByUser: true },
  })) as T[];
}

export function buildMultiIcpPromptFocus(overrides?: GenerateIcpOverrides): string {
  if (!overrides) return '';
  const lines: string[] = [];
  if (overrides.name?.trim()) {
    lines.push(`- 指定的 ICP 名称方向：${overrides.name.trim()}`);
  }
  if (overrides.productLines?.length) {
    lines.push(`- 本 ICP 仅聚焦以下产品线：${overrides.productLines.join('、')}`);
  }
  if (overrides.buyerRoles?.length) {
    lines.push(`- 本 ICP 指定的下游买家角色：${overrides.buyerRoles.join('、')}`);
  }
  if (overrides.procurementScenario) {
    lines.push(`- 本 ICP 指定的采购场景：${overrides.procurementScenario}`);
  }
  if (overrides.peerExclusionNotes?.length) {
    lines.push(`- 卖方补充排除（必须纳入 exclusions / peer_exclusions）：${overrides.peerExclusionNotes.join('；')}`);
  }
  if (lines.length === 0) return '';
  return `\n\n本条 ICP 的专项聚焦要求（多 ICP 场景）：\n${lines.join('\n')}`;
}

export function buildThreeLayerIcpAttributes(input: {
  readonly company: {
    readonly name: string;
    readonly website?: string | null;
    readonly industry?: string | null;
    readonly summary?: string | null;
  };
  readonly offerings: readonly { readonly name: string; readonly description?: string | null }[];
  readonly companyAttributes: Record<string, unknown>;
  readonly exclusions: unknown;
  readonly targetMarkets: readonly unknown[];
  readonly overrides?: GenerateIcpOverrides;
}): Record<string, unknown> {
  const attrs = { ...input.companyAttributes };
  const offeringNames = uniqueStrings(input.offerings.map((o) => o.name), 20);
  const techSpecs = extractTechnicalSpecs([
    ...offeringNames,
    ...input.offerings.map((o) => o.description ?? ''),
    ...asStrings(attrs.tech),
    ...asStrings(attrs.specifications),
  ]);

  const websiteChannel = classifySellerWebsiteChannel(input.company.website);
  const sellerSourceChannel: IcpSellerProfileLayer['source_channel'] =
    websiteChannel ?? (input.company.summary?.trim() ? 'description' : null);

  const existingSeller = isPlainRecord(attrs.seller_profile) ? attrs.seller_profile : {};
  const sellerProfile: IcpSellerProfileLayer = {
    company_name: input.company.name,
    website: input.company.website ?? null,
    industry: input.company.industry ?? null,
    offerings: uniqueStrings([...asStrings(existingSeller.offerings), ...offeringNames], 20),
    technical_specs: uniqueStrings([...asStrings(existingSeller.technical_specs), ...techSpecs], 20),
    source_channel: sellerSourceChannel,
  };

  const existingBuyer = isPlainRecord(attrs.buyer_spec) ? attrs.buyer_spec : {};
  const resolvedRole = icpTradeRole(attrs);
  const overrideRoles = uniqueStrings(input.overrides?.buyerRoles ?? [], 5);
  const targetRoles = uniqueStrings([
    ...overrideRoles,
    ...asStrings(existingBuyer.target_roles),
    ...(resolvedRole ? [resolvedRole] : []),
    ...asStrings(attrs.trade_side),
  ], 6);

  const tradeSide =
    overrideRoles[0] ??
    (typeof existingBuyer.trade_side === 'string' && existingBuyer.trade_side.trim()
      ? existingBuyer.trade_side.trim()
      : resolvedRole ?? (typeof attrs.trade_side === 'string' ? attrs.trade_side : 'distributor'));

  const rawCategories = [
    ...asStrings(existingBuyer.product_categories),
    ...asStrings(attrs.product),
    ...asStrings(attrs.keywords),
    ...offeringNames.map(stripTechnicalSpecTokens),
  ];
  const productCategories = uniqueStrings(
    rawCategories.map((c) => stripTechnicalSpecTokens(c) || c),
    20,
  );

  const isoMarkets = uniqueStrings(
    targetCountryCodes({
      filters: {
        country: input.targetMarkets.filter((m): m is string => typeof m === 'string'),
      },
    }).map((code) => code.toUpperCase()),
    20,
  );

  const processRequired =
    typeof existingBuyer.process_required === 'boolean'
      ? existingBuyer.process_required
      : typeof attrs.process_required === 'boolean'
        ? attrs.process_required
        : !NON_MANUFACTURING_ROLES.has(tradeSide.toLowerCase());

  const scenario =
    input.overrides?.procurementScenario ??
    (typeof attrs.procurement_scenario === 'string'
      ? (attrs.procurement_scenario as BuyerProcurementScenario)
      : null);

  const buyerSpec: IcpBuyerSpecLayer = {
    target_roles: targetRoles.length > 0 ? targetRoles : [tradeSide],
    trade_side: tradeSide,
    product_categories: productCategories,
    industries: uniqueStrings([
      ...asStrings(existingBuyer.industries),
      ...asStrings(attrs.industry),
      ...asStrings(attrs.sub_industry),
    ], 12),
    target_markets: isoMarkets,
    process_required: processRequired,
    company_size:
      typeof existingBuyer.company_size === 'string'
        ? existingBuyer.company_size
        : typeof attrs.company_size === 'string'
          ? attrs.company_size
          : typeof attrs.size === 'string'
            ? attrs.size
            : null,
    procurement_scenario: scenario,
  };

  const existingPeer = isPlainRecord(attrs.peer_exclusions) ? attrs.peer_exclusions : {};
  const sellerHost = hostFromWebsite(input.company.website);
  const peerExclusions: IcpPeerExclusionsLayer = {
    excluded_business_models: uniqueStrings([
      ...asStrings(existingPeer.excluded_business_models),
      ...asStrings(input.exclusions),
      ...(input.overrides?.peerExclusionNotes ?? []),
    ], 25),
    excluded_keywords: uniqueStrings(asStrings(existingPeer.excluded_keywords), 25),
    excluded_domains: uniqueStrings([
      ...asStrings(existingPeer.excluded_domains),
      ...(sellerHost && !sellerHost.endsWith('1688.com') && !sellerHost.endsWith('alibaba.com')
        ? [sellerHost]
        : []),
    ], 20),
    rationale:
      typeof existingPeer.rationale === 'string' && existingPeer.rationale.trim()
        ? existingPeer.rationale.trim()
        : '排除同行业竞争对手、上游成品制造厂与无关行业企业',
  };

  return {
    ...attrs,
    process_required: buyerSpec.process_required,
    ...(scenario ? { procurement_scenario: scenario } : {}),
    seller_profile: sellerProfile,
    buyer_spec: buyerSpec,
    peer_exclusions: peerExclusions,
  };
}

/** Keeps peer_exclusions and top-level exclusions synchronized on manual ICP PATCH edits. */
export function syncThreeLayerOnIcpPatch(
  existingAttributes: unknown,
  patchAttributes: Record<string, unknown> | undefined,
  patchExclusions: string[] | undefined,
): { companyAttributes?: Record<string, unknown>; exclusions?: string[] } {
  if (patchAttributes === undefined && patchExclusions === undefined) {
    return {};
  }
  const base = isPlainRecord(existingAttributes) ? existingAttributes : {};
  const merged = patchAttributes ? { ...base, ...patchAttributes } : { ...base };
  const existingPeer = isPlainRecord(merged.peer_exclusions) ? merged.peer_exclusions : null;

  if (patchExclusions !== undefined) {
    if (existingPeer) {
      merged.peer_exclusions = {
        ...existingPeer,
        excluded_business_models: uniqueStrings([
          ...asStrings(existingPeer.excluded_business_models),
          ...patchExclusions,
        ], 25),
      };
    }
    return {
      ...(patchAttributes !== undefined || existingPeer ? { companyAttributes: merged } : {}),
      exclusions: patchExclusions,
    };
  }

  const peerModels = existingPeer ? asStrings(existingPeer.excluded_business_models) : [];
  return {
    companyAttributes: merged,
    ...(peerModels.length > 0 && patchAttributes?.peer_exclusions !== undefined
      ? { exclusions: peerModels }
      : {}),
  };
}
