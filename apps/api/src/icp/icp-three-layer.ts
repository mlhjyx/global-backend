import { icpTradeRole } from '../discovery/icp-trade-role';
import type { BuyerProcurementScenario } from '../discovery/buyer-procurement-scenarios';
import { targetCountryCodes } from '../discovery/search-localization';

export type SellerSourceChannel =
  | 'official_website'
  | 'alibaba_1688'
  | 'alibaba_intl'
  | 'pdf_brochure'
  | 'description';

export interface IcpSellerProfileLayer {
  readonly company_name: string;
  readonly website: string | null;
  readonly industry: string | null;
  readonly offerings: readonly string[];
  readonly technical_specs: readonly string[];
  readonly source_channel: SellerSourceChannel | null;
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

export type IcpFeedbackOutcome =
  | 'rejected'
  | 'replied_positive'
  | 'booked_meeting'
  | 'opt_out'
  | 'wrong_contact'
  | 'bounced';

export type IcpFeedbackRejectionReason =
  | 'wrong_role_peer'
  | 'wrong_industry'
  | 'too_small'
  | 'wrong_country'
  | 'dead_company'
  | 'bounced_unreachable';

export interface IcpFitCounterExample {
  readonly domain: string | null;
  readonly companyName: string | null;
  readonly industry: string | null;
  readonly outcome: IcpFeedbackOutcome;
  readonly reason: IcpFeedbackRejectionReason | 'unspecified';
  readonly note: string | null;
  readonly recordedAt: string;
}

export interface IcpFitPositiveExample {
  readonly domain: string | null;
  readonly companyName: string | null;
  readonly industry: string | null;
  readonly outcome: 'replied_positive' | 'booked_meeting';
  readonly recordedAt: string;
}

export interface IcpFeedbackLearningStats {
  readonly totalRecorded: number;
  readonly outcomeCounts: Record<string, number>;
  readonly rejectionReasonCounts: Record<string, number>;
  readonly lastRecordedAt: string | null;
}

export interface IcpFeedbackLearningSummary {
  readonly icpId: string;
  readonly icpName: string;
  readonly icpVersion: number;
  readonly excludedDomains: string[];
  readonly excludedKeywords: string[];
  readonly excludedBusinessModels: string[];
  readonly counterExamples: IcpFitCounterExample[];
  readonly positiveExamples: IcpFitPositiveExample[];
  readonly stats: IcpFeedbackLearningStats;
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

function isExactHostOrSubdomain(host: string, root: string): boolean {
  return host === root || host.endsWith(`.${root}`);
}

function detectSellerWebsiteChannel(website: string | null | undefined): SellerSourceChannel | null {
  const host = hostFromWebsite(website);
  if (!host) return null;
  if (isExactHostOrSubdomain(host, '1688.com')) return 'alibaba_1688';
  if (isExactHostOrSubdomain(host, 'alibaba.com')) return 'alibaba_intl';
  return 'official_website';
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

  const websiteChannel = detectSellerWebsiteChannel(input.company.website);
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
      ...(sellerHost &&
      !isExactHostOrSubdomain(sellerHost, '1688.com') &&
      !isExactHostOrSubdomain(sellerHost, 'alibaba.com')
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

const MAX_FIT_COUNTER_EXAMPLES = 5;
const MAX_FIT_POSITIVE_EXAMPLES = 5;
const MAX_LEARNED_EXCLUDED_DOMAINS = 50;
const MAX_LEARNED_EXCLUDED_KEYWORDS = 30;
const FEEDBACK_EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const FEEDBACK_PHONE_RE = /(?:\+?\d[\d\s().-]{7,18}\d)/gu;
const FEEDBACK_PERSONAL_LINKEDIN_RE = /https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/[^\s,;)"]+/giu;
const STRICT_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

export function normalizeFeedbackDomain(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('@')) return null;
  let candidate = trimmed;
  if (trimmed.includes('://')) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      candidate = parsed.hostname;
    } catch {
      return null;
    }
  } else {
    candidate = trimmed.split('/')[0] ?? '';
  }
  const clean = candidate.replace(/^www\./iu, '').replace(/\.+$/u, '').toLowerCase();
  return STRICT_DOMAIN_RE.test(clean) ? clean : null;
}

export function scrubFeedbackPiiText(raw: string | null | undefined, maxLen = 200): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const scrubbed = raw
    .replace(FEEDBACK_PERSONAL_LINKEDIN_RE, '')
    .replace(FEEDBACK_EMAIL_RE, '[redacted]')
    .replace(FEEDBACK_PHONE_RE, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLen);
  return scrubbed || null;
}

