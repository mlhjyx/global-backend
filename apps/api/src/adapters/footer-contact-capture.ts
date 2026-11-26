/**
 * Pre-Readability 页脚与企业公开联系信号捕获（Batch 1.2-B / 1.7C）：
 *
 * Readability 抽取正文前通常会删掉 `<footer>` / `<address>` / `[role="contentinfo"]`
 * 以及 `<script type="application/ld+json">`，导致大量海外 B2B 企业（尤其意大利/西班牙/
 * 中东/拉美/德国官网）只写在页脚或 JSON-LD 里的职能邮箱（`sales@`、`info@`、`rfq@`、
 * `export@`）、总机 `tel:`、显式公开商务 WhatsApp（`wa.me` / `api.whatsapp.com/send`）、
 * 公司地址与 EU VAT / 意大利 P.IVA 税号全部丢失。
 *
 * 数据最小化与零个人数据红线：
 *  - 只保留公司同域（或同根域）的**职能邮箱**（显式 B2B 职能别名白名单 + `classifyContactEmail`
 *    非 `personal`/`other` 判定），任何具名个人邮箱（`person@`、`john.doe@`、`jdoe@`）一律过滤丢弃；
 *  - WhatsApp 仅采集页面显式公开的 `wa.me/<digits>` / `api.whatsapp.com/send?phone=<digits>`
 *    商务链接，并剥离 query 里的预填消息文本；
 *  - JSON-LD 仅遍历非 `Person` 组织节点的 `vatID` / `taxID` 并经 `eu-vat.ts` 严格校验，绝不抽取任何个人 PII；
 *  - 当页脚与 JSON-LD 没有任何上述结构化公司信号时，格式化输出为空字符串（零正文/哈希扰动）。
 */
import { parseHTML } from 'linkedom';
import { classifyContactEmail } from '../discovery/contact-classifier';
import { canonicalizeSuppressionValue } from '../discovery/suppression-value';
import { companyNavigationLinks } from '../discovery/website-profile/contact-paths';
import {
  extractAllEuVats,
  normalizeEuVatWithHint,
  type ExtractEuVatOptions,
} from '../discovery/website-profile/eu-vat';

export interface FooterCapturedContacts {
  readonly roleEmails: readonly string[];
  readonly phones: readonly string[];
  readonly whatsappUrls: readonly string[];
  readonly addresses: readonly string[];
  readonly vatIds: readonly string[];
  readonly vendorPortalUrls: readonly string[];
}

const MAX_ROLE_EMAILS = 6;
const MAX_PHONES = 4;
const MAX_WHATSAPP = 3;
const MAX_ADDRESSES = 2;
const MAX_VAT_IDS = 2;
const MAX_ADDRESS_CHARS = 240;

const MAX_DOM_TEXT_DEPTH = 64;
const MAX_JSONLD_SCRIPTS = 16;
const MAX_JSONLD_SCRIPT_CHARS = 128_000;
const MAX_JSONLD_DEPTH = 10;
const MAX_JSONLD_NODES = 1_000;
const MAX_JSONLD_FIELD_VALUES = 4;

const EMAIL_IN_TEXT_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu;
const INTL_PHONE_RE = /\+[0-9][0-9 ()\-./]{6,18}[0-9]/gu;
const JSONLD_TYPE_RE = /^\s*application\/ld\+json(?:\s*;|$)/iu;
const ITALIAN_LOCALE_RE = /^it(?:[-_]it)?$/iu;
const WORD_CHAR_END_RE = /[\p{L}\p{N}]$/u;
const WORD_CHAR_START_RE = /^[\p{L}\p{N}]/u;

const HIDDEN_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
const HARD_BREAK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'BUTTON', 'DD', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR',
  'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TBODY', 'TD', 'TFOOT',
  'TH', 'THEAD', 'TR', 'UL', 'A',
]);
const SOFT_BREAK_TAGS = new Set(['SPAN', 'STRONG', 'LABEL']);

