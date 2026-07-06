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
  matchRule: 'domain_exact' | 'name_country';
}

export function companyIdentity(rec: { name: string; domain?: string | null; country?: string | null }): IdentityKey {
  const domain = normalizeDomain(rec.domain);
  if (domain) return { dedupeKey: `d:${domain}`, matchRule: 'domain_exact' };
  return {
    dedupeKey: `n:${normalizeCompanyName(rec.name)}:${(rec.country ?? '').toLowerCase()}`,
    matchRule: 'name_country',
  };
}

export function contactIdentity(contact: { fullName: string; email?: string | null }, companyKey: string): string {
  if (contact.email) return `e:${contact.email.trim().toLowerCase()}`;
  return `c:${companyKey}:${contact.fullName.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}
