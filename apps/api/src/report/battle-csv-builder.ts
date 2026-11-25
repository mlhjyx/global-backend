/**
 * 19 列受审计多通道作战清表（Battle CSV）行构造器（Batch 1.4-C）。
 *
 * 将已过 DataRights EXPORT / 制裁 / 合成隔离 / 抑制过滤后的线索、决策人、公司联络点、
 * Art.14/LIA 合规记录组装为 `BattleCsvRow`，并经 `renderBattleCsv()` 输出带 UTF-8 BOM
 * 与 CWE-1236 公式中和的正式 CSV。
 */
import type { Prisma } from '@prisma/client';
import { classifyContactEmail } from '../discovery/contact-classifier';
import { resolveCompanyJurisdiction } from '../discovery/jurisdiction-resolver';
import {
  buildLinkedInCoPilotPlaybook,
  buildReferralFirstInfoDraft,
  classifyBuyingCommitteeTrack,
  classifyContactChannelTier,
  prioritizeBuyingCommitteeContacts,
} from '../enrichment/buying-committee';
import { evaluateMultiChannelOutreachPolicy } from '../outreach/multi-channel-playbook';
import { isGenericSwitchboardContact } from '../discovery/providers/contact-quality-filter';
import { extractCompanySocialProfiles } from '../discovery/company-channels';
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

export interface BattleRowBuildInput {
  readonly lead: BattleLeadFact;
  readonly company: BattleCompanyFact;
  readonly companyContactPoints: readonly { kind: string; value: string; status?: string }[];
  readonly companyContactChannels?: readonly BattleCompanyChannel[];
  readonly decisionMakers: readonly BattleDecisionMaker[];
  readonly draft: { subject: string; body: string } | null;
  readonly article14StatusByContactId?: ReadonlyMap<string, string>;
  readonly hasActiveWorkspaceLia?: boolean;
  readonly sellerName?: string | null;
  readonly sellerProductSummary?: string | null;
  readonly sellerInboundFooter?: string | null;
}

function summarizeEvidence(lead: BattleLeadFact, company: BattleCompanyFact): string {
  const parts: string[] = [];
  if (lead.fitVerdict) parts.push(`fit=${lead.fitVerdict}`);
  const detail = lead.scoreDetail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const rec = detail as Record<string, unknown>;
    if (typeof rec.summary === 'string' && rec.summary.trim()) {
      parts.push(rec.summary.trim().slice(0, 180));
    } else if (typeof rec.reason === 'string' && rec.reason.trim()) {
      parts.push(rec.reason.trim().slice(0, 180));
    }
  }
  if (parts.length === 0 && company.attributes && typeof company.attributes === 'object' && !Array.isArray(company.attributes)) {
    const attrs = company.attributes as Record<string, unknown>;
    if (typeof attrs.industry === 'string' && attrs.industry.trim()) {
      parts.push(attrs.industry.trim().slice(0, 120));
    }
  }
  return parts.join(' | ') || '已通过匹配与合规校验';
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
  const emails = points.filter((p) => {
    if (p.type !== 'email' || p.status === 'INVALID' || p.verificationState === 'INVALID') return false;
    const isPatternGuess = p.sourceType === 'pattern_guess' || p.verificationMethod === 'pattern_guess';
    const isConfirmedValid = p.verificationState === 'VALID' || p.status === 'VALID';
    return !isPatternGuess || isConfirmedValid;
  });
  if (emails.length === 0) return null;
  const rank = (state?: string | null): number =>
    state === 'VALID' ? 4 : state === 'CATCH_ALL_RISKY' ? 3 : state === 'UNKNOWN' ? 2 : 1;
  return [...emails].sort((a, b) => rank(b.verificationState) - rank(a.verificationState))[0] ?? null;
}

type EmailVerificationStateLike = 'VALID' | 'CATCH_ALL_RISKY' | 'UNKNOWN' | 'INVALID' | null;

