/**
 * 21 列受审计多通道作战清表（Battle CSV）行构造器（Batch 1.4-C + Batch 1.8A 升级）。
 *
 * 将已过 DataRights EXPORT / 制裁 / 合成隔离 / 抑制过滤后的线索、决策人、公司联络点、
 * 真实公司信号（Trigger）、评审准则证据、Art.14/LIA 合规记录组装为 `BattleCsvRow`，
 * 并经 `renderBattleCsv()` 输出带 UTF-8 BOM 与 CWE-1236 公式中和的正式 CSV。
 */
import type { Prisma } from '@prisma/client';
import { classifyContactEmail } from '../discovery/contact-classifier';
import { resolveCompanyJurisdiction } from '../discovery/jurisdiction-resolver';
import {
  buildForwardableBlurb,
  buildLinkedInCoPilotPlaybook,
  buildReferralFirstInfoDraft,
  classifyBuyingCommitteeTrack,
  classifyContactChannelTier,
  countryOutreachWindow,
  effectiveEmailVerificationState,
  isUsableOutreachEmailPoint,
  localizedDepartmentLabel,
  prioritizeBuyingCommitteeContacts,
  validateLinkedInConnectionNote,
} from '../enrichment/buying-committee';
import { evaluateMultiChannelOutreachPolicy } from '../outreach/multi-channel-playbook';
import { isPlaceholderContact } from '../discovery/providers/contact-quality-filter';
import { extractCompanySocialProfiles } from '../discovery/company-channels';
import {
  projectStoredAndFallbackSignals,
  type LeadPackageCompanySignal,
} from '../signals/enrichment-signal-projection';
import { buildSignalIcebreakers, type SignalIcebreakerSuggestion } from '../signals/signal-icebreaker';
import { renderBattleCsv, type BattleCsvRow } from './battle-csv';
export type { BattleCsvRow } from './battle-csv';

export interface BattleContactPoint {
  readonly type: string;
  readonly value: string;
  readonly status: string;
  readonly verificationState?: string | null;
  readonly sourceType?: string | null;
  readonly verificationMethod?: string | null;
}

export interface BattleDecisionMaker {
  readonly id?: string;
  readonly fullName: string;
  readonly title: string | null;
  readonly department: string | null;
  readonly points: readonly BattleContactPoint[];
}

export interface BattleCompanyFact {
  readonly id: string;
  readonly name: string;
  readonly domain: string | null;
  readonly country: string | null;
  readonly attributes: Prisma.JsonValue;
}

export interface BattleLeadFact {
  readonly id: string;
  readonly canonicalCompanyId: string;
  readonly totalScore: number | null;
  readonly fitVerdict: string | null;
  readonly scoreDetail: Prisma.JsonValue;
}

export interface BattleCompanyChannel {
  readonly channel: string;
  readonly value: string;
  readonly status?: string;
}

export interface BattleJudgmentRecord {
  readonly verdict?: string | null;
  readonly criteria?: Prisma.JsonValue;
}

export interface BattleRowBuildInput {
  readonly lead: BattleLeadFact;
  readonly company: BattleCompanyFact;
  readonly companyContactPoints: readonly { kind: string; value: string; status?: string }[];
  readonly companyContactChannels?: readonly BattleCompanyChannel[];
  readonly decisionMakers: readonly BattleDecisionMaker[];
  readonly draft: { subject: string; body: string } | null;
  readonly judgmentRecord?: BattleJudgmentRecord | null;
  readonly companySignals?: readonly LeadPackageCompanySignal[];
  readonly article14StatusByContactId?: ReadonlyMap<string, string>;
  readonly hasActiveWorkspaceLia?: boolean;
  readonly sellerName?: string | null;
  readonly sellerProductSummary?: string | null;
  readonly sellerInboundFooter?: string | null;
}

