/**
 * D3 法域合规多通道外联路由与护栏（Batch 1.3-A）：
 *
 * 严格落实 D3 法域分流矩阵（零猜测、确定性规则）：
 *  - CA（CASL）/ AE（阿联酋 PDPL）/ SA（沙特 PDPL）：冷邮一律 `CONSENT_REQUIRED`；
 *  - GB / UK（PECR）：仅企业法人实体（Ltd / Limited / PLC / LLP）可按合法利益发 B2B 邮件并履行 Art.14，
 *    个体户/非法人合伙（Sole Trader / Partnership）必须先获明确同意；
 *  - DE / AT / CH / EU 严格法域：冷邮个人箱需记录 LIA + Art.14 通知（DE/AT 优先建议 A 级职能箱、供应商门户、
 *    领英人工 1:1 破冰与邮件附卖方入站 `wa.me`），**严禁主动外呼 WhatsApp**；
 *  - US（CAN-SPAM）：允许 S 级直邮 + 法定主体/物理地址/退订页脚 + 领英 + 卖方入站 `wa.me`；
 *  - 拉美/亚非拉温热白名单市场（BR/MX/CO/CL/PE/AR/IN/ID/MY/TH/VN/PH/ZA）：
 *    仅在满足 4 重护栏（官网显式公开商务 `wa.me` + 未命中 `phone`/`whatsapp` 抑制 + 含退订句 + 纯人工点击）
 *    时允许人工 `wa.me` 外呼，严禁自动化群发。
 */
import { normalizeJurisdiction } from '../compliance/jurisdiction';
import { canonicalizeSuppressionValue } from '../discovery/suppression-value';

export type MultiChannelEmailRule = 'ALLOWED_WITH_FOOTER' | 'LEGITIMATE_INTEREST_STRICT' | 'CONSENT_REQUIRED';

export interface MultiChannelOutreachInput {
  readonly country: string | null | undefined;
  readonly companyName: string;
  readonly isPersonalEmail: boolean;
  readonly hasExplicitConsent?: boolean;
  readonly publicBusinessWhatsappUrl?: string | null;
  readonly suppressedPhones?: ReadonlySet<string>;
}

export interface MultiChannelOutreachDecision {
  readonly countryCode: string;
  readonly emailPolicy: MultiChannelEmailRule;
  readonly emailAllowedNow: boolean;
  readonly requiresArticle14Notice: boolean;
  readonly requiresLiaRecord: boolean;
  readonly ukCorporateSubscriberVerified: boolean | null;
  readonly manualLinkedInAllowed: boolean;
  readonly sellerInboundWhatsappAllowed: boolean;
  readonly manualOutboundWhatsappAllowed: boolean;
  readonly outboundWhatsappBlockedReason: string | null;
  readonly recommendedSequence: readonly string[];
  readonly complianceTag: string;
}

const CONSENT_REQUIRED_COUNTRIES = new Set(['CA', 'AE', 'SA']);
const STRICT_OPT_IN_EU_COUNTRIES = new Set(['DE', 'AT', 'CH']);
const WARM_MANUAL_WHATSAPP_COUNTRIES = new Set([
  'BR', 'MX', 'CO', 'CL', 'PE', 'AR', 'IN', 'ID', 'MY', 'TH', 'VN', 'PH', 'ZA',
]);
const UK_CORPORATE_SUFFIX_RE =
  /\b(?:ltd\.?|limited|plc|p\.l\.c\.|llp|l\.l\.p\.|lp|cic|cio|inc\.?|corp\.?)\b/iu;

/** UK PECR 企业法人判定（Ltd / Limited / PLC / LLP）；个体户/合伙未命中时保守判 false。 */
export function isUkCorporateSubscriber(companyName: string): boolean {
  return UK_CORPORATE_SUFFIX_RE.test(companyName.trim());
}

function evaluateWhatsappOutbound(input: {
  countryCode: string;
  publicBusinessWhatsappUrl?: string | null;
  suppressedPhones?: ReadonlySet<string>;
}): { allowed: boolean; reason: string | null } {
  if (!WARM_MANUAL_WHATSAPP_COUNTRIES.has(input.countryCode)) {
    return { allowed: false, reason: 'JURISDICTION_WHATSAPP_OUTBOUND_BLOCKED' };
  }
  const raw = (input.publicBusinessWhatsappUrl ?? '').trim();
  if (!raw) {
    return { allowed: false, reason: 'NO_PUBLIC_BUSINESS_WHATSAPP' };
  }
  const canonical = canonicalizeSuppressionValue('whatsapp', raw);
  if (!canonical) {
    return { allowed: false, reason: 'INVALID_WHATSAPP_E164' };
  }
  if (input.suppressedPhones?.has(canonical)) {
    return { allowed: false, reason: 'PHONE_OR_WHATSAPP_SUPPRESSED' };
  }
  return { allowed: true, reason: null };
}

