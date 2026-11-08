/**
 * A1（2026-11-08）：Impressum/legal 页挖掘的确定性抽取原语。纯函数、无 IO、无 LLM——
 * 每个抽出的邮箱/电话都能在源页上原样（或经公开算法可逆地）找到，无幻觉面。
 *
 * 覆盖形态：
 * - Cloudflare 邮箱混淆（data-cfemail：首字节 XOR key）；
 * - schema.org JSON-LD（Organization/contactPoint 的 email/telephone；Person 子树整体跳过——
 *   具名个人的联系方式只走联系人层，公司层闸门与 A4 一致）；
 * - 文本混淆（[at]/(at)/{at}/at + [dot] 等常见形态）；
 * - 电话归一（幂等唯一键需要：+49 (0)89 → +4989；无 + 的按站点国别补全）。
 */

const EMAIL_SHAPE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/u;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/** HTML 实体解码（`info&#64;acme.de` / `&#105;nfo@…` 是德国 Impressum 常见的防爬编码）。 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&#(\d+);/gu, (match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&([a-z]+);/giu, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * 渲染 HTML → 可见文本（确定性抽取器输入；实体解码、script/style/注释先剥掉）。
 * 结束标签按浏览器容错形态匹配（`</script >` / `</script foo="x">`）——这不是 HTML
 * 消毒器（输出只喂正则抽取、绝不回渲成 HTML），但要剥干净以免脚本体混进文本抽取
 *（CodeQL js/bad-tag-filter，alert #85）。
 */
export function stripHtml(html: string): string {
  return decodeHtmlEntities(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>/giu, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style[^>]*>/giu, ' ')
    .replace(/<!--[\s\S]*?--!?>/gu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ');
}

/** Cloudflare cfemail（`data-cfemail`/`__cf_email__`）：首字节为 XOR key，其余为密文。 */
export function decodeCfEmail(encoded: string): string | null {
  const hex = encoded.trim().toLowerCase();
  if (hex.length < 4 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(hex)) return null;
  const bytes = (hex.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16));
  const key = bytes[0];
  if (key === undefined) return null;
  // 分块解码：整段 fromCharCode(...spread) 在超长 hex（≥15 万字符）会抛 RangeError。
  let decoded = '';
  for (const byte of bytes.slice(1)) decoded += String.fromCharCode(byte ^ key);
  const value = decoded.toLowerCase();
  return EMAIL_SHAPE.test(value) ? value : null;
}

export interface JsonLdContacts {
  emails: string[];
  phones: string[];
}

/** schema.org JSON-LD 的组织级联系方式。Person 子树（含 employee、founder…）整体跳过。 */
export function extractJsonLdContacts(html: string): JsonLdContacts {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const scriptRe = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu;
  for (const match of html.matchAll(scriptRe)) {
    let doc: unknown;
    try {
      doc = JSON.parse(match[1] ?? '');
    } catch {
      continue; // 页面里的坏 JSON-LD 很常见，不能影响其它块。
    }
    walkJsonLd(doc, emails, phones);
  }
  return { emails: [...emails], phones: [...phones] };
}

