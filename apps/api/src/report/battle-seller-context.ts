/**
 * Battle CSV 卖方外语上下文与入站回复页脚解析器（Batch 1.8A，修 #96-4）。
 *
 * 解决中文工厂名/中文产品名经语言净空后退化成假大空 `"Our Manufacturing Team"` /
 * `"industrial OEM/ODM products"` 及 `sellerInboundFooter` 全空的问题：
 *  1) 外语卖方名优先级：site.name → site.profile.companyProfile.brandName/legalName
 *     → companyProfile.name 中英文片段 → companyProfile.website 域名品牌化 → 原文回退；
 *  2) 外语产品摘要优先级：过滤后的非 CJK offering.name → offering.description/attributes 拉丁文规格
 *     → claim.statement（APPROVED 优先于 EXTRACTED，capability/certification/value_prop/param）
 *     → icp.valueProps → companyProfile.summary/industry → 原文回退；
 *  3) 卖方入站页脚：复用 outreach-draft 口径汇总 `[sellerDisplayName, website, email, wa.me]`。
 */
import type { Prisma } from '@prisma/client';
import { filterOfferingNames } from '../discovery/offering-noise-filter';

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const E164_RE = /^\+[1-9][0-9]{7,14}$/u;
const UPPERCASE_ABBREVS = new Set(['pv', 'ev', 'ai', 'it', 'led', 'cnc', 'oem', 'odm', 'hjt', 'bess', 'ess', 'epc']);
const PRODUCT_CLAIM_TYPES = new Set(['capability', 'certification', 'value_prop', 'param']);

export interface BattleSellerProfileLike {
  readonly name: string;
  readonly website?: string | null;
  readonly summary?: string | null;
  readonly industry?: string | null;
  readonly businessEmail?: string | null;
  readonly publicContacts?: unknown;
}

export interface BattleSellerSiteLike {
  readonly name?: string | null;
  readonly profile?: unknown;
}

export interface BattleSellerOfferingLike {
  readonly name: string;
  readonly description?: string | null;
  readonly attributes?: unknown;
}

export interface BattleSellerClaimLike {
  readonly type: string;
  readonly statement: string;
  readonly status?: string | null;
}

