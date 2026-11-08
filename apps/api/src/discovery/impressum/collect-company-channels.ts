import { extractPublicContacts } from '../../adapters/contact-extractor';
import { classifyContactEmail } from '../contact-classifier';
import type { CompanyChannelInput, CompanyChannelSourceType } from '../company-contact-channel';
import {
  decodeCfEmail,
  decodeHtmlEntities,
  decodeObfuscatedEmails,
  extractJsonLdContacts,
  normalizePhone,
} from './impressum-extract';
import type { LegalPageKind } from './find-legal-pages';

/**
 * A1（2026-11-08）：把已抓取的 Impressum/联系页装配成**公司级**联系方式（A4 写入器的输入）。
 * 纯函数（页面内容由调用方经 ToolBroker 抓取）：
 *  - 只收本站域（含子域）邮箱——公开的公司联系方式；站外个人邮箱（gmail 等）丢弃；
 *  - `classifyContactEmail` 判 personal 的**不进公司层**（具名人只走联系人层，A4 的闸门）；
 *  - 电话经 `normalizePhone` 归一（幂等唯一键）；非 DE/AT/CH 国别只收带 `+` 的号码；
 *  - 每条渠道携带来源类型/来源页/robots 留痕；邮箱记 legitimate_interest（ePrivacy 职能邮箱）。
 */

export interface ImpressumPage {
  url: string;
  kind: LegalPageKind;
  /** 渲染后的原始 HTML（crawl4ai.render 可得）。缺失时仅用 text。 */
  html?: string;
  /** markdown/纯文本（crawl4ai.fetch）。 */
  text: string;
}

export interface CollectCompanyChannelsArgs {
  /** 公司主域（小写、无 www）。邮箱必须落在该域或子域上。 */
  domain: string;
  /** ISO 国家码；仅 DE/AT/CH 启用无 `+` 号码的国别补全。 */
  country?: string;
  pages: ImpressumPage[];
  /** 渠道总上限（默认 8）。 */
  cap?: number;
}

const SOURCE_OF_KIND: Record<LegalPageKind, CompanyChannelSourceType> = {
  impressum: 'impressum',
  contact: 'contact_page',
  about: 'homepage',
};

/**
 * 页面 URL 的 DB 安全形态（与 company_contact_channel_source_url_check 同源）：https、无空白、
 * 8–2048；剥掉 userinfo。网页可控值绝不允许把整家公司的落库事务 throw 掉（fail-safe 降级）。
 */
