import { createHash } from 'node:crypto';
import { normalizeDomain } from '../discovery/identity';

/**
 * 采集数据清洗（源无关）。把适配器返回的原始记录洗成规范、去噪、可 diff 的结构：
 * 归一域名、规整名称、校验邮箱/电话、去重产品，并**给邮箱分级**（职能 vs 人名）供合规门用。
 * 产出 contentHash（清洗后内容指纹）作为增量 diff 的判据。
 */

/** 适配器返回的原始实体（源特定字段塞 fields）。 */
export interface RawSourceEntity {
  externalId: string;
  name: string;
  website?: string;
  country?: string;
  fields?: Record<string, unknown>;
}

export interface CleanedEntity {
  externalId: string;
  name: string;
  domain?: string;
  country?: string;
  cleaned: Record<string, unknown>;
  contentHash: string;
  /** 清洗后是否含可识别自然人的联系方式（人名邮箱/直拨）→ 触发 GDPR 合规门 */
  personalData: boolean;
}

// 职能邮箱本地部分（非个人数据，GDPR Recital 14 豁免）
const ROLE_LOCALPARTS = new Set([
  'info', 'sales', 'contact', 'kontakt', 'office', 'mail', 'email', 'hello', 'hallo',
  'service', 'support', 'vertrieb', 'anfrage', 'enquiry', 'enquiries', 'inquiry',
  'marketing', 'admin', 'welcome', 'team', 'press', 'presse', 'export', 'shop',
]);
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function cleanName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

export function cleanEmail(raw?: string | null): { value: string; kind: 'role' | 'personal' } | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(v)) return null;
  const local = v.split('@')[0];
  // 纯职能名 → role；含 . _ - 分隔的疑似人名（john.smith）→ personal
  const isRole = ROLE_LOCALPARTS.has(local) || /^(no-?reply|mailbox)$/.test(local);
  const looksPersonal = /^[a-z]+[._-][a-z]+/.test(local) && !isRole;
  return { value: v, kind: looksPersonal ? 'personal' : 'role' };
}

export function cleanPhone(raw?: string | null): string | null {
  if (!raw) return null;
  const v = raw.replace(/[^\d+]/g, '');
  const digits = v.replace(/\D/g, '');
  return digits.length >= 6 && digits.length <= 15 ? v : null;
}

export function cleanStringList(raw: unknown, cap = 20): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of raw) {
    const s = typeof x === 'string' ? x.trim() : typeof x === 'object' && x && 'name' in x ? String((x as { name?: unknown }).name ?? '').trim() : '';
    const key = s.toLowerCase();
    if (s && !seen.has(key)) {
      seen.add(key);
      out.push(s);
      if (out.length >= cap) break;
    }
  }
  return out;
}

/** 稳定序列化后哈希——字段值相同则 hash 相同（供增量 diff 判"是否变化"）。 */
export function contentHashOf(obj: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(obj)).digest('hex');
}

function stableStringify(o: unknown): string {
  if (Array.isArray(o)) return `[${o.map(stableStringify).join(',')}]`;
  if (o && typeof o === 'object') {
    const keys = Object.keys(o as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${k}:${stableStringify((o as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(o ?? null);
}

/**
 * 把原始实体洗成 CleanedEntity。cleaned 里保留归一后的字段（命名空间由调用方在 fields 里给），
 * 但 email/phone/products 走本模块的清洗器统一处理并分级。
 */
export function cleanEntity(raw: RawSourceEntity): CleanedEntity | null {
  const name = cleanName(raw.name);
  if (!name) return null;
  const domain = raw.website ? normalizeDomain(raw.website) ?? undefined : undefined;
  const country = raw.country?.trim() || undefined;
  const f = raw.fields ?? {};

  const email = cleanEmail(f.email as string | undefined);
  const phone = cleanPhone(f.phone as string | undefined);
  const products = cleanStringList(f.products);

  const cleaned: Record<string, unknown> = pruneUndefined({
    email: email?.value,
    email_kind: email?.kind,
    phone,
    stand: typeof f.stand === 'string' ? f.stand.trim() : undefined,
    products: products.length ? products : undefined,
    hiring: f.hiring === true ? true : undefined,
    description: typeof f.description === 'string' ? f.description.slice(0, 500).trim() || undefined : undefined,
    source_fair: f.source_fair,
    source_kind: f.source_kind,
  });

  const personalData = email?.kind === 'personal';
  const contentHash = contentHashOf({ name, domain, country, ...cleaned });
  return { externalId: raw.externalId, name, domain, country, cleaned, contentHash, personalData };
}

function pruneUndefined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
}