function resolveBattleChannels(
  companyContactPoints: readonly { kind: string; value: string; status?: string }[],
  companyContactChannels: readonly BattleCompanyChannel[],
  companyAttributes: Prisma.JsonValue,
  switchboardContacts: readonly BattleDecisionMaker[],
  leadContact: BattleDecisionMaker | null,
) {
  const contactEmailPoint = leadContact ? pickBestEmailPoint(leadContact.points) : null;
  const contactLinkedin = leadContact?.points.find((p) => p.type === 'linkedin')?.value ?? null;
  const socials = extractCompanySocialProfiles(
    companyContactPoints.map((p) => ({ kind: p.kind, value: p.value, status: p.status ?? 'UNVERIFIED' })),
    companyAttributes,
  );
  const companyLinkedin = socials.find((s) => s.platform === 'linkedin')?.url ?? null;
  const socialWhatsapp = socials.find((s) => s.platform === 'whatsapp')?.url ?? null;
  const extraSocials = socials
    .filter((s) => s.platform !== 'linkedin' && s.platform !== 'whatsapp')
    .slice(0, 3)
    .map((s) => `${s.platform.toUpperCase()}:${s.url}`);
  const switchboardEmails = switchboardContacts.flatMap((c) =>
    c.points.filter((p) => p.type === 'email').map((p) => p.value),
  );
  const switchboardPhones = switchboardContacts.flatMap((c) =>
    c.points.filter((p) => p.type === 'phone').map((p) => p.value),
  );
  const companyEmails = [
    ...companyContactChannels.filter((c) => c.channel === 'email' && c.status !== 'INVALID').map((c) => c.value),
    ...companyContactPoints.filter((p) => p.kind === 'email').map((p) => p.value),
    ...switchboardEmails,
  ];
  const companyPhone =
    companyContactChannels.find((c) => c.channel === 'phone' && c.status !== 'INVALID')?.value ??
    switchboardPhones[0] ??
    null;
  const functionalCompanyEmail =
    companyEmails.find((e) => classifyContactEmail(e).emailType !== 'role') ?? null;
  const chosenEmail = contactEmailPoint?.value ?? functionalCompanyEmail ?? companyEmails[0] ?? null;
  const chosenVerificationState =
    (contactEmailPoint?.verificationState as EmailVerificationStateLike) ?? null;
  const emailClass = chosenEmail ? classifyContactEmail(chosenEmail).emailType : null;
  const vendorPortal =
    companyContactPoints.find((p) => p.kind === 'supplier_page')?.value ??
    companyContactPoints.find((p) => p.kind === 'contact_form')?.value ??
    companyContactChannels.find((c) => c.channel === 'form_url' && c.status !== 'INVALID')?.value ??
    companyContactPoints.find((p) => p.kind === 'contact_page')?.value ??
    null;
  return {
    contactLinkedin,
    displayLinkedin: contactLinkedin ?? companyLinkedin,
    vendorPortal,
    companyPhone,
    publicWhatsapp: companyContactPoints.find((p) => p.kind === 'whatsapp')?.value ?? socialWhatsapp,
    extraSocials,
    chosenEmail,
    chosenVerificationState,
    emailClass,
    isPersonalEmail: emailClass === 'personal' || emailClass === 'other',
  };
}

const CJK_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const DEFAULT_PRODUCT_BY_LANGUAGE: Readonly<Record<string, string>> = Object.freeze({
  it: 'componenti e prodotti industriali OEM/ODM',
  de: 'Industrieprodukte (OEM/ODM)',
  es: 'productos industriales OEM/ODM',
  fr: 'produits industriels OEM/ODM',
  pt: 'produtos industriais OEM/ODM',
  en: 'industrial OEM/ODM products',
});

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

function buildBattleOutreachCopy(args: {
  input: BattleRowBuildInput;
  effectiveCountry: string | null;
  leadContact: BattleDecisionMaker | null;
  track: ReturnType<typeof classifyBuyingCommitteeTrack>;
  channelTier: ReturnType<typeof classifyContactChannelTier>;
  emailClass: ReturnType<typeof classifyContactEmail>['emailType'] | null;
  contactLinkedin: string | null;
}): { linkedinNote: string | null; referralInfoDraft: string | null } {
  const { input, effectiveCountry, leadContact, track, channelTier, emailClass, contactLinkedin } = args;
  const language = languageForCountry(effectiveCountry);
  const productFallback = DEFAULT_PRODUCT_BY_LANGUAGE[language] ?? DEFAULT_PRODUCT_BY_LANGUAGE.en;
  const sellerName = sanitizeOutreachTextForLanguage(input.sellerName, language, 'Our Manufacturing Team');
  const sellerProduct = sanitizeOutreachTextForLanguage(input.sellerProductSummary, language, productFallback);
  const linkedinValueProp = sanitizeOutreachTextForLanguage(
    input.sellerProductSummary,
    'en',
    DEFAULT_PRODUCT_BY_LANGUAGE.en,
  );
  const firstName = leadContact?.fullName?.trim().split(/\s+/u)[0] ?? '';
  const linkedinNote =
    contactLinkedin && firstName
      ? buildLinkedInCoPilotPlaybook({
          firstName,
          companyName: input.company.name,
          sellerValueProp: linkedinValueProp,
        }).templates.differentiated_cold
      : null;
  const referralDraft =
    channelTier === 'C' || emailClass === 'role'
      ? buildReferralFirstInfoDraft({
          language,
          buyerCompanyName: input.company.name,
          targetDepartmentLabel: track.track === 'other' ? 'Procurement / Purchasing' : track.label,
          sellerProductSummary: sellerProduct,
          sellerLegalName: sellerName,
        })
      : null;
  return {
    linkedinNote,
    referralInfoDraft: referralDraft
      ? `${referralDraft.subject} — ${referralDraft.body.replace(/\n+/gu, ' ')}`
      : null,
  };
}