export function safePageUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return undefined;
    url.username = '';
    url.password = '';
    const value = url.toString();
    if (value.length < 8 || value.length > 2048 || /\s/u.test(value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

const MAILTO_RE = /mailto:([^"'>\s]+)/giu;
const TEL_HREF_RE = /href=["']tel:([^"']+)["']/giu;
const CFEMAIL_RE = /data-cfemail=["']([0-9a-f]+)["']/giu;

function dialOf(country: string | undefined): 'DE' | 'AT' | 'CH' | undefined {
  const iso = (country ?? '').trim().toUpperCase();
  return iso === 'DE' || iso === 'AT' || iso === 'CH' ? iso : undefined;
}

function decodingPercent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** 域名里的通用企业词（比较「同组织」时忽略）。 */
const GENERIC_DOMAIN_TOKENS = new Set([
  'www', 'group', 'gruppe', 'holding', 'gmbh', 'mbh', 'ag', 'kg', 'ohg', 'ug', 'gbr', 'co',
  'company', 'corp', 'deutschland', 'germany', 'international', 'global', 'shop', 'online',
  'service', 'services', 'mail', 'ecommerce', 'handel', 'trade',
  // 本域常见行业词：不因共享 «pumpen/technik» 把第三方当成同组织。
  'pumpen', 'pumps', 'technik', 'tech', 'industrie', 'industry', 'maschinen', 'anlagen',
  'bau', 'engineering', 'hydraulik', 'armaturen',
]);

function domainTokens(host: string): Set<string> {
  const label = host.split('.')[0] ?? '';
  return new Set(
    label.split(/[^a-z0-9]+/u).filter((token) => token.length >= 4 && !GENERIC_DOMAIN_TOKENS.has(token)),
  );
}

/**
 * 邮箱是否属于该公司：本站域（含子域）直接认可；**同组织域**（sanotact-group.de 的 Impressum
 * 发布 info@sanotact.de）按「非通用词根相交」认可——Impressum 法定的联系邮箱常落在品牌/集团旧域。
 * 站外第三方（建站公司 webagentur.de、gmail 等）词根不相交，仍被丢弃。
 */
function isCompanyDomain(email: string, domain: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const host = email.slice(at + 1).toLowerCase();
  if (host === domain || host.endsWith(`.${domain}`)) return true;
  // 他域把公司域当前缀/中间段（peter.de.evil.com、mueller-pumpen.de.evil.com）是冒充形态，
  // 词根相交也不收（合法的子域形态 mail.peter.de 已在上面放行）。
  if (host.startsWith(`${domain}.`) || host.includes(`.${domain}.`)) return false;
  const companyTokens = domainTokens(domain);
  if (companyTokens.size === 0) return false;
  // 只认**词根完全相等**（sanotact-group.de ↔ sanotact.de；tsurumi.de ↔ tsurumi.eu）。
  // 前缀启发式（algamdach.de ↔ algam.de、peters-webdesign.de ↔ peter.de）会误收第三方，已移除。
  return [...domainTokens(host)].some((token) => companyTokens.has(token));
}

export function collectCompanyChannels(args: CollectCompanyChannelsArgs): CompanyChannelInput[] {
  const cap = args.cap ?? 8;
  const domain = args.domain.toLowerCase().replace(/^www\./u, '');
  const dial = dialOf(args.country);
  const out: CompanyChannelInput[] = [];
  const seen = new Set<string>(); // type:value

  const pushEmail = (page: ImpressumPage, raw: string): void => {
    const value = raw.trim().toLowerCase();
    if (!value || value.length > 512 || !isCompanyDomain(value, domain)) return;
    const { emailType } = classifyContactEmail(value);
    if (emailType === 'personal') return; // 具名人只进联系人层
    // 判不出的单段 local（ds@/mm@/pg@ 这类德国 Impressum 常见的缩写）不冒认公司渠道；
    // 词形态（impressum@/datenschutz@）保留。联系人层对同地址仍按 red 保守处理。
    if (emailType === 'other') {
      const local = value.slice(0, value.lastIndexOf('@')).split('+')[0] ?? '';
      if (!/^[a-z]{4,}$/u.test(local)) return;
    }
    const key = `email:${value}`;
    if (seen.has(key) || out.length >= cap) return;
    seen.add(key);
    const sourceUrl = safePageUrl(page.url);
    out.push({
      channel: 'email',
      value,
      emailType,
      sourceType: SOURCE_OF_KIND[page.kind],
      ...(sourceUrl ? { sourceUrl } : {}),
      robotsStatus: 'allowed',
      tosStatus: 'unknown',
      legalBasis: 'legitimate_interest',
      verificationMethod: 'import',
    });
  };

  const pushPhone = (page: ImpressumPage, raw: string): void => {
    const value = normalizePhone(raw, dial);
    // 与写入器/DB 同源：归一后只应是「+ 数字」且 ≤32 字符。
    if (!value || value.length > 32 || !/^\+?[0-9]+$/u.test(value)) return;
    const key = `phone:${value}`;
    if (seen.has(key) || out.length >= cap) return;
    seen.add(key);
    const sourceUrl = safePageUrl(page.url);
    out.push({
      channel: 'phone',
      value,
      sourceType: SOURCE_OF_KIND[page.kind],
      ...(sourceUrl ? { sourceUrl } : {}),
      robotsStatus: 'allowed',
      tosStatus: 'unknown',
    });
  };

  for (const page of args.pages) {
    if (out.length >= cap) break;
    // HTML 面：mailto / cfemail / JSON-LD（markdown 里看不到的形态）。先做实体解码——
    // `href="mailto:info&#64;acme.de"` 这类防爬编码在德国 Impressum 上很常见。
    if (page.html) {
      const html = decodeHtmlEntities(page.html);
      for (const match of html.matchAll(MAILTO_RE)) {
        const addr = decodingPercent(match[1] ?? '').split('?')[0] ?? '';
        pushEmail(page, addr);
      }
      for (const match of html.matchAll(CFEMAIL_RE)) {
        const decoded = decodeCfEmail(match[1] ?? '');
        if (decoded) pushEmail(page, decoded);
      }
      for (const match of html.matchAll(TEL_HREF_RE)) {
        pushPhone(page, decodingPercent(match[1] ?? ''));
      }
      const jsonld = extractJsonLdContacts(html);
      for (const email of jsonld.emails) pushEmail(page, email);
      for (const phone of jsonld.phones) pushPhone(page, phone);
    }
    // 文本面：确定性正则（邮箱/电话/混淆形态）。
    const textFound = extractPublicContacts([{ url: page.url, text: page.text }]);
    for (const found of textFound) {
      if (found.type === 'email') pushEmail(page, found.value);
    }
    for (const email of decodeObfuscatedEmails(page.text)) pushEmail(page, email);
    for (const found of textFound) {
      if (found.type === 'phone') pushPhone(page, found.value);
    }
    // 联系表单：contact 页的干净 URL（green 公司事实）。与 DB CHECK 同源（https、无查询串/
    // 锚点/空白、≤512）；不合规的页面 URL 直接放弃，绝不让网页可控值 throw 落库事务。
    if (page.kind === 'contact' && page.html && /<form[\s>]/iu.test(page.html) && out.length < cap) {
      const safe = safePageUrl(page.url);
      const clean = safe ? safe.split('?')[0]!.split('#')[0]! : undefined;
      if (clean && clean.length <= 512 && !seen.has(`form_url:${clean}`)) {
        seen.add(`form_url:${clean}`);
        out.push({
          channel: 'form_url',
          value: clean,
          sourceType: 'contact_page',
          sourceUrl: clean,
          robotsStatus: 'allowed',
          tosStatus: 'unknown',
        });
      }
    }
  }
  return out;
}
