/**
 * BI-15 first-contact draft helpers (design `2026-10-10-lead-delivery-loop-design.md` §7).
 *
 * Everything here is pure: the fact table given to the model, the reply-entry footer
 * appended by code after generation, and the weekly-report cell. The model never sees a
 * contact, and the footer never comes from the model.
 */
import { deriveFitReasonCodes } from './reason-codes';
import { leadSignals } from './lead-package';
import { searchLanguagesForMarkets } from '../discovery/search-localization';

export interface OutreachFact {
  readonly key: string;
  readonly text: string;
}

export interface OutreachSellerInput {
  readonly name: string;
  readonly website: string | null;
  readonly summary: string | null;
  readonly claims: readonly { readonly id: string; readonly type: string; readonly statement: string }[];
  readonly offerings: readonly { readonly id: string; readonly name: string; readonly description: string | null }[];
}

export interface OutreachBuyerInput {
  readonly name: string;
  readonly domain: string | null;
  readonly country: string | null;
  readonly attributes: unknown;
}

export interface OutreachLeadInput {
  readonly fitVerdict: string | null;
  readonly totalScore: number | null;
  readonly queue: string | null;
  readonly scores: unknown;
  readonly scoreDetail: unknown;
}

export interface SellerReplyContact {
  readonly sellerName: string;
  readonly website: string | null;
  readonly email: string | null;
  readonly whatsapp: string | null;
}

/** Design §9: the draft is model output and must never read as ready-to-send. */
export const OUTREACH_DRAFT_LEGAL_NOTE = '草稿，需人工审阅；平台未发送';

const MAX_CLAIM_FACTS = 20;
const MAX_OFFERING_FACTS = 10;
const MAX_FACT_TEXT = 800;
const E164 = /^\+[1-9][0-9]{7,14}$/u;

const LANGUAGE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  de: '德语（Deutsch）',
  en: '英语（English）',
  fr: '法语（Français）',
  it: '意大利语（Italiano）',
  es: '西班牙语（Español）',
  nl: '荷兰语（Nederlands）',
  pl: '波兰语（Polski）',
});

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Seller WhatsApp numbers are only linkable in E.164 form. */
export function isE164(value: string): boolean {
  return E164.test(value);
}

function clip(value: string, max = MAX_FACT_TEXT): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** The buyer's country decides the draft language; unknown markets fall back to English. */
export function outreachDraftLanguage(country: string | null | undefined): string {
  return searchLanguagesForMarkets([country ?? ''])[0] ?? 'en';
}

export function sellerOutreachFacts(seller: OutreachSellerInput): OutreachFact[] {
  const facts: OutreachFact[] = [{ key: 'seller.name', text: clip(seller.name) }];
  if (seller.website) facts.push({ key: 'seller.website', text: clip(seller.website) });
  if (seller.summary) facts.push({ key: 'seller.summary', text: clip(seller.summary) });
  for (const claim of seller.claims.slice(0, MAX_CLAIM_FACTS)) {
    facts.push({ key: `seller.claim:${claim.id}`, text: clip(`[${claim.type}] ${claim.statement}`) });
  }
  for (const offering of seller.offerings.slice(0, MAX_OFFERING_FACTS)) {
    facts.push({
      key: `seller.offering:${offering.id}`,
      text: clip(offering.description ? `${offering.name}：${offering.description}` : offering.name),
    });
  }
  return facts;
}

export function buyerOutreachFacts(buyer: OutreachBuyerInput): OutreachFact[] {
  const profile = record(record(buyer.attributes).website_profile);
  const facts: OutreachFact[] = [{ key: 'buyer.name', text: clip(buyer.name) }];
  if (buyer.domain) facts.push({ key: 'buyer.domain', text: clip(buyer.domain) });
  if (buyer.country) facts.push({ key: 'buyer.country', text: clip(buyer.country) });
  const tradeRole = text(profile.trade_role);
  if (tradeRole) facts.push({ key: 'buyer.trade_role', text: tradeRole });
  if (typeof profile.own_manufacturing === 'boolean') {
    facts.push({ key: 'buyer.own_manufacturing', text: profile.own_manufacturing ? 'true' : 'false' });
  }
  const brands = (Array.isArray(profile.carried_brands) ? profile.carried_brands : [])
    .map((entry) => record(entry))
    .flatMap((entry) => {
      const name = text(entry.name);
      if (!name) return [];
      const country = text(entry.country).toUpperCase();
      return [country ? `${name} (${country})` : name];
    });
  if (brands.length) facts.push({ key: 'buyer.carried_brands', text: clip(brands.join('; ')) });
  return facts;
}