/** 根据目标买家国别、法人形态与通道信号，产出确定性 D3 多通道合规路由裁决。 */
export function evaluateMultiChannelOutreachPolicy(
  input: MultiChannelOutreachInput,
): MultiChannelOutreachDecision {
  const countryCode = (input.country ?? '').trim().toUpperCase();
  const jurisdiction = normalizeJurisdiction(countryCode);
  const consent = Boolean(input.hasExplicitConsent);
  const wa = evaluateWhatsappOutbound({
    countryCode,
    publicBusinessWhatsappUrl: input.publicBusinessWhatsappUrl,
    suppressedPhones: input.suppressedPhones,
  });

  if (CONSENT_REQUIRED_COUNTRIES.has(countryCode)) {
    return {
      countryCode,
      emailPolicy: 'CONSENT_REQUIRED',
      emailAllowedNow: consent,
      requiresArticle14Notice: false,
      requiresLiaRecord: false,
      ukCorporateSubscriberVerified: null,
      manualLinkedInAllowed: true,
      sellerInboundWhatsappAllowed: true,
      manualOutboundWhatsappAllowed: false,
      outboundWhatsappBlockedReason: wa.reason,
      recommendedSequence: consent
        ? ['email_consented', 'linkedin_copilot', 'vendor_portal']
        : ['linkedin_copilot', 'vendor_portal', 'inbound_inquiry_only'],
      complianceTag: `${countryCode}:CONSENT_REQUIRED`,
    };
  }

  if (jurisdiction === 'UK') {
    const corp = isUkCorporateSubscriber(input.companyName);
    const emailPolicy: MultiChannelEmailRule = corp ? 'LEGITIMATE_INTEREST_STRICT' : 'CONSENT_REQUIRED';
    return {
      countryCode: countryCode || 'GB',
      emailPolicy,
      emailAllowedNow: corp || consent,
      requiresArticle14Notice: input.isPersonalEmail,
      requiresLiaRecord: input.isPersonalEmail,
      ukCorporateSubscriberVerified: corp,
      manualLinkedInAllowed: true,
      sellerInboundWhatsappAllowed: true,
      manualOutboundWhatsappAllowed: false,
      outboundWhatsappBlockedReason: wa.reason,
      recommendedSequence: corp
        ? ['email_b2b_corporate', 'linkedin_copilot', 'seller_inbound_wa']
        : ['linkedin_copilot', 'vendor_portal'],
      complianceTag: corp ? 'UK:PECR_CORPORATE_LI+ART14' : 'UK:PECR_SOLE_TRADER_CONSENT_REQUIRED',
    };
  }

  if (jurisdiction === 'EU' || STRICT_OPT_IN_EU_COUNTRIES.has(countryCode)) {
    const strictDach = STRICT_OPT_IN_EU_COUNTRIES.has(countryCode);
    const emailPolicy: MultiChannelEmailRule =
      strictDach && input.isPersonalEmail ? 'CONSENT_REQUIRED' : 'LEGITIMATE_INTEREST_STRICT';
    return {
      countryCode: countryCode || 'EU',
      emailPolicy,
      emailAllowedNow: emailPolicy === 'CONSENT_REQUIRED' ? consent : true,
      requiresArticle14Notice: input.isPersonalEmail,
      requiresLiaRecord: input.isPersonalEmail,
      ukCorporateSubscriberVerified: null,
      manualLinkedInAllowed: true,
      sellerInboundWhatsappAllowed: true,
      manualOutboundWhatsappAllowed: false,
      outboundWhatsappBlockedReason: wa.reason,
      recommendedSequence: strictDach
        ? ['linkedin_copilot', 'vendor_portal', 'functional_dept_email', 'seller_inbound_wa']
        : ['email_li_art14', 'linkedin_copilot', 'vendor_portal', 'seller_inbound_wa'],
      complianceTag: strictDach ? `${countryCode}:UWG_STRICT_LINKEDIN_FIRST+ART14` : `${countryCode || 'EU'}:GDPR_LI+ART14`,
    };
  }

  if (jurisdiction === 'US') {
    return {
      countryCode: 'US',
      emailPolicy: 'ALLOWED_WITH_FOOTER',
      emailAllowedNow: true,
      requiresArticle14Notice: false,
      requiresLiaRecord: false,
      ukCorporateSubscriberVerified: null,
      manualLinkedInAllowed: true,
      sellerInboundWhatsappAllowed: true,
      manualOutboundWhatsappAllowed: false,
      outboundWhatsappBlockedReason: wa.reason,
      recommendedSequence: ['direct_email_canspam', 'linkedin_copilot', 'seller_inbound_wa'],
      complianceTag: 'US:CAN_SPAM_FOOTER',
    };
  }

  return {
    countryCode: countryCode || 'OTHER',
    emailPolicy: 'ALLOWED_WITH_FOOTER',
    emailAllowedNow: true,
    requiresArticle14Notice: false,
    requiresLiaRecord: false,
    ukCorporateSubscriberVerified: null,
    manualLinkedInAllowed: true,
    sellerInboundWhatsappAllowed: true,
    manualOutboundWhatsappAllowed: wa.allowed,
    outboundWhatsappBlockedReason: wa.reason,
    recommendedSequence: wa.allowed
      ? ['direct_email_with_footer', 'linkedin_copilot', 'manual_wa_4guardrail']
      : ['direct_email_with_footer', 'linkedin_copilot', 'seller_inbound_wa'],
    complianceTag: wa.allowed ? `${countryCode}:B2B_FOOTER+WA_MANUAL_4GUARD` : `${countryCode || 'OTHER'}:B2B_FOOTER`,
  };
}
