/**
 * 身份解析（PRD 8.8）：确定性规则优先 —— 域名精确匹配 > 名称+国家规范化。
 * 纯函数，可测试；匹配规则名记入 identity_link.match_rule 供审计。
 */

const LEGAL_SUFFIXES =
  /\b(gmbh|ag|kg|co\.?|ltd\.?|llc|inc\.?|corp\.?|s\.?a\.?|s\.?r\.?l\.?|b\.?v\.?|oy|ab|as|plc|pty|limited|company|holdings?)\b|有限公司|株式会社|주식회사/gi;

export function normalizeDomain(raw?: string | null): string | null {
  if (!raw) return null;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split(/[/?#]/)[0];
  return d || null;
}

export function normalizeCompanyName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface IdentityKey {
  dedupeKey: string;
  matchRule: 'domain_exact' | 'identifier_exact' | 'name_country';
}

/** provider 标识（税号/注册号/LEI…）；scheme 命名空间隔离 id 体系。 */
export interface CompanyIdentifier {
  scheme: string;
  value: string;
}

/** 归一 provider 标识：scheme 小写 + 值剥非字母数字（"DE 291499156"→"de291499156"）；空值 → null。 */
export function normalizeIdentifier(id?: CompanyIdentifier | null): string | null {
  if (!id) return null;
  const value = id.value.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (!value) return null;
  return `${id.scheme.toLowerCase()}:${value}`;
}

export function companyIdentity(rec: {
  name: string;
  domain?: string | null;
  country?: string | null;
  identifier?: CompanyIdentifier | null;
}): IdentityKey {
  const domain = normalizeDomain(rec.domain);
  if (domain) return { dedupeKey: `d:${domain}`, matchRule: 'domain_exact' };
  // §8.4：无域名但有 provider 标识（税号/注册号）→ 按 id 归一，防同名同国不同实体误并；
  // 无域名的 TED 中标方常见。scheme 命名空间隔离，绝不跨 id 体系（ted-natid ≠ lei）串号。
  const id = normalizeIdentifier(rec.identifier);
  if (id) return { dedupeKey: `id:${id}`, matchRule: 'identifier_exact' };
  return {
    dedupeKey: `n:${normalizeCompanyName(rec.name)}:${(rec.country ?? '').toLowerCase()}`,
    matchRule: 'name_country',
  };
}

export function contactIdentity(contact: { fullName: string; email?: string | null }, companyKey: string): string {
  if (contact.email) return `e:${contact.email.trim().toLowerCase()}`;
  return `c:${companyKey}:${contact.fullName.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}