const EXTRA_ROLE_LOCALPARTS = new Set([
  'rfq', 'quote', 'quotes', 'export', 'import', 'order', 'orders', 'bestellung',
  'buy', 'hallo', 'email', 'general', 'main', 'reception', 'empfang', 'team',
  'company', 'shop', 'press', 'presse', 'quality', 'qa', 'compliance', 'legal',
]);

interface FooterBaseContext {
  readonly base: URL;
  readonly companyDomain: string | null;
}

interface FooterSignalAccumulator {
  readonly roleEmails: string[];
  readonly phones: string[];
  readonly whatsappUrls: string[];
  readonly addresses: string[];
  readonly vatIds: string[];
  readonly footerAnchors: Array<{ target: string; label: string }>;
}

function emptyCapturedContacts(): FooterCapturedContacts {
  return Object.freeze({
    roleEmails: [],
    phones: [],
    whatsappUrls: [],
    addresses: [],
    vatIds: [],
    vendorPortalUrls: [],
  });
}

function isExplicitRoleEmail(email: string): boolean {
  const classified = classifyContactEmail(email);
  if (classified.emailType !== 'personal' && classified.emailType !== 'other') {
    return true;
  }
  if (classified.emailType === 'personal') return false;
  const local = (email.split('@')[0] ?? '').split('+')[0] ?? '';
  const bare = local.replace(/[._-]?\d+$/u, '').replace(/[._-](eu|us|de|uk|global|team)$/u, '');
  return EXTRA_ROLE_LOCALPARTS.has(local) || EXTRA_ROLE_LOCALPARTS.has(bare);
}

function sameCompanyDomain(email: string, companyDomain: string | null): boolean {
  if (!companyDomain) return false;
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  const host = canonicalizeSuppressionValue('domain', email.slice(at + 1));
  return Boolean(host && (host === companyDomain || host.endsWith(`.${companyDomain}`)));
}

function normalizePhoneValue(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  const normalized = decoded.trim().replace(/^00/u, '+').replace(/[^\d+]/gu, '');
  const digits = normalized.replace(/\D/gu, '');
  if (digits.length < 7 || digits.length > 16) return null;
  return normalized.startsWith('+') ? `+${digits}` : digits;
}

function normalizeWhatsAppUrl(rawHref: string, base: URL): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawHref, base);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./u, '');
  let digits: string;
  if (host === 'wa.me') {
    digits = parsed.pathname.replace(/^\//u, '').replace(/\D/gu, '');
  } else if (host === 'api.whatsapp.com' && parsed.pathname.startsWith('/send')) {
    digits = (parsed.searchParams.get('phone') ?? '').replace(/\D/gu, '');
  } else {
    return null;
  }
  if (digits.length < 8 || digits.length > 16) return null;
  return `https://wa.me/${digits}`;
}

interface CleanTextState {
  text: string;
  softBreak: boolean;
}

function collectCleanText(node: Node, state: CleanTextState, depth: number): void {
  if (depth > MAX_DOM_TEXT_DEPTH) return;
  if (node.nodeType === 3) {
    const raw = node.nodeValue ?? '';
    if (!raw) return;
    if (state.softBreak && WORD_CHAR_END_RE.test(state.text) && WORD_CHAR_START_RE.test(raw)) {
      state.text += ' ';
    }
    state.softBreak = false;
    state.text += raw;
    return;
  }
  if (node.nodeType !== 1) return;
  const tag = ((node as Element).tagName ?? '').toUpperCase();
  if (HIDDEN_TAGS.has(tag)) return;
  if (tag === 'BR' || tag === 'HR') {
    state.text += ' ';
    state.softBreak = false;
    return;
  }
  const hard = HARD_BREAK_TAGS.has(tag);
  const soft = !hard && SOFT_BREAK_TAGS.has(tag);
  if (hard) {
    state.text += ' ';
    state.softBreak = false;
  } else if (soft) {
    state.softBreak = true;
  }
  for (const child of Array.from(node.childNodes ?? [])) {
    collectCleanText(child, state, depth + 1);
  }
  if (hard) {
    state.text += ' ';
    state.softBreak = false;
  } else if (soft) {
    state.softBreak = true;
  }
}