function readCounterExamples(raw: unknown): IcpFitCounterExample[] {
  if (!Array.isArray(raw)) return [];
  const out: IcpFitCounterExample[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) continue;
    const outcome = typeof item.outcome === 'string' ? (item.outcome as IcpFeedbackOutcome) : 'rejected';
    const reason =
      typeof item.reason === 'string'
        ? (item.reason as IcpFeedbackRejectionReason | 'unspecified')
        : 'unspecified';
    const recordedAt = typeof item.recordedAt === 'string' ? item.recordedAt : '';
    if (!recordedAt) continue;
    out.push({
      domain: typeof item.domain === 'string' ? item.domain : null,
      companyName: typeof item.companyName === 'string' ? item.companyName : null,
      industry: typeof item.industry === 'string' ? item.industry : null,
      outcome,
      reason,
      note: typeof item.note === 'string' ? item.note : null,
      recordedAt,
    });
    if (out.length >= MAX_FIT_COUNTER_EXAMPLES) break;
  }
  return out;
}

function readPositiveExamples(raw: unknown): IcpFitPositiveExample[] {
  if (!Array.isArray(raw)) return [];
  const out: IcpFitPositiveExample[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) continue;
    const outcome =
      item.outcome === 'replied_positive' || item.outcome === 'booked_meeting'
        ? item.outcome
        : null;
    const recordedAt = typeof item.recordedAt === 'string' ? item.recordedAt : '';
    if (!outcome || !recordedAt) continue;
    out.push({
      domain: typeof item.domain === 'string' ? item.domain : null,
      companyName: typeof item.companyName === 'string' ? item.companyName : null,
      industry: typeof item.industry === 'string' ? item.industry : null,
      outcome,
      recordedAt,
    });
    if (out.length >= MAX_FIT_POSITIVE_EXAMPLES) break;
  }
  return out;
}

function readIntMap(raw: unknown): Record<string, number> {
  if (!isPlainRecord(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      out[k] = Math.trunc(v);
    }
  }
  return out;
}

function readFeedbackStats(raw: unknown): IcpFeedbackLearningStats {
  const rec = isPlainRecord(raw) ? raw : {};
  return {
    totalRecorded:
      typeof rec.totalRecorded === 'number' && Number.isFinite(rec.totalRecorded)
        ? Math.max(0, Math.trunc(rec.totalRecorded))
        : 0,
    outcomeCounts: readIntMap(rec.outcomeCounts),
    rejectionReasonCounts: readIntMap(rec.rejectionReasonCounts),
    lastRecordedAt: typeof rec.lastRecordedAt === 'string' ? rec.lastRecordedAt : null,
  };
}

function shouldHardExcludeDomain(
  outcome: IcpFeedbackOutcome,
  rejectionReason: IcpFeedbackRejectionReason | null,
): boolean {
  if (outcome === 'opt_out') return true;
  if (outcome !== 'rejected') return false;
  return (
    rejectionReason === 'wrong_role_peer' ||
    rejectionReason === 'wrong_industry' ||
    rejectionReason === 'dead_company'
  );
}

function collectLearnedKeywords(
  outcome: IcpFeedbackOutcome,
  rejectionReason: IcpFeedbackRejectionReason | null,
  industry: string | null,
  excludedKeywords: readonly string[] | undefined,
  existingKeywords: readonly string[],
): string[] {
  if (outcome !== 'rejected') return [];
  const candidates: string[] = [];
  for (const kw of excludedKeywords ?? []) {
    const safeKw = scrubFeedbackPiiText(kw, 80);
    if (safeKw && !safeKw.includes('[redacted]')) candidates.push(safeKw);
  }
  if (rejectionReason === 'wrong_industry' && industry) {
    const safeInd = scrubFeedbackPiiText(industry, 80);
    if (safeInd && !safeInd.includes('[redacted]')) candidates.push(safeInd);
  }
  const existingLower = new Set(existingKeywords.map((k) => k.toLowerCase()));
  return uniqueStrings(candidates, 10).filter((kw) => !existingLower.has(kw.toLowerCase()));
}

