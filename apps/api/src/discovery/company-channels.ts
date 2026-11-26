import type { Prisma } from '@prisma/client';
import {
  contactPointHostSuppressed,
  reachableCompanyContactPoints,
} from './company-contact-points';
import {
  canonicalizeSuppressionValue,
  canonicalizeSuppressionValues,
  companyMatchesSuppression,
} from './suppression-value';

type SuppressionRow = { readonly type: string; readonly value: string };
import { isPlaceholderContact } from './providers/contact-quality-filter';
import { isStrictContactPageUrl } from './impressum/find-legal-pages';
import {
  prioritizeBuyingCommitteeContacts,
  type ContactEmailPointLike,
} from '../enrichment/buying-committee';

/**
 * 公司全渠道联系方式与社媒账号读模型聚合器（Batch 1.6）：
 * 统一汇总三类现网已落库但此前未读出的公司级公开通道：
 *  1) `company_contact_channel`（phone / email / form_url）；
 *  2) `company_contact_point`（supplier_page / contact_form / contact_page / impressum_page / linkedin_company_page / x_company_account）；
 *  3) `attributes.digital_footprint.structured_org.same_as`（LinkedIn / Facebook / Instagram / X / YouTube / WhatsApp）。
 * 读时严格执行公司/域名/邮箱禁联过滤，剔除 INVALID 与不安全链接。
 */

export interface StoredCompanyContactChannel {
  readonly companyId?: string;
  readonly channel: string;
  readonly value: string;
  readonly emailType: string | null;
  readonly status: string;
  readonly sourceType: string;
  readonly sourceUrl: string | null;
}

export interface LeadPackageCompanyChannel {
  readonly channel: 'email' | 'phone' | 'form_url';
  readonly value: string;
  readonly email_type: string | null;
  readonly status: string;
  readonly source_type: string;
  readonly source_url: string | null;
}

export type SocialPlatform =
  | 'linkedin'
  | 'facebook'
  | 'instagram'
  | 'x'
  | 'youtube'
  | 'whatsapp'
  | 'other';

export interface LeadPackageSocialProfile {
  readonly platform: SocialPlatform;
  readonly url: string;
  readonly source: 'contact_point' | 'structured_org';
}

export interface LeadChannelSummary {
  readonly emails: readonly string[];
  readonly phones: readonly string[];
  readonly forms: readonly string[];
  readonly socials: readonly { readonly platform: SocialPlatform; readonly url: string }[];
  readonly decisionMakerCount: number;
  readonly verifiedEmailCount: number;
}

const VALID_CHANNELS = new Set(['email', 'phone', 'form_url']);

function isHttpsUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('https://');
}

function classifySocialPlatform(url: string): SocialPlatform {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return 'other';
  }
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'linkedin';
  if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.com') return 'facebook';
  if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
  if (host === 'x.com' || host.endsWith('.x.com') || host === 'twitter.com' || host.endsWith('.twitter.com')) return 'x';
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
  if (host === 'wa.me' || host === 'whatsapp.com' || host.endsWith('.whatsapp.com')) return 'whatsapp';
  return 'other';
}

function isSocialHost(platform: SocialPlatform): boolean {
  return platform !== 'other';
}

function normalizeSocialUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password) return null;
    parsed.protocol = 'https:';
    parsed.hash = '';
    // WhatsApp 去掉预填文本 query，其它社媒去掉追踪参数
    if (parsed.hostname.toLowerCase().replace(/^www\./u, '') !== 'api.whatsapp.com') {
      parsed.search = '';
    }
    return parsed.toString().replace(/\/+$/u, '');
  } catch {
    return null;
  }
}

