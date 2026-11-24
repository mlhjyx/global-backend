/**
 * Pre-Readability 页脚与企业公开联系信号捕获（Batch 1.2-B）：
 *
 * Readability 抽取正文前通常会删掉 `<footer>` / `<address>` / `[role="contentinfo"]`，
 * 导致大量海外 B2B 企业（尤其意大利/西班牙/中东/拉美/德国官网）只写在页脚的
 * 职能邮箱（`sales@`、`info@`、`rfq@`、`export@`）、总机 `tel:`、显式公开商务 WhatsApp
 * （`wa.me` / `api.whatsapp.com/send`）、公司地址与 VAT 税号全部丢失。
 *
 * 数据最小化与零个人数据红线：
 *  - 只保留公司同域（或同根域）的**职能邮箱**（显式 B2B 职能别名白名单 + `classifyContactEmail`
 *    非 `personal`/`other` 判定），任何具名个人邮箱（`person@`、`john.doe@`、`jdoe@`）一律过滤丢弃；
 *  - WhatsApp 仅采集页面显式公开的 `wa.me/<digits>` / `api.whatsapp.com/send?phone=<digits>`
 *    商务链接，并剥离 query 里的预填消息文本；
 *  - 当页脚没有任何上述结构化公司信号时，格式化输出为空字符串（零正文/哈希扰动）。
 */
import { parseHTML } from 'linkedom';
import { classifyContactEmail } from '../discovery/contact-classifier';
import { canonicalizeSuppressionValue } from '../discovery/suppression-value';
import { companyNavigationLinks } from '../discovery/website-profile/contact-paths';

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

const EMAIL_IN_TEXT_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu;
const INTL_PHONE_RE = /\+[0-9][0-9 ()\-./]{6,18}[0-9]/gu;
const VAT_ID_RE =
  /\b(?:DE\d{9}|IT\d{11}|FR[A-Z0-9]{2}\d{9}|ES[A-Z0-9]\d{7}[A-Z0-9]|NL\d{9}B\d{2}|ATU\d{8}|CHE[- ]?\d{3}\.\d{3}\.\d{3}|GB\d{9}|PL\d{10}|BE0?\d{9}|SE\d{12}|DK\d{8}|FI\d{8}|PT\d{9}|CZ\d{8,10}|RO\d{2,10})\b/gu;

const EXTRA_ROLE_LOCALPARTS = new Set([
  'rfq', 'quote', 'quotes', 'export', 'import', 'order', 'orders', 'bestellung',
  'buy', 'hallo', 'email', 'general', 'main', 'reception', 'empfang', 'team',
  'company', 'shop', 'press', 'presse', 'quality', 'qa', 'compliance', 'legal',
]);

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