function mergeCounterExamples(
  existing: IcpFitCounterExample[],
  input: {
    outcome: IcpFeedbackOutcome;
    rejectionReason: IcpFeedbackRejectionReason | null;
    domain: string | null;
    companyName: string | null;
    industry: string | null;
    note: string | null;
    recordedAt: string;
  },
): { examples: IcpFitCounterExample[]; added: boolean } {
  if (input.outcome !== 'rejected' && input.outcome !== 'opt_out') {
    return { examples: existing, added: false };
  }
  const next: IcpFitCounterExample = {
    domain: input.domain,
    companyName: scrubFeedbackPiiText(input.companyName, 140),
    industry: scrubFeedbackPiiText(input.industry, 100),
    outcome: input.outcome,
    reason: input.rejectionReason ?? 'unspecified',
    note: scrubFeedbackPiiText(input.note, 200),
    recordedAt: input.recordedAt,
  };
  const keyOf = (e: IcpFitCounterExample) =>
    `${(e.domain ?? '').toLowerCase()}|${(e.companyName ?? '').toLowerCase()}|${e.reason}`;
  const nextKey = keyOf(next);
  return {
    examples: [next, ...existing.filter((e) => keyOf(e) !== nextKey)].slice(0, MAX_FIT_COUNTER_EXAMPLES),
    added: true,
  };
}

function mergePositiveExamples(
  existing: IcpFitPositiveExample[],
  input: {
    outcome: IcpFeedbackOutcome;
    domain: string | null;
    companyName: string | null;
    industry: string | null;
    recordedAt: string;
  },
): IcpFitPositiveExample[] {
  if (input.outcome !== 'replied_positive' && input.outcome !== 'booked_meeting') {
    return existing;
  }
  const next: IcpFitPositiveExample = {
    domain: input.domain,
    companyName: scrubFeedbackPiiText(input.companyName, 140),
    industry: scrubFeedbackPiiText(input.industry, 100),
    outcome: input.outcome,
    recordedAt: input.recordedAt,
  };
  return [
    next,
    ...existing.filter((e) => (e.domain ?? e.companyName) !== (next.domain ?? next.companyName)),
  ].slice(0, MAX_FIT_POSITIVE_EXAMPLES);
}