const PERSONAL_LINKEDIN_RE = /linkedin\.com\/(?:in|pub)\//iu;
const COMPANY_LINKEDIN_RE = /linkedin\.com\/(?:company|showcase)\//iu;
const NOISE_SCORE_NOTE_RE = /无(?:真实)?意图信号|暂无意图信号|未检测到(?:真实)?意图信号|no intent signal/iu;
const CJK_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const STRIP_LINKEDIN_URL_RE = /\b(?:https?:\/\/|www\.)\S+/giu;
const STRIP_LINKEDIN_PLACEHOLDER_RE = /\[[^\]]{1,40}\]|\{[^}]{1,40}\}|<[^>]{1,40}>/gu;
const MAX_EVIDENCE_CHARS = 260;

const DEFAULT_PRODUCT_BY_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  it: 'componenti e prodotti industriali OEM/ODM',
  de: 'Industrieprodukte (OEM/ODM)',
  es: 'productos industriales OEM/ODM',
  fr: 'produits industriels OEM/ODM',
  pt: 'produtos industriais OEM/ODM',
  en: 'industrial OEM/ODM products',
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function extractCarriedBrands(attrs: Record<string, unknown>): string[] {
  const profile = asRecord(attrs.website_profile);
  if (!Array.isArray(profile.carried_brands)) return [];
  const names: string[] = [];
  for (const item of profile.carried_brands) {
    if (typeof item === 'string' && item.trim()) {
      names.push(item.trim());
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const name = (item as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim()) names.push(name.trim());
    }
  }
  return [...new Set(names)];
}

function extractJudgmentRationales(judgmentRecord: BattleJudgmentRecord | null | undefined): string[] {
  if (!judgmentRecord || !Array.isArray(judgmentRecord.criteria)) return [];
  const items: Array<{ label: string; rationale: string; score: number; index: number }> = [];
  judgmentRecord.criteria.forEach((raw, index) => {
    const rec = asRecord(raw);
    if (rec.applicable === false) return;
    const rationale = typeof rec.rationale === 'string' ? rec.rationale.replace(/\s+/gu, ' ').trim() : '';
    if (!rationale) return;
    const label = typeof rec.label === 'string' ? rec.label.replace(/\s+/gu, ' ').trim() : '';
    const score = typeof rec.score === 'number' && Number.isFinite(rec.score) ? rec.score : 0;
    items.push({ label, rationale, score, index });
  });
  items.sort((a, b) => b.score - a.score || a.index - b.index);
  return items.slice(0, 3).map((item) => {
    const clipped = item.rationale.slice(0, 80);
    return item.label ? `${item.label}: ${clipped}` : clipped;
  });
}

function clipText(value: string, maxChars: number): string {
  const chars = Array.from(value);
  return chars.length <= maxChars ? value : `${chars.slice(0, maxChars - 1).join('').trimEnd()}…`;
}

function summarizeEvidence(
  lead: BattleLeadFact,
  company: BattleCompanyFact,
  judgmentRecord?: BattleJudgmentRecord | null,
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const clean = raw.replace(/\s+/gu, ' ').trim();
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(clean);
  };

  if (lead.fitVerdict) push(`fit=${lead.fitVerdict}`);
  for (const rationale of extractJudgmentRationales(judgmentRecord)) push(rationale);

  const detail = asRecord(lead.scoreDetail);
  if (typeof detail.summary === 'string' && detail.summary.trim()) {
    push(detail.summary.trim().slice(0, 140));
  } else if (typeof detail.reason === 'string' && detail.reason.trim()) {
    push(detail.reason.trim().slice(0, 140));
  }
  if (Array.isArray(detail.notes)) {
    let addedNotes = 0;
    for (const note of detail.notes) {
      if (addedNotes >= 2) break;
      if (typeof note !== 'string') continue;
      const trimmed = note.trim();
      if (!trimmed || NOISE_SCORE_NOTE_RE.test(trimmed)) continue;
      push(trimmed.slice(0, 100));
      addedNotes += 1;
    }
  }

  const attrs = asRecord(company.attributes);
  const profile = asRecord(attrs.website_profile);
  if (typeof profile.trade_role === 'string' && profile.trade_role.trim()) {
    push(`role=${profile.trade_role.trim()}`);
  }
  const brands = extractCarriedBrands(attrs);
  if (brands.length > 0) {
    push(`brands=${brands.slice(0, 4).join(', ')}`);
  }
  if (parts.length === 0 && typeof attrs.industry === 'string' && attrs.industry.trim()) {
    push(attrs.industry.trim().slice(0, 120));
  }
  const combined = parts.join(' | ');
  return combined ? clipText(combined, MAX_EVIDENCE_CHARS) : '已通过匹配与合规校验';
}