export function fitOutreachFacts(lead: OutreachLeadInput): OutreachFact[] {
  const facts: OutreachFact[] = [];
  if (lead.fitVerdict) facts.push({ key: 'fit.verdict', text: lead.fitVerdict });
  if (typeof lead.totalScore === 'number' && Number.isFinite(lead.totalScore)) {
    facts.push({ key: 'fit.score', text: lead.totalScore.toFixed(3) });
  }
  const codes = deriveFitReasonCodes({
    fitVerdict: lead.fitVerdict,
    queue: lead.queue,
    scores: lead.scores,
    scoreDetail: lead.scoreDetail,
  });
  if (codes.length) facts.push({ key: 'fit.reason_codes', text: clip(codes.join('; ')) });
  return facts;
}

/** One fact per signal; same type on the same day gets a stable #n suffix. */
export function signalOutreachFacts(attributes: unknown): OutreachFact[] {
  const seen = new Map<string, number>();
  return leadSignals(attributes).map((signal) => {
    const base = `signal:${signal.type}@${signal.at.slice(0, 10)}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const key = count === 1 ? base : `${base}#${count}`;
    return {
      key,
      text: clip(signal.url ? `${signal.type}（${signal.at.slice(0, 10)}）${signal.url}` : `${signal.type}（${signal.at.slice(0, 10)}）`),
    };
  });
}

/**
 * Design §7 / E8: the buyer picks the channel. Only channels taken from the seller's own
 * profile are appended, in a fixed order; with no channel the draft ends where the model
 * stopped.
 */
export function replyEntryFooter(contact: SellerReplyContact): string {
  // Every channel is clipped so a pathological profile cannot push the stored body
  // past the table's 4,000-character bound (the model body itself is capped at 1,200).
  const lines: string[] = [];
  if (contact.website) lines.push(`Website: ${clip(contact.website, 500)}`);
  if (contact.email) lines.push(`Email: ${clip(contact.email, 320)}`);
  if (contact.whatsapp && isE164(contact.whatsapp)) {
    lines.push(`WhatsApp: https://wa.me/${contact.whatsapp.slice(1)}`);
  }
  if (!lines.length) return '';
  return ['—', `Reply directly to ${clip(contact.sellerName, 120)}:`, ...lines].join('\n');
}

export function outreachDraftPrompt(facts: readonly OutreachFact[], language: string): string {
  const name = LANGUAGE_NAMES[language] ?? language;
  return [
    `目标国语言：${name}（${language}）。subject 与 body 必须用它书写；body_zh 写 body 的简体中文译文。`,
    '下面每行是一条可用事实，格式「事实键：内容」。只能引用这些事实；不得写入任何未列出的合作、价格、认证、人名、邮箱或电话。',
    ...facts.map((fact) => `- ${fact.key}: ${fact.text}`),
    `used_facts 只能从上面的事实键中选（至少一个）。正文不要写签名或联系方式——平台会在末尾追加卖方自己的回复入口。`,
  ].join('\n');
}

/** Unknown keys or an empty list mean the draft is ungrounded and must be discarded. */
export function ungroundedFacts(
  usedFacts: readonly string[],
  allowedKeys: ReadonlySet<string>,
): string[] {
  const normalized = [...new Set(usedFacts.map((key) => key.trim()))];
  if (normalized.length === 0) return ['<empty>'];
  return normalized.filter((key) => !allowedKeys.has(key));
}

/** Design §5 column 10: subject + body + Chinese translation + the review note, in one cell. */
export function outreachDraftCell(
  draft: { readonly subject: string; readonly body: string; readonly bodyZh: string } | null | undefined,
): string {
  if (!draft) return '';
  return [
    `主题：${draft.subject}`,
    draft.body,
    `中文译文：\n${draft.bodyZh}`,
    OUTREACH_DRAFT_LEGAL_NOTE,
  ].join('\n\n');
}