export function applyFeedbackEvolutionToAttributes(input: {
  readonly existingAttributes: unknown;
  readonly exclusions: unknown;
  readonly outcome: IcpFeedbackOutcome;
  readonly rejectionReason: IcpFeedbackRejectionReason | null;
  readonly domain: string | null;
  readonly companyName: string | null;
  readonly industry: string | null;
  readonly excludedKeywords?: readonly string[];
  readonly note: string | null;
  readonly recordedAt: string;
}): {
  readonly nextAttributes: Record<string, unknown>;
  readonly appliedRules: {
    readonly addedExcludedDomain: string | null;
    readonly addedExcludedKeywords: string[];
    readonly addedCounterExample: boolean;
  };
} {
  const attrs = isPlainRecord(input.existingAttributes) ? { ...input.existingAttributes } : {};
  const existingPeer = isPlainRecord(attrs.peer_exclusions) ? attrs.peer_exclusions : {};
  const existingDomains = uniqueStrings(asStrings(existingPeer.excluded_domains), MAX_LEARNED_EXCLUDED_DOMAINS);
  const existingKeywords = uniqueStrings(asStrings(existingPeer.excluded_keywords), MAX_LEARNED_EXCLUDED_KEYWORDS);
  const existingModels = uniqueStrings(
    [...asStrings(existingPeer.excluded_business_models), ...asStrings(input.exclusions)],
    25,
  );

  const normalizedDomain = normalizeFeedbackDomain(input.domain);
  const shouldAddDomain =
    Boolean(normalizedDomain) &&
    shouldHardExcludeDomain(input.outcome, input.rejectionReason) &&
    !existingDomains.some((d) => d.toLowerCase() === normalizedDomain);
  const addedExcludedDomain = shouldAddDomain ? normalizedDomain : null;
  const nextDomains = addedExcludedDomain ? [...existingDomains, addedExcludedDomain] : existingDomains;

  const addedExcludedKeywords = collectLearnedKeywords(
    input.outcome,
    input.rejectionReason,
    input.industry,
    input.excludedKeywords,
    existingKeywords,
  );
  const nextKeywords = uniqueStrings([...existingKeywords, ...addedExcludedKeywords], MAX_LEARNED_EXCLUDED_KEYWORDS);

  const counterMerged = mergeCounterExamples(readCounterExamples(attrs.fit_counter_examples), {
    outcome: input.outcome,
    rejectionReason: input.rejectionReason,
    domain: normalizedDomain,
    companyName: input.companyName,
    industry: input.industry,
    note: input.note,
    recordedAt: input.recordedAt,
  });
  const positiveExamples = mergePositiveExamples(readPositiveExamples(attrs.fit_positive_examples), {
    outcome: input.outcome,
    domain: normalizedDomain,
    companyName: input.companyName,
    industry: input.industry,
    recordedAt: input.recordedAt,
  });

  const prevStats = readFeedbackStats(attrs.feedback_learning_stats);
  const nextRejectionCounts = input.rejectionReason
    ? {
        ...prevStats.rejectionReasonCounts,
        [input.rejectionReason]: (prevStats.rejectionReasonCounts[input.rejectionReason] ?? 0) + 1,
      }
    : prevStats.rejectionReasonCounts;

  const nextAttributes: Record<string, unknown> = {
    ...attrs,
    peer_exclusions: {
      excluded_business_models: existingModels,
      excluded_keywords: nextKeywords,
      excluded_domains: uniqueStrings(nextDomains, MAX_LEARNED_EXCLUDED_DOMAINS),
      rationale:
        typeof existingPeer.rationale === 'string' && existingPeer.rationale.trim()
          ? existingPeer.rationale.trim()
          : '排除同行业竞争对手、上游成品制造厂与无关行业企业',
    },
    fit_counter_examples: counterMerged.examples,
    fit_positive_examples: positiveExamples,
    feedback_learning_stats: {
      totalRecorded: prevStats.totalRecorded + 1,
      outcomeCounts: {
        ...prevStats.outcomeCounts,
        [input.outcome]: (prevStats.outcomeCounts[input.outcome] ?? 0) + 1,
      },
      rejectionReasonCounts: nextRejectionCounts,
      lastRecordedAt: input.recordedAt,
    },
  };

  return {
    nextAttributes,
    appliedRules: {
      addedExcludedDomain,
      addedExcludedKeywords,
      addedCounterExample: counterMerged.added,
    },
  };
}

export function buildFeedbackLearningSummary(icp: {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly exclusions: unknown;
  readonly companyAttributes: unknown;
}): IcpFeedbackLearningSummary {
  const attrs = isPlainRecord(icp.companyAttributes) ? icp.companyAttributes : {};
  const peer = isPlainRecord(attrs.peer_exclusions) ? attrs.peer_exclusions : {};
  return {
    icpId: icp.id,
    icpName: icp.name,
    icpVersion: icp.version,
    excludedDomains: uniqueStrings(asStrings(peer.excluded_domains), MAX_LEARNED_EXCLUDED_DOMAINS),
    excludedKeywords: uniqueStrings(asStrings(peer.excluded_keywords), MAX_LEARNED_EXCLUDED_KEYWORDS),
    excludedBusinessModels: uniqueStrings(
      [...asStrings(peer.excluded_business_models), ...asStrings(icp.exclusions)],
      25,
    ),
    counterExamples: readCounterExamples(attrs.fit_counter_examples),
    positiveExamples: readPositiveExamples(attrs.fit_positive_examples),
    stats: readFeedbackStats(attrs.feedback_learning_stats),
  };
}