function languageForCountry(country: string | null): string {
  const cc = (country ?? '').trim().toUpperCase();
  if (cc === 'DE' || cc === 'AT' || cc === 'CH') return 'de';
  if (cc === 'IT') return 'it';
  if (cc === 'ES' || cc === 'MX' || cc === 'CO' || cc === 'CL' || cc === 'AR') return 'es';
  if (cc === 'BR' || cc === 'PT') return 'pt';
  if (cc === 'FR' || cc === 'BE') return 'fr';
  return 'en';
}

function pickBestEmailPoint(points: readonly BattleContactPoint[]): BattleContactPoint | null {
  // 禁止把未证实的 pattern_guess 盲猜邮箱选为作战清表首选触达邮箱，防止外贸团队对假地址退信。
  const emails = points.filter(isUsableOutreachEmailPoint);
  if (emails.length === 0) return null;
  const rank = (point: BattleContactPoint): number => {
    const state = effectiveEmailVerificationState(point);
    if (state === 'VALID') return 4;
    if (state === 'CATCH_ALL_RISKY') return 3;
    if (state === 'UNKNOWN') return 2;
    return 1;
  };
  return [...emails].sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

function collectSwitchboardChannels(switchboardContacts: readonly BattleDecisionMaker[]): {
  emails: string[];
  phones: string[];
} {
  return {
    emails: switchboardContacts.flatMap((c) =>
      c.points.filter(isUsableOutreachEmailPoint).map((p) => p.value),
    ),
    phones: switchboardContacts.flatMap((c) =>
      c.points.filter((p) => p.type === 'phone' && p.status !== 'INVALID').map((p) => p.value),
    ),
  };
}

function resolveBattleChannels(
  companyContactPoints: readonly { kind: string; value: string; status?: string }[],
  companyContactChannels: readonly BattleCompanyChannel[],
  companyAttributes: Prisma.JsonValue,
  switchboardContacts: readonly BattleDecisionMaker[],
  leadContact: BattleDecisionMaker | null,
) {
  const contactEmailPoint = leadContact ? pickBestEmailPoint(leadContact.points) : null;
  const contactLinkedinPoints = leadContact?.points.filter((p) => p.type === 'linkedin') ?? [];
  // #96-6：严格区分个人领英（/in/ 或 /pub/）与公司领英（/company/ 或 /showcase/）。
  const contactLinkedin =
    contactLinkedinPoints.find((p) => PERSONAL_LINKEDIN_RE.test(p.value))?.value ?? null;
  const contactCompanyLinkedin =
    contactLinkedinPoints.find((p) => COMPANY_LINKEDIN_RE.test(p.value))?.value ?? null;

  const socials = extractCompanySocialProfiles(
    companyContactPoints.map((p) => ({ kind: p.kind, value: p.value, status: p.status ?? 'UNVERIFIED' })),
    companyAttributes,
  );
  const socialLinkedin = socials.find((s) => s.platform === 'linkedin')?.url ?? null;
  const companyLinkedin =
    (socialLinkedin && COMPANY_LINKEDIN_RE.test(socialLinkedin) ? socialLinkedin : null) ??
    contactCompanyLinkedin;
  const socialWhatsapp = socials.find((s) => s.platform === 'whatsapp')?.url ?? null;
  const extraSocials = socials
    .filter((s) => s.platform !== 'linkedin' && s.platform !== 'whatsapp')
    .slice(0, 3)
    .map((s) => `${s.platform.toUpperCase()}:${s.url}`);
  const switchboard = collectSwitchboardChannels(switchboardContacts);
  const companyEmails = [
    ...companyContactChannels.filter((c) => c.channel === 'email' && c.status !== 'INVALID').map((c) => c.value),
    ...companyContactPoints.filter((p) => p.kind === 'email').map((p) => p.value),
    ...switchboard.emails,
  ];
  const companyPhone =
    companyContactChannels.find((c) => c.channel === 'phone' && c.status !== 'INVALID')?.value ??
    switchboard.phones[0] ??
    null;
  const functionalCompanyEmail =
    companyEmails.find((e) => classifyContactEmail(e).emailType !== 'role') ?? null;
  const chosenEmail = contactEmailPoint?.value ?? functionalCompanyEmail ?? companyEmails[0] ?? null;
  const chosenVerificationState = effectiveEmailVerificationState(contactEmailPoint);
  const emailClass = chosenEmail ? classifyContactEmail(chosenEmail).emailType : null;
  // #96-2：只有真正的 supplier_page 才作为供应商门户升级 B 级；普通 contact_form/form_url/contact_page 仅作备选展示。
  const supplierPortalUrl =
    companyContactPoints.find((p) => p.kind === 'supplier_page')?.value ?? null;
  const contactFormOrPageUrl =
    companyContactPoints.find((p) => p.kind === 'contact_form')?.value ??
    companyContactChannels.find((c) => c.channel === 'form_url' && c.status !== 'INVALID')?.value ??
    companyContactPoints.find((p) => p.kind === 'contact_page')?.value ??
    null;
  return {
    contactLinkedin,
    companyLinkedin,
    supplierPortalUrl,
    contactFormOrPageUrl,
    companyPhone,
    publicWhatsapp: companyContactPoints.find((p) => p.kind === 'whatsapp')?.value ?? socialWhatsapp,
    extraSocials,
    chosenEmail,
    chosenVerificationState,
    emailClass,
    isPersonalEmail: emailClass === 'personal' || emailClass === 'other',
  };
}

/** 避免把中文 ICP 名/中文主体名直接拼进意/德/英等外语开发信或 LinkedIn 附言。 */
export function sanitizeOutreachTextForLanguage(
  raw: string | null | undefined,
  language: string,
  fallback: string,
): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return fallback;
  if (language === 'zh') return trimmed;
  return CJK_SCRIPT_RE.test(trimmed) ? fallback : trimmed;
}