export interface BattleSellerContext {
  readonly sellerName: string | null;
  readonly sellerProductSummary: string | null;
  readonly sellerInboundFooter: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function isNonCjkMeaningful(value: string): boolean {
  return value.length >= 2 && /[A-Za-z0-9]/u.test(value) && !CJK_RE.test(value);
}

function extractLatinNameFragment(raw: string): string | null {
  const trimmed = cleanText(raw);
  if (!trimmed) return null;
  if (isNonCjkMeaningful(trimmed)) return trimmed;
  const matches = trimmed.match(/[A-Za-z][A-Za-z0-9&.,'/\-\s]{2,80}/gu) ?? [];
  const best = matches
    .map((m) => m.replace(/^[\s\-–—(/,.:]+|[\s\-–—)/,.:]+$/gu, '').trim())
    .find((m) => /[A-Za-z]{2,}/u.test(m) && m.length >= 3);
  return best ?? null;
}

function brandizeWebsiteDomain(website: string | null | undefined): string | null {
  const raw = cleanText(website);
  if (!raw) return null;
  let host: string;
  try {
    const url = /^https?:\/\//iu.test(raw) ? new URL(raw) : new URL(`https://${raw}`);
    host = url.hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return null;
  }
  const stem = host.split('.')[0] ?? '';
  if (!stem || stem.length < 2) return null;
  const words = stem
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((part) =>
      UPPERCASE_ABBREVS.has(part)
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1),
    );
  return words.length > 0 ? words.join(' ') : null;
}

function normalizeWebsiteUrl(website: string | null | undefined): string | null {
  const raw = cleanText(website);
  if (!raw) return null;
  try {
    const parsed = /^https?:\/\//iu.test(raw) ? new URL(raw) : new URL(`https://${raw}`);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString().replace(/\/+$/u, '');
  } catch {
    return null;
  }
}

function extractLatinSpecsFromOffering(offering: BattleSellerOfferingLike): string[] {
  const out: string[] = [];
  const desc = cleanText(offering.description);
  if (desc && isNonCjkMeaningful(desc)) {
    out.push(desc.slice(0, 100));
  }
  const attrs = asRecord(offering.attributes);
  for (const value of Object.values(attrs)) {
    if (typeof value === 'string') {
      const s = cleanText(value);
      if (isNonCjkMeaningful(s)) out.push(s.slice(0, 60));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        const s = cleanText(item);
        if (isNonCjkMeaningful(s)) out.push(s.slice(0, 40));
      }
    }
  }
  return out;
}

function pickForeignSellerName(
  seller: BattleSellerProfileLike | null,
  site: BattleSellerSiteLike | null,
): string | null {
  const siteName = cleanText(site?.name);
  if (isNonCjkMeaningful(siteName)) return siteName;

  const siteCompany = asRecord(asRecord(site?.profile).companyProfile);
  for (const key of ['brandName', 'legalName', 'name']) {
    const candidate = cleanText(siteCompany[key]);
    if (isNonCjkMeaningful(candidate)) return candidate;
  }

  const fromProfileName = extractLatinNameFragment(seller?.name ?? '');
  if (fromProfileName) return fromProfileName;

  const fromDomain = brandizeWebsiteDomain(seller?.website);
  if (fromDomain) return fromDomain;

  return cleanText(seller?.name) || null;
}

function pickForeignProductSummary(input: {
  seller: BattleSellerProfileLike | null;
  offerings: readonly BattleSellerOfferingLike[];
  claims: readonly BattleSellerClaimLike[];
  icpValueProps?: unknown;
}): string | null {
  const filteredNames = filterOfferingNames(input.offerings.map((item) => item.name));
  const latinNames = filteredNames.filter(isNonCjkMeaningful);
  if (latinNames.length > 0) return latinNames.slice(0, 3).join(', ').slice(0, 140);

  const specSnippets = [...new Set(input.offerings.flatMap(extractLatinSpecsFromOffering))];
  if (specSnippets.length > 0) return specSnippets.slice(0, 3).join(', ').slice(0, 140);

  const orderedClaims = [...input.claims]
    .filter((claim) => PRODUCT_CLAIM_TYPES.has((claim.type ?? '').toLowerCase()))
    .sort((a, b) => (a.status === 'APPROVED' ? 0 : 1) - (b.status === 'APPROVED' ? 0 : 1));
  const latinClaims = orderedClaims
    .map((claim) => cleanText(claim.statement))
    .filter(isNonCjkMeaningful);
  if (latinClaims.length > 0) return latinClaims.slice(0, 2).join('; ').slice(0, 140);

  const valueProps = (Array.isArray(input.icpValueProps) ? input.icpValueProps : [])
    .map(cleanText)
    .filter(isNonCjkMeaningful);
  if (valueProps.length > 0) return valueProps.slice(0, 2).join('; ').slice(0, 140);

  const latinSummary = cleanText(input.seller?.summary);
  if (isNonCjkMeaningful(latinSummary)) return latinSummary.slice(0, 140);
  const latinIndustry = cleanText(input.seller?.industry);
  if (isNonCjkMeaningful(latinIndustry)) return latinIndustry.slice(0, 140);

  return (
    filteredNames.slice(0, 3).join(', ') ||
    cleanText(input.seller?.summary) ||
    cleanText(input.seller?.industry) ||
    null
  );
}

function buildSellerInboundFooter(
  displaySellerName: string | null,
  seller: BattleSellerProfileLike | null,
  site: BattleSellerSiteLike | null,
): string | null {
  const siteContact = asRecord(asRecord(site?.profile).contact);
  const website = normalizeWebsiteUrl(seller?.website);
  const publicContacts = Array.isArray(seller?.publicContacts) ? seller.publicContacts : [];

  const publicEmail = publicContacts
    .map((entry) => asRecord(entry))
    .find((entry) => cleanText(entry.type) === 'email' && EMAIL_RE.test(cleanText(entry.value)));
  const businessEmail = cleanText(seller?.businessEmail);
  const siteEmail = (Array.isArray(siteContact.publicEmails) ? siteContact.publicEmails : [])
    .map(cleanText)
    .find((value) => EMAIL_RE.test(value));
  const email =
    (publicEmail ? cleanText(publicEmail.value) : '') ||
    (EMAIL_RE.test(businessEmail) ? businessEmail : '') ||
    siteEmail ||
    null;

  const siteWhatsapp = (Array.isArray(siteContact.whatsappNumbers) ? siteContact.whatsappNumbers : [])
    .map(cleanText)
    .find((value) => E164_RE.test(value));
  const publicWhatsapp = publicContacts
    .map((entry) => asRecord(entry))
    .find((entry) => cleanText(entry.type) === 'whatsapp' && E164_RE.test(cleanText(entry.value)));
  const waE164 = siteWhatsapp || (publicWhatsapp ? cleanText(publicWhatsapp.value) : '');
  const waUrl = waE164 ? `https://wa.me/${waE164.slice(1)}` : null;

  const channels = [website, email, waUrl].filter(Boolean);
  if (channels.length === 0) return null;
  return [displaySellerName, ...channels].filter(Boolean).join(' | ');
}

/** 纯函数：从卖方档案、建站档案、产品、Claim 与 ICP 价值主张组装外语卖方上下文。 */
export function resolveBattleSellerContext(input: {
  readonly seller: BattleSellerProfileLike | null;
  readonly site?: BattleSellerSiteLike | null;
  readonly offerings?: readonly BattleSellerOfferingLike[];
  readonly claims?: readonly BattleSellerClaimLike[];
  readonly icpValueProps?: unknown;
}): BattleSellerContext {
  const sellerName = pickForeignSellerName(input.seller, input.site ?? null);
  const sellerProductSummary = pickForeignProductSummary({
    seller: input.seller,
    offerings: input.offerings ?? [],
    claims: input.claims ?? [],
    icpValueProps: input.icpValueProps,
  });
  const sellerInboundFooter = buildSellerInboundFooter(sellerName, input.seller, input.site ?? null);
  return { sellerName, sellerProductSummary, sellerInboundFooter };
}

/** 从事务内一次批量读取卖方外语上下文（带 delegate 守卫兼容旧单测 stub）。 */
export async function loadBattleSellerContext(
  tx: Prisma.TransactionClient,
  args: { readonly companyId?: string | null; readonly icpValueProps?: unknown },
): Promise<BattleSellerContext> {
  if (!args.companyId) {
    return { sellerName: null, sellerProductSummary: null, sellerInboundFooter: null };
  }
  const rawTx = tx as unknown as {
    companyProfile?: { findUnique?: (q: unknown) => Promise<BattleSellerProfileLike | null> };
    site?: { findFirst?: (q: unknown) => Promise<BattleSellerSiteLike | null> };
    offering?: { findMany?: (q: unknown) => Promise<BattleSellerOfferingLike[]> };
    claim?: { findMany?: (q: unknown) => Promise<BattleSellerClaimLike[]> };
  };

  const seller =
    typeof rawTx.companyProfile?.findUnique === 'function'
      ? await rawTx.companyProfile.findUnique({
          where: { id: args.companyId },
          select: {
            name: true,
            website: true,
            summary: true,
            industry: true,
            businessEmail: true,
            publicContacts: true,
          },
        })
      : null;

  const site =
    typeof rawTx.site?.findFirst === 'function'
      ? await rawTx.site.findFirst({
          where: { companyProfileId: args.companyId },
          select: { name: true, profile: true },
          orderBy: { updatedAt: 'desc' },
        })
      : null;

  const offerings =
    typeof rawTx.offering?.findMany === 'function'
      ? await rawTx.offering.findMany({
          where: { companyId: args.companyId },
          select: { name: true, description: true, attributes: true },
          orderBy: { createdAt: 'asc' },
          take: 8,
        })
      : [];

  const claims =
    typeof rawTx.claim?.findMany === 'function'
      ? await rawTx.claim.findMany({
          where: { companyId: args.companyId, status: { in: ['APPROVED', 'EXTRACTED'] } },
          select: { type: true, statement: true, status: true },
          orderBy: { createdAt: 'asc' },
          take: 20,
        })
      : [];

  return resolveBattleSellerContext({
    seller,
    site,
    offerings,
    claims,
    icpValueProps: args.icpValueProps,
  });
}