function isPersonType(type: unknown): boolean {
  const isPerson = (value: unknown): boolean =>
    value === 'Person' || (typeof value === 'string' && /(^|[:/#])Person$/u.test(value));
  return isPerson(type) || (Array.isArray(type) && type.some(isPerson));
}

function walkJsonLd(node: unknown, emails: Set<string>, phones: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, emails, phones);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (isPersonType(obj['@type'])) return; // 具名人条目（含其 email/telephone）不进公司级结果
  const email = obj['email'];
  if (typeof email === 'string') {
    const value = email.trim().toLowerCase();
    if (EMAIL_SHAPE.test(value)) emails.add(value);
  }
  const telephone = obj['telephone'];
  if (typeof telephone === 'string' && telephone.trim()) phones.add(telephone.trim());
  for (const [key, value] of Object.entries(obj)) {
    if (key === '@context') continue;
    walkJsonLd(value, emails, phones);
  }
}

const AT_TOKEN = String.raw`\[at\]|\(at\)|\{at\}|\bat\b|\(ät\)|\[ät\]|\{ät\}|\bät\b`;
const DOT_TOKEN = String.raw`\[dot\]|\(dot\)|\{dot\}|\bdot\b|\(punkt\)|\[punkt\]|\{punkt\}|\bpunkt\b`;
// 量词全部有界（local ≤64、label ≤63，RFC 上限）——无界 `+` 在 40k 连续 ASCII 串上是
// 二次回溯（实测 38s/40k），crawl 文本混入 minified JS 时会白烧 CPU。
const OBFUSCATED_EMAIL_RE = new RegExp(
  String.raw`(?<![a-z0-9])[a-z0-9._%+-]{1,64}\s*(?:${AT_TOKEN})\s*[a-z0-9-]{1,63}(?:\s*(?:${DOT_TOKEN})\s*[a-z0-9-]{1,63})+`,
  'giu',
);
const DOT_SPLIT_RE = new RegExp(String.raw`\s*(?:${DOT_TOKEN})\s*`, 'giu');

/** 文本混淆形态解码（`info [at] domain [dot] de` 等）；只认「词 AT 词 DOT tld」三元组，避免误配。 */
export function decodeObfuscatedEmails(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(OBFUSCATED_EMAIL_RE)) {
    // 把 AT 记号换成 @、DOT 记号换成 .（记号两侧的空白一并吸收）。
    const candidate = match[0]
      .toLowerCase()
      .replace(new RegExp(String.raw`\s*(?:${AT_TOKEN})\s*`, 'iu'), '@')
      .replace(DOT_SPLIT_RE, '.');
    if (EMAIL_SHAPE.test(candidate)) out.push(candidate);
  }
  return out;
}

const DEFAULT_DIAL: Record<'DE' | 'AT' | 'CH', string> = { DE: '49', AT: '43', CH: '41' };

/**
 * 电话归一（幂等唯一键用）：只留数字与首位 `+`；`+49 (0)89 …` 去掉国别后的主干 0；
 * 无 `+` 的按站点国别补全——`089/1234567`（country='DE'）→ `+49891234567`。
 * 未给出可补全国别（DE/AT/CH）时，只接受带 `+` 的号码（不做国别猜测）。
 * 位数不在 7–15 之间返回 null。
 */
export function normalizePhone(raw: string, country?: 'DE' | 'AT' | 'CH'): string | null {
  const trimmed = raw.trim().replace(/^tel:\s*/iu, '');
  const cleaned = trimmed.replace(/[^\d+]/gu, '');
  if (!cleaned) return null;
  let value: string;
  if (cleaned.startsWith('+')) {
    // `+` 只在首位有效；`++49`/`+49+89` 这类脏值把后续 `+` 去掉。
    value = `+${cleaned.slice(1).replace(/\+/gu, '')}`;
    // 国别后的主干 0：`+49 (0) 0493…` 连续多个 0 也全部剥掉（幂等归一，同号只有一个唯一键）。
    value = value.replace(/^(\+4[391])0+(?=\d)/u, '$1');
    if (!/^\+[1-9]\d*$/u.test(value)) return null; // `+0…`/全零/空号不是国际号
  } else {
    if (!/^\d+$/u.test(cleaned)) return null; // `+` 出现在中间 = 脏值
    if (country && /^0\d+$/u.test(cleaned)) {
      value = `+${DEFAULT_DIAL[country]}${cleaned.replace(/^0+/u, '')}`;
    } else if (country && cleaned.length >= 7) {
      value = `+${DEFAULT_DIAL[country]}${cleaned}`;
    } else {
      return null;
    }
  }
  const digits = value.replace(/\D/gu, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return value;
}
