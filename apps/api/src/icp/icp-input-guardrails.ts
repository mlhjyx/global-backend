import { BadRequestException } from '@nestjs/common';
import { targetCountryCodes } from '../discovery/search-localization';
import { COUNTRY_NAME_BY_ISO } from '../discovery/vocab';

export type OfferingForSelection = {
  name: string;
  description: string | null;
  attributes: unknown;
};

export type OfferingSelectionBasis =
  | 'selected_products'
  | 'selection_canceled_all'
  | 'legacy_all_offerings';

export interface OfferingSelection {
  chosen: OfferingForSelection[];
  basis: OfferingSelectionBasis;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * P1-B2（方案 §2.2）：卖方档案的目标市场是权威输入。档案存 ISO 3166-1 alpha-2；模型输出是自由文本
 * （「德国」「珠三角电子制造企业」…），两者都要归一成 ISO 才能比对与补齐。
 */
export function sellerIsoMarkets(profile: unknown): string[] {
  const targetMarkets = isPlainRecord(profile) ? profile.targetMarkets : undefined;
  const raw = Array.isArray(targetMarkets) ? targetMarkets : [];
  return [
    ...new Set(
      raw
        .filter((market): market is string => typeof market === 'string')
        .map((market) => market.trim().toUpperCase())
        .filter((market) => /^[A-Z]{2}$/.test(market)),
    ),
  ];
}

export function marketDisplayName(iso: string): string {
  return COUNTRY_NAME_BY_ISO[iso] ?? iso;
}

/**
 * 模型输出的 target_markets 必须覆盖档案市场（可追加、不得替换）：缺哪个补哪个，已覆盖的不重复追加。
 * 覆盖判定同时看两路：`targetCountryCodes` 能解析的中文/英文/地区词，以及直接写出的中文国名。
 */
export function completeTargetMarkets(
  modelMarkets: unknown,
  sellerMarkets: readonly string[],
): unknown[] {
  const model = Array.isArray(modelMarkets) ? modelMarkets : [];
  if (sellerMarkets.length === 0) return model;
  const modelText = model.filter((market): market is string => typeof market === 'string');
  const covered = new Set(
    targetCountryCodes({ filters: { country: modelText } }).map((iso) => iso.toUpperCase()),
  );
  for (const iso of sellerMarkets) {
    if (modelText.some((market) => market.includes(marketDisplayName(iso)))) covered.add(iso);
  }
  const missing = sellerMarkets.filter((iso) => !covered.has(iso));
  return [...model, ...missing.map(marketDisplayName)];
}

/**
 * Confirm-by-request markets: only an explicit API argument counts as user confirmation.
 * AI prefills / legacy profile.targetMarkets are *not* promoted to confirmed markets.
 */
export function confirmedMarketCodes(
  input: readonly string[] | null | undefined,
): string[] | null {
  // @IsOptional 放行 JSON null；按「未提供」处理，不能让它落进 input.map 变成 500。
  if (input === undefined || input === null) return null;
  const normalizedInput = [
    ...new Set(input.map((value) => value.trim().toUpperCase()).filter(Boolean)),
  ];
  if (normalizedInput.length === 0) {
    throw new BadRequestException({
      error: { code: 'VALIDATION_ERROR', message: 'confirmedTargetMarkets 不能为空数组' },
    });
  }
  const codes = targetCountryCodes({ filters: { country: normalizedInput } }).map((code) =>
    code.toUpperCase(),
  );
  if (codes.length !== normalizedInput.length) {
    throw new BadRequestException({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'confirmedTargetMarkets 必须是可归一的 ISO 3166-1 alpha-2',
      },
    });
  }
  return [...new Set(codes)];
}

/**
 * Product selection guardrail: only explicit user markers feed a new ICP.
 * - any true marker -> only those offerings;
 * - markers exist but all false -> explicit "cancel all" (caller rejects);
 * - no markers at all -> legacy fallback, labelled, never treated as confirmation.
 */
export function selectOfferingsForIcp(
  offerings: readonly OfferingForSelection[],
): OfferingSelection {
  const marked = offerings.filter(
    (offering) =>
      isPlainRecord(offering.attributes) &&
      typeof offering.attributes.selectedByUser === 'boolean',
  );
  const selected = marked.filter(
    (offering) => (offering.attributes as Record<string, unknown>).selectedByUser === true,
  );
  if (selected.length > 0) return { chosen: selected, basis: 'selected_products' };
  if (marked.length > 0) return { chosen: [], basis: 'selection_canceled_all' };
  return { chosen: offerings.slice(0, 30), basis: 'legacy_all_offerings' };
}

/**
 * Applies the guardrail selection to a company's offerings fetched inside the caller's
 * transaction. Throws NO_SELECTED_PRODUCTS before any one-shot Grant is consumed.
 */
export function resolveIcpOfferings(
  allOfferings: readonly OfferingForSelection[],
  guardrailsEnabled: boolean,
): OfferingSelection {
  const selection: OfferingSelection = guardrailsEnabled
    ? selectOfferingsForIcp(allOfferings)
    : { chosen: allOfferings.slice(0, 30), basis: 'legacy_all_offerings' };
  if (guardrailsEnabled && selection.basis === 'selection_canceled_all') {
    throw new BadRequestException({
      error: {
        code: 'NO_SELECTED_PRODUCTS',
        message: '用户已取消全部产品选择；请至少勾选一个产品后再生成 ICP',
      },
    });
  }
  return selection;
}

export type IcpGenerationPromptInput = {
  company: {
    name: string;
    website?: string | null;
    industry?: string | null;
    targetMarkets?: unknown;
  };
  facts: string;
  offerings: readonly OfferingForSelection[];
  offeringBasis: OfferingSelectionBasis;
  confirmedMarkets: readonly string[] | null;
  guardrailsEnabled: boolean;
};