function formatBattleComplianceAndAltChannels(args: {
  input: BattleRowBuildInput;
  leadContact: BattleDecisionMaker | null;
  d3: ReturnType<typeof evaluateMultiChannelOutreachPolicy>;
  vendorPortal: string | null;
  companyPhone: string | null;
  publicWhatsapp: string | null;
  extraSocials: readonly string[];
}): { legalNoticeStatus: string; vendorPortalOrWhatsapp: string | null } {
  const { input, leadContact, d3, vendorPortal, companyPhone, publicWhatsapp, extraSocials } = args;
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
    vendorPortal ? `Portal:${vendorPortal}` : null,
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

/** 将单条已核准线索转换为 19 列作战表行。 */
export function buildBattleCsvRow(input: BattleRowBuildInput): BattleCsvRow {
  const { lead, company, companyContactPoints, companyContactChannels = [], decisionMakers } = input;
  const namedDecisionMakers = decisionMakers.filter((dm) => !isGenericSwitchboardContact(dm));
  const switchboardContacts = decisionMakers.filter((dm) => isGenericSwitchboardContact(dm));
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
    vendorPortalUrl: channels.vendorPortal,
    publicWhatsappUrl: channels.publicWhatsapp,
  });
  const effectiveCountry =
    (company.country ?? '').trim().toUpperCase() ||
    resolveCompanyJurisdiction({
      name: company.name,
      domain: company.domain,
      country: company.country,
      attributes: company.attributes,
    })?.iso ||
    null;
  const d3 = evaluateMultiChannelOutreachPolicy({
    country: effectiveCountry,
    companyName: company.name,
    isPersonalEmail: channels.isPersonalEmail,
    publicBusinessWhatsappUrl: channels.publicWhatsapp,
  });
  const copy = buildBattleOutreachCopy({
    input,
    effectiveCountry,
    leadContact,
    track,
    channelTier,
    emailClass: channels.emailClass,
    contactLinkedin: channels.contactLinkedin,
  });
  const compliance = formatBattleComplianceAndAltChannels({
    input,
    leadContact,
    d3,
    vendorPortal: channels.vendorPortal,
    companyPhone: channels.companyPhone,
    publicWhatsapp: channels.publicWhatsapp,
    extraSocials: channels.extraSocials,
  });
  return {
    companyName: company.name,
    country: effectiveCountry || 'UNKNOWN',
    domain: company.domain,
    fitScore: lead.totalScore,
    evidenceSummary: summarizeEvidence(lead, company),
    channelTier,
    contactName: leadContact?.fullName ?? null,
    contactTitle: leadContact?.title ?? null,
    committeeTrack: track.label,
    contactEmail: channels.chosenEmail,
    emailVerificationState: channels.chosenVerificationState,
    linkedinUrl: channels.displayLinkedin,
    triggerHook: input.draft?.subject ?? null,
    linkedinNote: copy.linkedinNote,
    referralInfoDraft: copy.referralInfoDraft,
    vendorPortalOrWhatsapp: compliance.vendorPortalOrWhatsapp,
    complianceTag: d3.complianceTag,
    legalNoticeStatus: compliance.legalNoticeStatus,
    sellerInboundFooter: input.sellerInboundFooter ?? null,
  };
}

export function renderBattleCsvFromRows(
  rows: readonly BattleCsvRow[],
  maskEmails: boolean,
): string {
  return renderBattleCsv(rows, { maskEmails });
}