/**
 * 从 DOM 节点抽取可见文本，跳过隐藏标签并在 `<br>` / 块级元素 / `<a>` / 相邻布局
 * `<span>` 边界保留空格，避免 `P.IVA IT02390660039<br /><a>Termini` 粘连破坏 `\b`。
 */
function cleanElementText(node: Element): string {
  const state: CleanTextState = { text: '', softBreak: false };
  collectCleanText(node, state, 0);
  return state.text.replace(/\s+/gu, ' ').trim();
}

function addUnique(target: string[], value: string, max: number): void {
  if (target.length < max && !target.includes(value)) target.push(value);
}

function resolveBaseContext(requestedUrl: string, responseUrl: string): FooterBaseContext | null {
  try {
    const company = new URL(requestedUrl);
    const base = new URL(responseUrl);
    return {
      base,
      companyDomain: canonicalizeSuppressionValue('domain', company.hostname),
    };
  } catch {
    return null;
  }
}

function detectDocumentCountryHint(document: Document): string | undefined {
  const lang = (document.documentElement?.getAttribute('lang') ?? '').trim();
  if (ITALIAN_LOCALE_RE.test(lang)) return 'IT';
  const ogLocale = (
    document.querySelector('meta[property="og:locale"]')?.getAttribute('content') ?? ''
  ).trim();
  if (ITALIAN_LOCALE_RE.test(ogLocale)) return 'IT';
  return undefined;
}