/** P1-B2（方案 §2.2）：确认的市场/行业是权威输入；但 AI 预填与历史档案不等于确认。 */
/** guardrails 关闭（线上默认）时与旧实现逐字节一致：模型输入不得因本 PR 改变。 */
function buildLegacyIcpPrompt(
  company: IcpGenerationPromptInput['company'],
  facts: string,
  offerings: readonly OfferingForSelection[],
): string {
  const products = offerings.length
    ? `\n产品/服务（官网抽取）：\n${offerings.map((o) => `- ${o.name}${o.description ? `：${o.description}` : ''}`).join('\n')}`
    : '';
  const sellerMarkets = sellerIsoMarkets(company);
  const sellerProfile = [
    sellerMarkets.length
      ? `目标市场（ISO 3166-1）：${sellerMarkets.map((iso) => `${iso}（${marketDisplayName(iso)}）`).join('、')}`
      : '',
    company.industry ? `行业：${company.industry}` : '',
  ].filter(Boolean);
  const sellerAuthority = sellerProfile.length
    ? `\n卖方档案（权威输入）：\n${sellerProfile.join('\n')}\n目标市场以卖方档案为权威：输出的 target_markets 必须覆盖以上市场（可追加其他市场，但不得替换；追加请在 value_props 或说明中给出理由）。`
    : '';
  return `卖方企业：${company.name}${company.website ? ` (${company.website})` : ''}\n已确认的企业事实：\n${facts}${products}${sellerAuthority}\n\n请据此设计其理想客户画像(ICP)、买家委员会与机器可评估的验证规则，输出中文。`;
}

export function buildIcpGenerationPrompt(input: IcpGenerationPromptInput): string {
  const { company, facts, offerings, offeringBasis, confirmedMarkets, guardrailsEnabled } = input;
  if (!guardrailsEnabled) return buildLegacyIcpPrompt(company, facts, offerings);
  const productsLabel =
    offeringBasis === 'selected_products'
      ? '产品/服务（用户本次勾选）'
      : '产品/服务（来自档案/抽取，未经用户确认选择）';
  const products = offerings.length
    ? `\n${productsLabel}：\n${offerings.map((o) => `- ${o.name}${o.description ? `：${o.description}` : ''}`).join('\n')}`
    : '';
  const profileMarkets = sellerIsoMarkets(company);
  const authorityMarkets = confirmedMarkets ?? (guardrailsEnabled ? [] : profileMarkets);
  // 档案里有、但本次没有被用户确认的市场：显式标成建议，绝不静默丢掉、也不冒充确认。
  const unconfirmedMarkets = guardrailsEnabled
    ? profileMarkets.filter((iso) => !(confirmedMarkets ?? []).includes(iso))
    : [];
  const unconfirmedProfileMarkets = unconfirmedMarkets.length
    ? `档案记录的市场（未确认，仅供建议）：${unconfirmedMarkets
        .map((iso) => `${iso}（${marketDisplayName(iso)}）`)
        .join('、')}`
    : '';
  const sellerProfile = [
    authorityMarkets.length
      ? `目标市场（ISO 3166-1，${confirmedMarkets ? '用户确认' : '卖方档案'}）：${authorityMarkets
          .map((iso) => `${iso}（${marketDisplayName(iso)}）`)
          .join('、')}`
      : '',
    company.industry ? `行业：${company.industry}` : '',
    unconfirmedProfileMarkets,
  ].filter(Boolean);
  const sellerAuthority = authorityMarkets.length
    ? guardrailsEnabled
      ? `\n卖方档案（权威输入）：\n${sellerProfile.join('\n')}\n目标市场以用户确认为权威：硬目标只包含以上市场；其他市场只能作为建议，不得替换。`
      : `\n卖方档案（权威输入）：\n${sellerProfile.join('\n')}\n目标市场以卖方档案为权威：输出的 target_markets 必须覆盖以上市场（可追加其他市场，但不得替换；追加请在 value_props 或说明中给出理由）。`
    : sellerProfile.length
      ? `\n卖方档案（参考）：\n${sellerProfile.join('\n')}`
      : '';
  return `卖方企业：${company.name}${company.website ? ` (${company.website})` : ''}\n已确认的企业事实：\n${facts}${products}${sellerAuthority}\n\n请据此设计其理想客户画像(ICP)、买家委员会与机器可评估的验证规则，输出中文。`;
}

export type IcpInputLineageInput = {
  modelCompanyAttributes: unknown;
  offeringBasis: OfferingSelectionBasis;
  confirmedMarkets: readonly string[] | null;
  guardrailsEnabled: boolean;
  offerings: readonly OfferingForSelection[];
  modelMarkets: readonly string[];
};

/** 输入血缘：不管模型给了什么 company_attributes，都强制写回本次输入基准。 */
export function icpInputLineage(input: IcpInputLineageInput): Record<string, unknown> {
  const { modelCompanyAttributes, offeringBasis, confirmedMarkets, guardrailsEnabled, offerings, modelMarkets } = input;
  return {
    ...(isPlainRecord(modelCompanyAttributes) ? modelCompanyAttributes : {}),
    inputBasis: offeringBasis,
    marketBasis: confirmedMarkets
      ? 'user_confirmed'
      : guardrailsEnabled
        ? 'model_unconfirmed'
        : 'legacy_profile_floor',
    inputProducts: offerings.map((offering) => offering.name),
    // 三种 marketBasis 都记录模型建议，审计时才能对照「确认 vs 建议」。
    modelSuggestedMarkets: modelMarkets,
  };
}