function cleanElementText(node: Element): string {
  const clone = node.cloneNode(true) as Element;
  for (const hidden of Array.from(clone.querySelectorAll('script,style,template,noscript'))) {
    hidden.remove();
  }
  return (clone.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

function addUnique(target: string[], value: string, max: number): void {
  if (target.length < max && !target.includes(value)) target.push(value);
}

function resolveBaseContext(requestedUrl: string, responseUrl: string): {
  base: URL;
  companyDomain: string | null;
} | null {
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

/**
 * 在 Readability 清除页脚前，从 DOM 的 `<footer>` / `<address>` / `[role="contentinfo"]`
 * 中确定性抽取企业级联系信号。
 */
export function extractFooterContactsFromDocument(
  document: Document,
  requestedUrl: string,
  responseUrl: string = requestedUrl,
): FooterCapturedContacts {
  const ctx = resolveBaseContext(requestedUrl, responseUrl);
  if (!ctx) {
    return Object.freeze({
      roleEmails: [],
      phones: [],
      whatsappUrls: [],
      addresses: [],
      vatIds: [],
      vendorPortalUrls: [],
    });
  }
  const roleEmails: string[] = [];
  const phones: string[] = [];
  const whatsappUrls: string[] = [];
  const addresses: string[] = [];
  const vatIds: string[] = [];
  const footerAnchors: Array<{ target: string; label: string }> = [];

  const containers = Array.from(
    document.querySelectorAll('footer, address, [role="contentinfo"]'),
  ).filter((node) => !node.closest('script,style,template,noscript'));

  const pushRoleEmail = (raw: string): void => {
    const cleaned = raw.trim().toLowerCase();
    if (!cleaned || !sameCompanyDomain(cleaned, ctx.companyDomain)) return;
    if (!isExplicitRoleEmail(cleaned)) return;
    addUnique(roleEmails, cleaned, MAX_ROLE_EMAILS);
  };

  for (const container of containers) {
    for (const anchor of Array.from(container.querySelectorAll('a[href]'))) {
      if (anchor.closest('script,style,template,noscript')) continue;
      const href = (anchor.getAttribute('href') ?? '').trim();
      if (!href || href.length > 2048) continue;
      if (/^mailto:/iu.test(href)) {
        let addr = href.slice('mailto:'.length).split('?')[0] ?? '';
        try {
          addr = decodeURIComponent(addr);
        } catch {
          // 保留原值
        }
        pushRoleEmail(addr);
        continue;
      }
      if (/^tel:/iu.test(href)) {
        const phone = normalizePhoneValue(href.slice('tel:'.length));
        if (phone) addUnique(phones, phone, MAX_PHONES);
        continue;
      }
      const wa = normalizeWhatsAppUrl(href, ctx.base);
      if (wa) {
        addUnique(whatsappUrls, wa, MAX_WHATSAPP);
        continue;
      }
      try {
        const target = new URL(href, ctx.base).toString();
        const label = cleanElementText(anchor);
        footerAnchors.push({ target, label: label.length <= 120 ? label : '' });
      } catch {
        // 忽略无效链接
      }
    }

    const text = cleanElementText(container);
    if (!text) continue;
    for (const email of text.match(EMAIL_IN_TEXT_RE) ?? []) pushRoleEmail(email);
    for (const rawPhone of text.match(INTL_PHONE_RE) ?? []) {
      const phone = normalizePhoneValue(rawPhone);
      if (phone) addUnique(phones, phone, MAX_PHONES);
    }
    for (const vat of text.match(VAT_ID_RE) ?? []) {
      addUnique(vatIds, vat.replace(/\s+/gu, ''), MAX_VAT_IDS);
    }
    if (container.tagName.toLowerCase() === 'address') {
      const addrText = text.slice(0, MAX_ADDRESS_CHARS);
      if (addrText.length >= 8 && !EMAIL_IN_TEXT_RE.test(addrText)) {
        addUnique(addresses, addrText, MAX_ADDRESSES);
      }
      EMAIL_IN_TEXT_RE.lastIndex = 0;
    }
  }

  const vendorPortalUrls: string[] = [];
  if (ctx.companyDomain && footerAnchors.length > 0) {
    const navLinks = companyNavigationLinks(footerAnchors, ctx.companyDomain);
    for (const link of navLinks) {
      if (link.label === 'Supplier') addUnique(vendorPortalUrls, link.target, 2);
    }
  }

  return Object.freeze({
    roleEmails,
    phones,
    whatsappUrls,
    addresses,
    vatIds,
    vendorPortalUrls,
  });
}

/** 独立 HTML 入口（供 Impressum / 联系页渠道装配复用）。 */
export function extractFooterContactsFromHtml(
  html: string,
  requestedUrl: string,
  responseUrl: string = requestedUrl,
): FooterCapturedContacts {
  if (!html || !/<(?:footer|address)\b|contentinfo/iu.test(html)) {
    return Object.freeze({
      roleEmails: [],
      phones: [],
      whatsappUrls: [],
      addresses: [],
      vatIds: [],
      vendorPortalUrls: [],
    });
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