function englishHookForSignal(signal: SignalIcebreakerSuggestion): string {
  const cleaned = signal.signalTitle
    .replace(STRIP_LINKEDIN_URL_RE, '')
    .replace(STRIP_LINKEDIN_PLACEHOLDER_RE, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (cleaned && !CJK_SCRIPT_RE.test(cleaned)) {
    return clipText(cleaned, 90);
  }
  switch (signal.signalType) {
    case 'TENDER_AWARDED':
      return 'your recent public tender award';
    case 'TENDER_PUBLISHED':
    case 'SOURCING_OPENED':
      return 'your recent public sourcing update';
    case 'HIRING_BUYING_ROLE':
      return 'your open procurement and supply chain roles';
    case 'HIRING_UP':
      return 'your recent team expansion';
    case 'AD_CAMPAIGN_ACTIVE':
      return 'your active online product campaigns';
    case 'NEWS_MENTION':
      return 'your recent company news';
    default:
      return 'your recent website and product updates';
  }
}

function resolveTriggerHook(
  company: BattleCompanyFact,
  companySignals: readonly LeadPackageCompanySignal[] | undefined,
  draft: { subject: string; body: string } | null,
): { triggerHook: string | null; commonGroundHook: string | null } {
  const attrs = asRecord(company.attributes);
  const projected = projectStoredAndFallbackSignals(attrs, companySignals, company.name);
  const icebreakers = buildSignalIcebreakers({
    companyName: company.name,
    signals: projected,
    maxSuggestions: 1,
  });
  const top = icebreakers[0];
  if (top) {
    const datePart = top.detectedAt.slice(0, 10);
    return {
      triggerHook: `[${top.signalType}] ${top.signalTitle} (${datePart}) | ${top.openerEn}`,
      commonGroundHook: englishHookForSignal(top),
    };
  }
  const brands = extractCarriedBrands(attrs);
  if (brands.length > 0) {
    return {
      triggerHook: `官网在售品牌: ${brands.slice(0, 5).join(', ')}`,
      commonGroundHook: null,
    };
  }
  return {
    triggerHook: draft?.subject ?? null,
    commonGroundHook: null,
  };
}

function cleanLinkedInFragment(raw: string): string {
  return raw
    .replace(STRIP_LINKEDIN_URL_RE, '')
    .replace(STRIP_LINKEDIN_PLACEHOLDER_RE, '')
    .replace(/\b(?:pdf|brochure|catalog(?:ue)?|price\s*list|quotation|quote\s+attached)\b/giu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function buildValidatedLinkedInNote(args: {
  firstName: string;
  companyName: string;
  sellerValueProp: string;
  commonGroundHook: string | null;
}): string | null {
  const playbook = buildLinkedInCoPilotPlaybook({
    firstName: args.firstName,
    companyName: args.companyName,
    sellerValueProp: args.sellerValueProp,
    commonGroundHook: args.commonGroundHook,
  });
  const primary = args.commonGroundHook
    ? playbook.templates.common_ground
    : playbook.templates.differentiated_cold;
  if (validateLinkedInConnectionNote(primary).ok) return primary;

  const safeProp = cleanLinkedInFragment(args.sellerValueProp) || DEFAULT_PRODUCT_BY_LANGUAGE.en;
  const fallback = cleanLinkedInFragment(
    buildLinkedInCoPilotPlaybook({
      firstName: cleanLinkedInFragment(args.firstName) || 'there',
      companyName: cleanLinkedInFragment(args.companyName) || 'your company',
      sellerValueProp: safeProp,
    }).templates.differentiated_cold,
  );
  return validateLinkedInConnectionNote(fallback).ok ? fallback : null;
}

function buildBattleOutreachCopy(args: {
  input: BattleRowBuildInput;
  effectiveCountry: string | null;
  leadContact: BattleDecisionMaker | null;
  track: ReturnType<typeof classifyBuyingCommitteeTrack>;
  channelTier: ReturnType<typeof classifyContactChannelTier>;
  emailClass: ReturnType<typeof classifyContactEmail>['emailType'] | null;
  isPersonalEmail: boolean;
  contactLinkedin: string | null;
  commonGroundHook: string | null;
}): { linkedinNote: string | null; referralInfoDraft: string | null; forwardableBlurb: string } {
  const {
    input,
    effectiveCountry,
    leadContact,
    track,
    channelTier,
    emailClass,
    isPersonalEmail,
    contactLinkedin,
    commonGroundHook,
  } = args;
  const language = languageForCountry(effectiveCountry);
  const productFallback = DEFAULT_PRODUCT_BY_LANGUAGE[language] ?? DEFAULT_PRODUCT_BY_LANGUAGE.en;
  const sellerName = sanitizeOutreachTextForLanguage(input.sellerName, language, 'Our Manufacturing Team');
  const sellerProduct = sanitizeOutreachTextForLanguage(input.sellerProductSummary, language, productFallback);
  const linkedinValueProp = sanitizeOutreachTextForLanguage(
    input.sellerProductSummary,
    'en',
    DEFAULT_PRODUCT_BY_LANGUAGE.en,
  );
  // #96-1：按语种映射部门称呼（零汉字），绝不把中文 track.label 写进外语信。
  const targetDepartmentLabel = localizedDepartmentLabel(track.track, language);
  const firstName = leadContact?.fullName?.trim().split(/\s+/u)[0] ?? '';
  const linkedinNote =
    contactLinkedin && firstName
      ? buildValidatedLinkedInNote({
          firstName,
          companyName: input.company.name,
          sellerValueProp: linkedinValueProp,
          commonGroundHook,
        })
      : null;
  // #96-1：具名个人邮箱绝不生成 C 级 info@ 转介请求信。
  const referralDraft =
    !isPersonalEmail && (channelTier === 'C' || emailClass === 'role')
      ? buildReferralFirstInfoDraft({
          language,
          buyerCompanyName: input.company.name,
          targetDepartmentLabel,
          sellerProductSummary: sellerProduct,
          sellerLegalName: sellerName,
        })
      : null;
  const forwardableBlurb = buildForwardableBlurb({
    language,
    buyerCompanyName: input.company.name,
    targetDept: targetDepartmentLabel,
    sellerProductSummary: sellerProduct,
    sellerLegalName: sellerName,
  });
  return {
    linkedinNote,
    referralInfoDraft: referralDraft
      ? `${referralDraft.subject} — ${referralDraft.body.replace(/\n+/gu, ' ')}`
      : null,
    forwardableBlurb,
  };
}

function formatBattleComplianceAndAltChannels(args: {
  input: BattleRowBuildInput;
  leadContact: BattleDecisionMaker | null;
  d3: ReturnType<typeof evaluateMultiChannelOutreachPolicy>;
  supplierPortalUrl: string | null;
  contactFormOrPageUrl: string | null;
  companyLinkedin: string | null;
  companyPhone: string | null;
  publicWhatsapp: string | null;
  extraSocials: readonly string[];
}): { legalNoticeStatus: string; vendorPortalOrWhatsapp: string | null } {
  const {
    input,
    leadContact,
    d3,
    supplierPortalUrl,
    contactFormOrPageUrl,
    companyLinkedin,
    companyPhone,
    publicWhatsapp,
    extraSocials,
  } = args;
  const recordedArt14 = leadContact?.id ? input.article14StatusByContactId?.get(leadContact.id) : undefined;
  const art14Status = recordedArt14
    ? `Art.14:${recordedArt14}`
    : d3.requiresArticle14Notice
      ? 'Art.14:REQUIRED'
      : 'Art.14:N/A';
  const liaStatus = d3.requiresLiaRecord
    ? input.hasActiveWorkspaceLia
      ? 'LIA:ACTIVE'
      : 'LIA:PENDING'
    : 'LIA:N/A';
  const portalOrWa = [
    supplierPortalUrl ? `Portal:${supplierPortalUrl}` : null,
    contactFormOrPageUrl && contactFormOrPageUrl !== supplierPortalUrl
      ? `Contact:${contactFormOrPageUrl}`
      : null,
    companyLinkedin ? `Co-LI:${companyLinkedin}` : null,
    companyPhone ? `Tel:${companyPhone}` : null,
    d3.manualOutboundWhatsappAllowed && publicWhatsapp ? `WA:${publicWhatsapp}` : null,
    ...extraSocials,
  ]
    .filter(Boolean)
    .join(' | ');
  return {
    legalNoticeStatus: `${art14Status}; ${liaStatus}`,
    vendorPortalOrWhatsapp: portalOrWa || null,
  };
}

/** 将单条已核准线索转换为 21 列作战表行。 */
export function buildBattleCsvRow(input: BattleRowBuildInput): BattleCsvRow {
  const { lead, company, companyContactPoints, companyContactChannels = [], decisionMakers } = input;
  const namedDecisionMakers = decisionMakers.filter((dm) => !isPlaceholderContact(dm));
  const switchboardContacts = decisionMakers.filter((dm) => isPlaceholderContact(dm));
  const leadContact = prioritizeBuyingCommitteeContacts(namedDecisionMakers, 1)[0] ?? null;
  const channels = resolveBattleChannels(
    companyContactPoints,
    companyContactChannels,
    company.attributes,
    switchboardContacts,
    leadContact,
  );
  const track = classifyBuyingCommitteeTrack(leadContact?.title ?? null);
  const channelTier = classifyContactChannelTier({
    fullName: leadContact?.fullName ?? null,
    title: leadContact?.title ?? null,
    email: channels.chosenEmail,
    emailVerificationState: channels.chosenVerificationState,
    linkedinUrl: channels.contactLinkedin,
    // #96-2：仅真正的 supplier_page 才升级 B 级，普通联系页不虚抬分层。
    vendorPortalUrl: channels.supplierPortalUrl,
    publicWhatsappUrl: channels.publicWhatsapp,
  });
  const effectiveCountry =
    (company.country ?? '').trim().toUpperCase() ||
    resolveCompanyJurisdiction({
      name: company.name,
      domain: company.domain,
      country: company.country,
      attributes: company.attributes,
      // #96-5：传入公司渠道表电话，闭合 +39/+49 电话仍判 UNKNOWN 的 Art.14 Fail-Open 漏洞。
      contactChannels: companyContactChannels,
    })?.iso ||
    null;
  const d3 = evaluateMultiChannelOutreachPolicy({
    country: effectiveCountry,
    companyName: company.name,
    isPersonalEmail: channels.isPersonalEmail,
    publicBusinessWhatsappUrl: channels.publicWhatsapp,
  });
  const trigger = resolveTriggerHook(company, input.companySignals, input.draft);
  const copy = buildBattleOutreachCopy({
    input,
    effectiveCountry,
    leadContact,
    track,
    channelTier,
    emailClass: channels.emailClass,
    isPersonalEmail: channels.isPersonalEmail,
    contactLinkedin: channels.contactLinkedin,
    commonGroundHook: trigger.commonGroundHook,
  });
  const compliance = formatBattleComplianceAndAltChannels({
    input,
    leadContact,
    d3,
    supplierPortalUrl: channels.supplierPortalUrl,
    contactFormOrPageUrl: channels.contactFormOrPageUrl,
    companyLinkedin: channels.companyLinkedin,
    companyPhone: channels.companyPhone,
    publicWhatsapp: channels.publicWhatsapp,
    extraSocials: channels.extraSocials,
  });
  return {
    companyName: company.name,
    country: effectiveCountry || 'UNKNOWN',
    domain: company.domain,
    fitScore: lead.totalScore,
    evidenceSummary: summarizeEvidence(lead, company, input.judgmentRecord),
    channelTier,
    contactName: leadContact?.fullName ?? null,
    contactTitle: leadContact?.title ?? null,
    committeeTrack: track.label,
    contactEmail: channels.chosenEmail,
    emailVerificationState: channels.chosenVerificationState,
    // #96-6：LinkedIn 主页列仅展示个人领英（/in/ 或 /pub/），公司领英迁至备选通道 Co-LI。
    linkedinUrl: channels.contactLinkedin,
    triggerHook: trigger.triggerHook,
    linkedinNote: copy.linkedinNote,
    referralInfoDraft: copy.referralInfoDraft,
    vendorPortalOrWhatsapp: compliance.vendorPortalOrWhatsapp,
    complianceTag: d3.complianceTag,
    legalNoticeStatus: compliance.legalNoticeStatus,
    sellerInboundFooter: input.sellerInboundFooter ?? null,
    forwardableBlurb: copy.forwardableBlurb,
    outreachWindow: countryOutreachWindow(effectiveCountry),
  };
}

export function renderBattleCsvFromRows(
  rows: readonly BattleCsvRow[],
  maskEmails: boolean,
): string {
  return renderBattleCsv(rows, { maskEmails });
}