/** 读时应用禁联与状态过滤的公司渠道（`company_contact_channel`）。 */
export function filterReachableCompanyChannels(
  channels: readonly StoredCompanyContactChannel[],
  suppressions: readonly SuppressionRow[],
  company: { name: string; domain: string | null },
): LeadPackageCompanyChannel[] {
  if (companyMatchesSuppression(suppressions, company)) return [];
  const suppressedDomains = canonicalizeSuppressionValues(
    'domain',
    suppressions.filter((row) => row.type === 'domain').map((row) => row.value),
  );
  const suppressedEmails = canonicalizeSuppressionValues(
    'email',
    suppressions.filter((row) => row.type === 'email').map((row) => row.value),
  );
  const seen = new Set<string>();
  const out: LeadPackageCompanyChannel[] = [];
  for (const row of channels) {
    if (!VALID_CHANNELS.has(row.channel) || row.status === 'INVALID') continue;
    const value = row.value.trim();
    if (!value) continue;
    if (row.channel === 'email') {
      const email = canonicalizeSuppressionValue('email', value);
      const host = email ? canonicalizeSuppressionValue('domain', email.split('@')[1]) : null;
      if (!email || suppressedEmails.has(email) || (host && suppressedDomains.has(host))) continue;
    } else if (row.channel === 'form_url') {
      if (
        !isHttpsUrl(value) ||
        contactPointHostSuppressed(value, suppressedDomains) ||
        !isStrictContactPageUrl(value)
      ) {
        continue;
      }
    }
    const dedupeKey = `${row.channel}\n${value.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(
      Object.freeze({
        channel: row.channel as LeadPackageCompanyChannel['channel'],
        value,
        email_type: row.emailType ?? null,
        status: row.status,
        source_type: row.sourceType,
        source_url: isHttpsUrl(row.sourceUrl) ? row.sourceUrl : null,
      }),
    );
  }
  const order: Record<string, number> = { email: 0, phone: 1, form_url: 2 };
  return out.sort((a, b) => (order[a.channel] ?? 9) - (order[b.channel] ?? 9) || a.value.localeCompare(b.value));
}

/** 汇总公司官方社媒链接（`company_contact_point` + `digital_footprint.structured_org.same_as`）。 */
export function extractCompanySocialProfiles(
  contactPoints: ReadonlyArray<{ kind: string; value: string; status: string }>,
  attributes: unknown,
  suppressions: readonly SuppressionRow[] = [],
  company?: { name: string; domain: string | null },
): LeadPackageSocialProfile[] {
  if (company && companyMatchesSuppression(suppressions, company)) return [];
  const suppressedDomains = canonicalizeSuppressionValues(
    'domain',
    suppressions.filter((row) => row.type === 'domain').map((row) => row.value),
  );
  const seen = new Set<string>();
  const profiles: LeadPackageSocialProfile[] = [];
  const push = (rawUrl: unknown, source: LeadPackageSocialProfile['source']) => {
    const normalized = normalizeSocialUrl(rawUrl);
    if (!normalized) return;
    if (contactPointHostSuppressed(normalized, suppressedDomains)) return;
    const platform = classifySocialPlatform(normalized);
    if (!isSocialHost(platform)) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    profiles.push(Object.freeze({ platform, url: normalized, source }));
  };

  for (const pt of contactPoints) {
    if (pt.status === 'INVALID') continue;
    if (pt.kind === 'linkedin_company_page' || pt.kind === 'x_company_account') {
      push(pt.value, 'contact_point');
    }
  }

  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    const df = (attributes as Record<string, unknown>).digital_footprint;
    if (df && typeof df === 'object' && !Array.isArray(df)) {
      const org = (df as Record<string, unknown>).structured_org;
      if (org && typeof org === 'object' && !Array.isArray(org)) {
        const sameAs = (org as Record<string, unknown>).same_as;
        if (Array.isArray(sameAs)) {
          for (const url of sameAs) push(url, 'structured_org');
        }
      }
    }
  }

  const rank: Record<SocialPlatform, number> = {
    linkedin: 0,
    whatsapp: 1,
    facebook: 2,
    instagram: 3,
    x: 4,
    youtube: 5,
    other: 6,
  };
  return profiles.sort((a, b) => rank[a.platform] - rank[b.platform] || a.url.localeCompare(b.url));
}

/** 宽容读取 `company_contact_channel`（兼容未 mock 该表的既有单测）。 */
export async function loadCompanyContactChannels(
  tx: Prisma.TransactionClient,
  companyIds: readonly string[],
): Promise<StoredCompanyContactChannel[]> {
  if (companyIds.length === 0) return [];
  const delegate = (tx as unknown as {
    companyContactChannel?: {
      findMany?: (args: unknown) => Promise<StoredCompanyContactChannel[]>;
    };
  }).companyContactChannel;
  if (typeof delegate?.findMany !== 'function') return [];
  return delegate.findMany({
    where: { companyId: { in: [...companyIds] }, status: { not: 'INVALID' } },
    select: {
      companyId: true,
      channel: true,
      value: true,
      emailType: true,
      status: true,
      sourceType: true,
      sourceUrl: true,
    },
    orderBy: [{ channel: 'asc' }, { value: 'asc' }],
  });
}

/** 按公司 ID 分组读取公司级渠道，便于批量评分/导出调用。 */
export async function loadCompanyContactChannelsByCompany(
  tx: Prisma.TransactionClient,
  companyIds: readonly string[],
): Promise<Map<string, StoredCompanyContactChannel[]>> {
  const channels = await loadCompanyContactChannels(tx, companyIds);
  const byCompany = new Map<string, StoredCompanyContactChannel[]>();
  for (const ch of channels) {
    if (!ch.companyId) continue;
    const list = byCompany.get(ch.companyId) ?? [];
    list.push(ch);
    byCompany.set(ch.companyId, list);
  }
  return byCompany;
}

/** 取得单家公司在已分组 map 中的可达渠道（供 `qualify.activities` 保持零额外分支）。 */
export function reachableChannelsForCompany(
  channelsByCompany: ReadonlyMap<string, StoredCompanyContactChannel[]>,
  company: { id: string; name: string; domain: string | null },
  suppressions: readonly SuppressionRow[],
): Array<{ channel: string; status: string }> {
  return filterReachableCompanyChannels(
    channelsByCompany.get(company.id) ?? [],
    suppressions,
    company,
  ).map((ch) => ({ channel: ch.channel, status: ch.status }));
}

interface SummaryCompanyRow {
  id: string;
  name: string;
  domain: string | null;
  status?: string;
  attributes?: unknown;
}

/** 批量构建线索列表卡片的渠道与决策人摘要（供 `GET /leads`）。 */
export async function loadLeadListChannelSummaries(
  tx: Prisma.TransactionClient,
  companies: readonly SummaryCompanyRow[],
): Promise<Map<string, LeadChannelSummary>> {
  const summaries = new Map<string, LeadChannelSummary>();
  if (companies.length === 0) return summaries;

  const rawTx = tx as unknown as {
    companyContactChannel?: { findMany?: unknown };
    companyContactPoint?: { findMany?: unknown };
    canonicalContact?: { findMany?: unknown };
  };
  // 最小单测 stub 未挂载渠道表时返回空 Map，保持列表旧契约；真实 Prisma tx 恒有这些 delegate。
  if (
    typeof rawTx.companyContactChannel?.findMany !== 'function' &&
    typeof rawTx.companyContactPoint?.findMany !== 'function' &&
    typeof rawTx.canonicalContact?.findMany !== 'function'
  ) {
    return summaries;
  }

  const companyIds = companies.map((c) => c.id);
  const channels = await loadCompanyContactChannels(tx, companyIds);

  const pointDelegate = (tx as unknown as {
    companyContactPoint?: { findMany?: (args: unknown) => Promise<Array<{ companyId: string; kind: string; value: string; status: string }>> };
  }).companyContactPoint;
  const contactPoints =
    typeof pointDelegate?.findMany === 'function'
      ? await pointDelegate.findMany({
          where: { companyId: { in: companyIds }, status: { not: 'INVALID' } },
          select: { companyId: true, kind: true, value: true, status: true },
        })
      : [];

  const contactDelegate = (tx as unknown as {
    canonicalContact?: {
      findMany?: (args: unknown) => Promise<Array<{
        companyId: string;
        fullName: string;
        title: string | null;
        contactPoints: Array<{ type: string; value: string; status: string }>;
      }>>;
    };
  }).canonicalContact;
  const contacts =
    typeof contactDelegate?.findMany === 'function'
      ? await contactDelegate.findMany({
          where: { companyId: { in: companyIds } },
          select: {
            companyId: true,
            fullName: true,
            title: true,
            contactPoints: { select: { type: true, value: true, status: true } },
          },
        })
      : [];

  const supDelegate = (tx as unknown as {
    suppressionRecord?: { findMany?: (args: unknown) => Promise<SuppressionRow[]> };
  }).suppressionRecord;
  const suppressions =
    typeof supDelegate?.findMany === 'function'
      ? await supDelegate.findMany({
          where: { type: { in: ['domain', 'company_name', 'email'] } },
          select: { type: true, value: true },
        })
      : [];

  const channelsByCo = new Map<string, StoredCompanyContactChannel[]>();
  for (const ch of channels) {
    if (!ch.companyId) continue;
    const list = channelsByCo.get(ch.companyId) ?? [];
    list.push(ch);
    channelsByCo.set(ch.companyId, list);
  }
  const pointsByCo = new Map<string, Array<{ kind: string; value: string; status: string }>>();
  for (const pt of contactPoints) {
    const list = pointsByCo.get(pt.companyId) ?? [];
    list.push(pt);
    pointsByCo.set(pt.companyId, list);
  }
  const contactsByCo = new Map<string, typeof contacts>();
  for (const ct of contacts) {
    const list = contactsByCo.get(ct.companyId) ?? [];
    list.push(ct);
    contactsByCo.set(ct.companyId, list);
  }

  for (const company of companies) {
    if (company.status === 'SUPPRESSED') {
      summaries.set(company.id, {
        emails: [],
        phones: [],
        forms: [],
        socials: [],
        decisionMakerCount: 0,
        verifiedEmailCount: 0,
      });
      continue;
    }
    const safeChannels = filterReachableCompanyChannels(
      channelsByCo.get(company.id) ?? [],
      suppressions,
      company,
    );
    const safePoints = reachableCompanyContactPoints(
      pointsByCo.get(company.id) ?? [],
      suppressions,
      company,
    );
    const socials = extractCompanySocialProfiles(
      safePoints,
      company.attributes,
      suppressions,
      company,
    );
    const coContacts = contactsByCo.get(company.id) ?? [];
    const namedContacts = coContacts.filter((ct) => !isPlaceholderContact(ct));
    const emails = new Set<string>(
      safeChannels.filter((c) => c.channel === 'email').map((c) => c.value),
    );
    const phones = new Set<string>(
      safeChannels.filter((c) => c.channel === 'phone').map((c) => c.value),
    );
    const forms = new Set<string>([
      ...safeChannels.filter((c) => c.channel === 'form_url').map((c) => c.value),
      ...safePoints
        .filter((p) => p.kind === 'contact_form' || p.kind === 'supplier_page' || p.kind === 'contact_page')
        .map((p) => p.value),
    ]);
    let verifiedEmailCount = safeChannels.filter(
      (c) => c.channel === 'email' && c.status === 'VALID',
    ).length;
    for (const ct of coContacts) {
      for (const pt of ct.contactPoints) {
        if (pt.type === 'email' && pt.status === 'VALID') verifiedEmailCount += 1;
      }
    }
    summaries.set(company.id, {
      emails: [...emails].slice(0, 3),
      phones: [...phones].slice(0, 2),
      forms: [...forms].slice(0, 2),
      socials: socials.slice(0, 6).map(({ platform, url }) => ({ platform, url })),
      decisionMakerCount: namedContacts.length,
      verifiedEmailCount,
    });
  }

  return summaries;
}

/** 过滤历史总机/非具名邮箱占位行，并按邮箱质量与决策委员会优先级排序（供 `GET /canonical-companies/:id` 复用）。 */
export function filterDecisionMakerContacts<
  T extends {
    fullName?: string | null;
    title?: string | null;
    points?: readonly ContactEmailPointLike[] | null;
    contactPoints?: readonly ContactEmailPointLike[] | null;
  },
>(contacts: readonly T[]): T[] {
  return prioritizeBuyingCommitteeContacts(
    contacts.filter((contact) => !isPlaceholderContact(contact)),
  );
}

/** 读出单家公司的全渠道联系点与社媒（供 `GET /canonical-companies/:id` 复用，不污染主服务行数预算）。 */
export async function loadCanonicalCompanyChannels(
  tx: Prisma.TransactionClient,
  company: { id: string; name: string; domain: string | null; status: string; attributes: unknown },
): Promise<{
  contactChannels: LeadPackageCompanyChannel[];
  contactPoints: Array<{ kind: string; value: string; status: string }>;
  socialProfiles: LeadPackageSocialProfile[];
}> {
  if (company.status === 'SUPPRESSED') {
    return { contactChannels: [], contactPoints: [], socialProfiles: [] };
  }
  const supDelegate = (tx as unknown as {
    suppressionRecord?: { findMany?: (args: unknown) => Promise<SuppressionRow[]> };
  }).suppressionRecord;
  const suppressions =
    typeof supDelegate?.findMany === 'function'
      ? await supDelegate.findMany({
          where: { type: { in: ['domain', 'company_name', 'email'] } },
          select: { type: true, value: true },
        })
      : [];
  const rawChannels = await loadCompanyContactChannels(tx, [company.id]);
  const pointDelegate = (tx as unknown as {
    companyContactPoint?: {
      findMany?: (args: unknown) => Promise<Array<{ kind: string; value: string; status: string }>>;
    };
  }).companyContactPoint;
  const rawPoints =
    typeof pointDelegate?.findMany === 'function'
      ? await pointDelegate.findMany({
          where: { companyId: company.id, status: { not: 'INVALID' } },
          select: { kind: true, value: true, status: true },
          orderBy: [{ kind: 'asc' }, { value: 'asc' }],
        })
      : [];
  const contactPoints = reachableCompanyContactPoints(rawPoints, suppressions, company);
  const contactChannels = filterReachableCompanyChannels(rawChannels, suppressions, company);
  const socialProfiles = extractCompanySocialProfiles(
    contactPoints,
    company.attributes,
    suppressions,
    company,
  );
  return { contactChannels, contactPoints, socialProfiles };
}