function isJsonLdPersonType(type: unknown): boolean {
  const isPerson = (value: unknown): boolean =>
    value === 'Person' || (typeof value === 'string' && /(^|[:/#])Person$/u.test(value));
  return isPerson(type) || (Array.isArray(type) && type.some(isPerson));
}

function jsonLdAddressIsItalian(address: unknown): boolean {
  if (!address || typeof address !== 'object' || Array.isArray(address)) return false;
  const rawCountry = (address as Record<string, unknown>).addressCountry;
  if (typeof rawCountry !== 'string') return false;
  const normalized = rawCountry.trim().toUpperCase();
  return normalized === 'IT' || normalized === 'ITALY' || normalized === 'ITALIA';
}

function pushJsonLdTaxField(
  rawField: unknown,
  vatIds: string[],
  vatOpts: ExtractEuVatOptions,
): void {
  const candidates = typeof rawField === 'string'
    ? [rawField]
    : Array.isArray(rawField)
      ? rawField.slice(0, MAX_JSONLD_FIELD_VALUES)
      : [];
  for (const item of candidates) {
    if (typeof item !== 'string' || item.length > 64) continue;
    const vat = normalizeEuVatWithHint(item, vatOpts);
    if (vat) addUnique(vatIds, vat, MAX_VAT_IDS);
  }
}

function jsonLdTraversalExhausted(
  vatIds: readonly string[],
  state: { visited: number },
  depth: number,
): boolean {
  return (
    vatIds.length >= MAX_VAT_IDS ||
    depth > MAX_JSONLD_DEPTH ||
    state.visited >= MAX_JSONLD_NODES
  );
}

function walkJsonLdForVats(
  node: unknown,
  vatIds: string[],
  vatOpts: ExtractEuVatOptions,
  state: { visited: number },
  depth: number,
): void {
  if (jsonLdTraversalExhausted(vatIds, state, depth) || !node || typeof node !== 'object') {
    return;
  }
  state.visited += 1;
  if (Array.isArray(node)) {
    for (const item of node) {
      walkJsonLdForVats(item, vatIds, vatOpts, state, depth + 1);
      if (jsonLdTraversalExhausted(vatIds, state, depth)) return;
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  if (isJsonLdPersonType(obj['@type'])) return; // 零个人 PII：Person 子树整块跳过
  const nodeOpts: ExtractEuVatOptions =
    !vatOpts.countryHint && jsonLdAddressIsItalian(obj.address)
      ? { ...vatOpts, countryHint: 'IT' }
      : vatOpts;
  pushJsonLdTaxField(obj.vatID, vatIds, nodeOpts);
  pushJsonLdTaxField(obj.taxID, vatIds, nodeOpts);
  for (const [key, value] of Object.entries(obj)) {
    if (key === '@context' || key === 'vatID' || key === 'taxID') continue;
    if (!value || typeof value !== 'object') continue;
    walkJsonLdForVats(value, vatIds, nodeOpts, state, depth + 1);
    if (jsonLdTraversalExhausted(vatIds, state, depth)) return;
  }
}

function extractJsonLdVatIds(
  document: Document,
  vatIds: string[],
  vatOpts: ExtractEuVatOptions,
): void {
  let processed = 0;
  const state = { visited: 0 };
  for (const script of Array.from(document.querySelectorAll('script[type]'))) {
    if (processed >= MAX_JSONLD_SCRIPTS || vatIds.length >= MAX_VAT_IDS) break;
    if (!JSONLD_TYPE_RE.test(script.getAttribute('type') ?? '')) continue;
    if (script.closest('template,noscript')) continue;
    processed += 1;
    const raw = (script.textContent ?? '').trim();
    if (!raw || raw.length > MAX_JSONLD_SCRIPT_CHARS) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    walkJsonLdForVats(parsed, vatIds, vatOpts, state, 0);
  }
}

function pushRoleEmailIfAllowed(
  raw: string,
  companyDomain: string | null,
  roleEmails: string[],
): void {
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned || !sameCompanyDomain(cleaned, companyDomain)) return;
  if (!isExplicitRoleEmail(cleaned)) return;
  addUnique(roleEmails, cleaned, MAX_ROLE_EMAILS);
}

function collectAnchorSignals(
  anchor: Element,
  ctx: FooterBaseContext,
  acc: FooterSignalAccumulator,
): void {
  if (anchor.closest('script,style,template,noscript')) return;
  const href = (anchor.getAttribute('href') ?? '').trim();
  if (!href || href.length > 2048) return;
  if (/^mailto:/iu.test(href)) {
    let addr = href.slice('mailto:'.length).split('?')[0] ?? '';
    try {
      addr = decodeURIComponent(addr);
    } catch {
      // 保留原值
    }
    pushRoleEmailIfAllowed(addr, ctx.companyDomain, acc.roleEmails);
    return;
  }
  if (/^tel:/iu.test(href)) {
    const phone = normalizePhoneValue(href.slice('tel:'.length));
    if (phone) addUnique(acc.phones, phone, MAX_PHONES);
    return;
  }
  const wa = normalizeWhatsAppUrl(href, ctx.base);
  if (wa) {
    addUnique(acc.whatsappUrls, wa, MAX_WHATSAPP);
    return;
  }
  try {
    const target = new URL(href, ctx.base).toString();
    const label = cleanElementText(anchor);
    acc.footerAnchors.push({ target, label: label.length <= 120 ? label : '' });
  } catch {
    // 忽略无效链接
  }
}

function collectContainerSignals(
  container: Element,
  ctx: FooterBaseContext,
  vatOpts: ExtractEuVatOptions,
  acc: FooterSignalAccumulator,
): void {
  for (const anchor of Array.from(container.querySelectorAll('a[href]'))) {
    collectAnchorSignals(anchor, ctx, acc);
  }
  const text = cleanElementText(container);
  if (!text) return;
  for (const email of text.match(EMAIL_IN_TEXT_RE) ?? []) {
    pushRoleEmailIfAllowed(email, ctx.companyDomain, acc.roleEmails);
  }
  for (const rawPhone of text.match(INTL_PHONE_RE) ?? []) {
    const phone = normalizePhoneValue(rawPhone);
    if (phone) addUnique(acc.phones, phone, MAX_PHONES);
  }
  for (const vat of extractAllEuVats(text, vatOpts)) {
    addUnique(acc.vatIds, vat, MAX_VAT_IDS);
  }
  if (container.tagName.toLowerCase() === 'address') {
    const addrText = text.slice(0, MAX_ADDRESS_CHARS);
    if (addrText.length >= 8 && !EMAIL_IN_TEXT_RE.test(addrText)) {
      addUnique(acc.addresses, addrText, MAX_ADDRESSES);
    }
    EMAIL_IN_TEXT_RE.lastIndex = 0;
  }
}

/**
 * 在 Readability 清除页脚与脚本前，从 DOM 的 JSON-LD 与 `<footer>` / `<address>` /
 * `[role="contentinfo"]` 中确定性抽取企业级联系与税号信号。
 */
export function extractFooterContactsFromDocument(
  document: Document,
  requestedUrl: string,
  responseUrl: string = requestedUrl,
): FooterCapturedContacts {
  const ctx = resolveBaseContext(requestedUrl, responseUrl);
  if (!ctx) return emptyCapturedContacts();

  const acc: FooterSignalAccumulator = {
    roleEmails: [],
    phones: [],
    whatsappUrls: [],
    addresses: [],
    vatIds: [],
    footerAnchors: [],
  };
  const vatOpts: ExtractEuVatOptions = {
    domain: ctx.companyDomain,
    countryHint: detectDocumentCountryHint(document),
  };

  // 先于脚本剥离提取组织级 JSON-LD vatID / taxID（绝不抽取个人 PII）。
  extractJsonLdVatIds(document, acc.vatIds, vatOpts);

  const containers = Array.from(
    document.querySelectorAll('footer, address, [role="contentinfo"]'),
  ).filter((node) => !node.closest('script,style,template,noscript'));
  for (const container of containers) {
    collectContainerSignals(container, ctx, vatOpts, acc);
  }

  const vendorPortalUrls: string[] = [];
  if (ctx.companyDomain && acc.footerAnchors.length > 0) {
    const navLinks = companyNavigationLinks(acc.footerAnchors, ctx.companyDomain);
    for (const link of navLinks) {
      if (link.label === 'Supplier') addUnique(vendorPortalUrls, link.target, 2);
    }
  }

  return Object.freeze({
    roleEmails: acc.roleEmails,
    phones: acc.phones,
    whatsappUrls: acc.whatsappUrls,
    addresses: acc.addresses,
    vatIds: acc.vatIds,
    vendorPortalUrls,
  });
}

/** 独立 HTML 入口（供 Impressum / 联系页渠道装配复用）。 */
export function extractFooterContactsFromHtml(
  html: string,
  requestedUrl: string,
  responseUrl: string = requestedUrl,
): FooterCapturedContacts {
  if (!html || !/<(?:footer|address)\b|contentinfo|application\/ld\+json/iu.test(html)) {
    return emptyCapturedContacts();
  }
  const { document } = parseHTML(html);
  return extractFooterContactsFromDocument(
    document as unknown as Document,
    requestedUrl,
    responseUrl,
  );
}

/**
 * 格式化为追加到 Readability Markdown 末尾的结构化页脚片段；
 * 若未捕获到任何公司级信号则返回空串（保持无信号页面输出与内容哈希 100% 不变）。
 */
export function formatFooterContactsMarkdown(captured: FooterCapturedContacts): string {
  const lines: string[] = [];
  for (const email of captured.roleEmails) lines.push(`- Email: ${email}`);
  for (const phone of captured.phones) lines.push(`- Tel: [phone](tel:${phone})`);
  for (const wa of captured.whatsappUrls) lines.push(`- WhatsApp: ${wa}`);
  for (const vat of captured.vatIds) lines.push(`- VAT: ${vat}`);
  for (const addr of captured.addresses) lines.push(`- Address: ${addr}`);
  if (lines.length === 0) return '';
  return `## Footer Contact Signals\n${lines.join('\n')}`;
}
