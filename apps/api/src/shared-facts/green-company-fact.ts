/**
 * ADR-003 Layer 1: Platform Shared Green Company Facts (zero PII, zero tenant data).
 *
 * Hard compliance invariants:
 * - Strictly strips/blocks all natural-person PII (names, personal emails, LinkedIn /in/ profiles).
 * - Hard-blocks tenant-private / `imported_buyer` sources from ever entering Layer 1.
 * - Structurally forbids `workspaceId` / `companyId` / `leadId` / raw HTML / raw full-page text.
 * - Keeps only normalized corporate facts, strict departmental role emails, switchboard phones,
 *   inquiry form URL, company LinkedIn (/company/), derived factual summary, product categories,
 *   and a bounded 14-30 day TTL.
 */

export const GREEN_COMPANY_FACT_SCHEMA_VERSION = 'adr003-green-company-fact/v1' as const;
export const MIN_GREEN_FACT_TTL_DAYS = 14;
export const MAX_GREEN_FACT_TTL_DAYS = 30;
export const DEFAULT_GREEN_FACT_TTL_DAYS = 21;
export const MAX_WEBSITE_SUMMARY_CHARS = 400;

export const ALLOWED_GREEN_SOURCE_KINDS = [
  'public_web_streaming',
  'public_web',
  'public_registry',
  'public_directory',
] as const;
export type GreenFactSourceKind = (typeof ALLOWED_GREEN_SOURCE_KINDS)[number];

export const OBJECTIVE_TRADE_ROLES = [
  'distributor',
  'wholesaler',
  'importer',
  'installer_epc',
  'system_integrator',
  'retailer',
  'manufacturer',
  'oem',
  'service_provider',
  'unknown',
] as const;
export type ObjectiveTradeRole = (typeof OBJECTIVE_TRADE_ROLES)[number];

export interface GreenCompanyFact {
  readonly schemaVersion: typeof GREEN_COMPANY_FACT_SCHEMA_VERSION;
  readonly domain: string;
  readonly homepageUrl: string;
  readonly legalName: string | null;
  readonly country: string | null;
  readonly tradeRole: ObjectiveTradeRole;
  readonly websiteSummary: string | null;
  readonly roleEmails: readonly string[];
  readonly switchboardPhones: readonly string[];
  readonly inquiryFormUrl: string | null;
  readonly contactPageUrl: string | null;
  readonly impressumUrl: string | null;
  readonly linkedinCompanyUrl: string | null;
  readonly productCategories: readonly string[];
  readonly sourceKind: GreenFactSourceKind;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly ttlDays: number;
}

export interface SanitizeGreenCompanyFactInput {
  readonly domain: string | null | undefined;
  readonly homepageUrl?: string | null;
  readonly legalName?: string | null;
  readonly country?: string | null;
  readonly tradeRole?: string | null;
  readonly title?: string | null;
  readonly metaDescription?: string | null;
  readonly descriptionSnippets?: readonly string[];
  readonly websiteSummary?: string | null;
  readonly emails?: readonly string[];
  readonly phones?: readonly string[];
  readonly inquiryFormUrl?: string | null;
  readonly contactPageUrl?: string | null;
  readonly impressumUrl?: string | null;
  readonly socialLinks?: readonly string[];
  readonly linkedinCompanyUrl?: string | null;
  readonly productCategories?: readonly string[];
  readonly sourceKind?: string | null;
  readonly sourceProvider?: string | null;
  readonly isImportedBuyer?: boolean;
  readonly channelExternalRefs?: readonly string[];
  readonly companyAttributes?: Record<string, unknown> | null;
  /** Any accidental caller fields carrying PII or tenant IDs are structurally ignored & audited. */
  readonly [extraKey: string]: unknown;
}

export type GreenFactRejectReason =
  | 'IMPORTED_BUYER_FORBIDDEN'
  | 'INVALID_DOMAIN'
  | 'NON_GREEN_SOURCE'
  | 'INSUFFICIENT_GREEN_FACTS';

export type SanitizeGreenCompanyFactResult =
  | {
      readonly accepted: true;
      readonly fact: GreenCompanyFact;
      readonly strippedPiiCount: number;
      readonly strippedReasons: readonly string[];
    }
  | {
      readonly accepted: false;
      readonly reason: GreenFactRejectReason;
      readonly details: string;
    };

const ALLOWED_SOURCE_SET = new Set<string>(ALLOWED_GREEN_SOURCE_KINDS);
const TRADE_ROLE_SET = new Set<string>(OBJECTIVE_TRADE_ROLES);

const FORBIDDEN_PRIVATE_SOURCES = new Set<string>([
  'imported_buyer',
  'imported-buyer',
  'tenant_import',
  'tenant-import',
  'csv_import',
  'csv-import',
  'crm_import',
  'crm-import',
  'private_upload',
  'manual_import',
  'customer_list',
  'private_pool',
  'private_crm',
]);

const FORBIDDEN_TENANT_OR_PII_KEYS = new Set<string>([
  'workspaceid',
  'workspace_id',
  'tenantid',
  'tenant_id',
  'companyid',
  'company_id',
  'leadid',
  'lead_id',
  'runid',
  'run_id',
  'icpid',
  'icp_id',
  'ownerid',
  'owner_id',
  'userid',
  'user_id',
  'importedbuyerid',
  'imported_buyer_id',
  'contactname',
  'contact_name',
  'personname',
  'person_name',
  'firstname',
  'lastname',
  'personalemail',
  'personal_email',
  'personallinkedin',
  'personal_linkedin',
  'otheremails',
  'other_emails',
  'rawhtml',
  'raw_html',
  'rawpagetext',
  'raw_page_text',
  'visibletext',
  'visible_text',
]);

const FREE_WEBMAIL_DOMAINS = new Set<string>([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.de',
  'yahoo.fr',
  'yahoo.it',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  't-online.de',
  'qq.com',
  '163.com',
  '126.com',
  'foxmail.com',
  'sina.com',
  'yandex.ru',
  'mail.ru',
]);

const STRICT_ROLE_PREFIXES = new Set<string>([
  'info',
  'sales',
  'contact',
  'export',
  'import',
  'procurement',
  'purchasing',
  'buyer',
  'buying',
  'commercial',
  'commerciale',
  'vendite',
  'vertrieb',
  'einkauf',
  'anfrage',
  'kontakt',
  'office',
  'hello',
  'b2b',
  'wholesale',
  'distribution',
  'distribuzione',
  'grosshandel',
  'partner',
  'partners',
  'support',
  'service',
  'enquiries',
  'inquiries',
  'inquiry',
  'rfq',
  'tender',
  'orders',
  'order',
  'mail',
  'trade',
  'marketing',
  'admin',
  'general',
  'help',
  'billing',
  'accounts',
  'logistics',
  'supply',
  'sourcing',
  'press',
  'media',
  'legal',
  'compliance',
  'privacy',
  'impressum',
  'datenschutz',
]);

const ALLOWED_ROLE_SUFFIXES = new Set<string>([
  'de',
  'eu',
  'us',
  'uk',
  'it',
  'fr',
  'es',
  'nl',
  'at',
  'ch',
  'pl',
  'se',
  'no',
  'dk',
  'be',
  'jp',
  'cn',
  'au',
  'ca',
  'br',
  'mx',
  'apac',
  'emea',
  'dach',
  'na',
  'latam',
  'intl',
  'global',
  'b2b',
  'team',
  'dept',
  'desk',
  'hq',
  'office',
  'sales',
  'export',
  'support',
  'service',
  'wholesale',
  'orders',
  'inquiry',
  'info',
]);

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const EMAIL_TOKEN_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const EMAIL_TOKEN_TEST_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u;
const PERSONAL_LINKEDIN_TOKEN_RE = /https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/(?:in|pub)\/[^\s,;)]+/giu;
const PERSONAL_LINKEDIN_TEST_RE = /https?:\/\/(?:[a-z0-9-]+\.)?linkedin\.com\/(?:in|pub)\/[^\s,;)]+/iu;
const COUNTRY_CODE_RE = /^[A-Z]{2}$/u;
const NUMERIC_SUFFIX_RE = /^\d{1,2}$/u;
const LINKEDIN_COMPANY_SEGMENT_RE = /^\/company\/([a-z0-9][a-z0-9._-]{0,120})(?:\/.*)?$/iu;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function hostMatchesDomain(hostname: string, normalizedDomain: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === normalizedDomain || lower.endsWith(`.${normalizedDomain}`);
}

export function normalizeCompanyDomain(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 253 || trimmed.includes('@') || /\s/u.test(trimmed)) {
    return null;
  }
  const withScheme = /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./u, '').replace(/\.$/u, '');
  if (!host || !host.includes('.') || host === 'localhost' || host.endsWith('.local')) return null;
  if (IPV4_RE.test(host) || host.includes(':')) return null;
  if (FREE_WEBMAIL_DOMAINS.has(host)) return null;

  const labels = host.split('.');
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1]!;
  if (tld.length < 2 || !/^[a-z]{2,24}$/u.test(tld)) return null;
  if (!labels.every((label) => DOMAIN_LABEL_RE.test(label))) return null;
  return host;
}

export function isStrictRoleEmail(rawEmail: string, companyDomain?: string): boolean {
  if (typeof rawEmail !== 'string') return false;
  const cleaned = rawEmail.trim().toLowerCase();
  const at = cleaned.indexOf('@');
  if (at <= 0 || at !== cleaned.lastIndexOf('@')) return false;
  const local = cleaned.slice(0, at);
  const host = cleaned.slice(at + 1);
  if (!local || !host || local.length > 64 || host.length > 253) return false;
  if (FREE_WEBMAIL_DOMAINS.has(host)) return false;
  if (!normalizeCompanyDomain(host)) return false;
  if (companyDomain && !hostMatchesDomain(host, companyDomain)) return false;

  if (STRICT_ROLE_PREFIXES.has(local)) return true;

  const parts = local.split(/[._+-]/u);
  if (parts.length !== 2) return false;
  const [prefix, suffix] = parts;
  if (!prefix || !suffix) return false;
  if (!STRICT_ROLE_PREFIXES.has(prefix)) return false;
  return ALLOWED_ROLE_SUFFIXES.has(suffix) || NUMERIC_SUFFIX_RE.test(suffix);
}

export function sanitizeLinkedinCompanyUrl(rawUrl: string | null | undefined): string | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;

  const host = parsed.hostname.toLowerCase();
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;

  const pathname = parsed.pathname;
  const lowerPath = pathname.toLowerCase();
  if (
    lowerPath.startsWith('/in/') ||
    lowerPath.startsWith('/pub/') ||
    lowerPath.includes('/people') ||
    lowerPath.includes('/posts/')
  ) {
    return null;
  }
  const match = pathname.match(LINKEDIN_COMPANY_SEGMENT_RE);
  if (!match || !match[1]) return null;
  return `https://www.linkedin.com/company/${match[1].toLowerCase()}`;
}

export function sanitizeCompanySiteUrl(
  rawUrl: string | null | undefined,
  companyDomain: string,
): string | null {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (!hostMatchesDomain(parsed.hostname, companyDomain)) return null;
  const pathname = parsed.pathname.replace(/\/+$/u, '') || '/';
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${pathname}`;
}

function scrubFactualText(
  raw: string | null | undefined,
  maxChars: number,
): { text: string | null; strippedPii: number } {
  if (typeof raw !== 'string') return { text: null, strippedPii: 0 };
  let strippedPii = 0;
  let cleaned = raw.replace(/<[^>]+>/gu, ' ');
  cleaned = cleaned.replace(EMAIL_TOKEN_RE, () => {
    strippedPii += 1;
    return ' ';
  });
  cleaned = cleaned.replace(PERSONAL_LINKEDIN_TOKEN_RE, () => {
    strippedPii += 1;
    return ' ';
  });
  cleaned = cleaned.replace(/\s+/gu, ' ').trim();
  if (!cleaned) return { text: null, strippedPii };
  return { text: cleaned.slice(0, maxChars).trim(), strippedPii };
}

function sanitizeSwitchboardPhones(rawPhones: readonly string[] | undefined): string[] {
  if (!Array.isArray(rawPhones)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawPhones) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.replace(/[^\d+]/gu, '');
    const digits = normalized.replace(/\D/gu, '');
    if (digits.length < 7 || digits.length > 20) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    out.push(normalized);
    if (out.length >= 3) break;
  }
  return out;
}

function sanitizeProductCategories(
  rawCategories: readonly string[] | undefined,
): { categories: string[]; strippedPii: number } {
  if (!Array.isArray(rawCategories)) return { categories: [], strippedPii: 0 };
  const out: string[] = [];
  const seen = new Set<string>();
  let strippedPii = 0;
  for (const raw of rawCategories) {
    const scrubbed = scrubFactualText(raw, 80);
    strippedPii += scrubbed.strippedPii;
    if (!scrubbed.text) continue;
    const key = scrubbed.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(scrubbed.text);
    if (out.length >= 12) break;
  }
  return { categories: out, strippedPii };
}

function normalizeCountry(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  return COUNTRY_CODE_RE.test(upper) ? upper : null;
}

function normalizeTradeRole(raw: string | null | undefined): ObjectiveTradeRole {
  if (typeof raw !== 'string') return 'unknown';
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/gu, '_');
  if (TRADE_ROLE_SET.has(normalized)) return normalized as ObjectiveTradeRole;
  if (normalized === 'epc' || normalized === 'epc_contractor' || normalized === 'installer') {
    return 'installer_epc';
  }
  return 'unknown';
}

function isPrivateTag(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const lower = value.trim().toLowerCase();
  if (!lower) return false;
  return (
    FORBIDDEN_PRIVATE_SOURCES.has(lower) ||
    lower.startsWith('import:') ||
    lower.startsWith('imported_') ||
    lower.startsWith('imported-')
  );
}

export function isForbiddenPrivateSource(input: SanitizeGreenCompanyFactInput): boolean {
  if (input.isImportedBuyer === true) return true;
  if (isPrivateTag(input.sourceKind) || isPrivateTag(input.sourceProvider)) return true;
  if (Array.isArray(input.channelExternalRefs)) {
    if (input.channelExternalRefs.some((ref) => isPrivateTag(ref))) return true;
  }
  if (input.companyAttributes && typeof input.companyAttributes === 'object') {
    const attrs = input.companyAttributes;
    if (attrs.imported_buyer === true || attrs.isImportedBuyer === true) return true;
    if (typeof attrs.importBatchId === 'string' && attrs.importBatchId.trim().length > 0) return true;
    if (isPrivateTag(attrs.source) || isPrivateTag(attrs.origin) || isPrivateTag(attrs.sourceKind)) {
      return true;
    }
  }
  return false;
}

function clampTtlDays(raw: number | undefined): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_GREEN_FACT_TTL_DAYS;
  return Math.min(MAX_GREEN_FACT_TTL_DAYS, Math.max(MIN_GREEN_FACT_TTL_DAYS, value));
}

function buildDerivedSummary(
  input: SanitizeGreenCompanyFactInput,
): { summary: string | null; strippedPii: number } {
  const parts: string[] = [];
  let strippedPii = 0;
  const candidates = [
    input.websiteSummary,
    input.metaDescription,
    ...(Array.isArray(input.descriptionSnippets) ? input.descriptionSnippets.slice(0, 2) : []),
    input.title,
  ];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const scrubbed = scrubFactualText(raw, MAX_WEBSITE_SUMMARY_CHARS);
    strippedPii += scrubbed.strippedPii;
    if (!scrubbed.text) continue;
    const key = scrubbed.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(scrubbed.text);
    if (parts.join(' · ').length >= MAX_WEBSITE_SUMMARY_CHARS) break;
  }
  if (parts.length === 0) return { summary: null, strippedPii };
  return { summary: parts.join(' · ').slice(0, MAX_WEBSITE_SUMMARY_CHARS).trim(), strippedPii };
}

function collectStrictRoleEmails(
  rawEmails: readonly string[] | undefined,
  domain: string,
): { roleEmails: string[]; strippedCount: number } {
  if (!Array.isArray(rawEmails)) return { roleEmails: [], strippedCount: 0 };
  const roleEmails: string[] = [];
  const seen = new Set<string>();
  let strippedCount = 0;
  for (const raw of rawEmails) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const normalized = raw.trim().toLowerCase();
    if (!isStrictRoleEmail(normalized, domain)) {
      strippedCount += 1;
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    roleEmails.push(normalized);
    if (roleEmails.length >= 10) break;
  }
  return { roleEmails, strippedCount };
}

function collectLinkedinCompanyUrl(
  input: SanitizeGreenCompanyFactInput,
): { linkedinCompanyUrl: string | null; strippedPersonalCount: number } {
  const candidates: string[] = [];
  if (typeof input.linkedinCompanyUrl === 'string') candidates.push(input.linkedinCompanyUrl);
  if (Array.isArray(input.socialLinks)) {
    for (const link of input.socialLinks) {
      if (typeof link === 'string') candidates.push(link);
    }
  }
  let linkedinCompanyUrl: string | null = null;
  let strippedPersonalCount = 0;
  for (const candidate of candidates) {
    const clean = sanitizeLinkedinCompanyUrl(candidate);
    if (clean) {
      linkedinCompanyUrl ??= clean;
      continue;
    }
    try {
      const parsed = new URL(candidate.trim());
      const host = parsed.hostname.toLowerCase();
      if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
        strippedPersonalCount += 1;
      }
    } catch {
      // Ignore malformed social link candidates.
    }
  }
  return { linkedinCompanyUrl, strippedPersonalCount };
}

function auditStrippedCallerKeys(input: SanitizeGreenCompanyFactInput): string[] {
  const reasons: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const lower = key.toLowerCase();
    if (FORBIDDEN_TENANT_OR_PII_KEYS.has(lower)) {
      reasons.push(`stripped_key:${key}`);
    }
  }
  return reasons;
}

export function sanitizeToGreenCompanyFact(
  input: SanitizeGreenCompanyFactInput,
  opts: { now?: Date; ttlDays?: number } = {},
): SanitizeGreenCompanyFactResult {
  if (isForbiddenPrivateSource(input)) {
    return {
      accepted: false,
      reason: 'IMPORTED_BUYER_FORBIDDEN',
      details: 'Tenant-private or imported_buyer records are prohibited in ADR-003 Layer 1.',
    };
  }

  const domain = normalizeCompanyDomain(input.domain);
  if (!domain) {
    return {
      accepted: false,
      reason: 'INVALID_DOMAIN',
      details: 'Domain is missing, malformed, IP-literal, or belongs to a free webmail provider.',
    };
  }

  const sourceKindRaw = (input.sourceKind ?? 'public_web_streaming').trim().toLowerCase();
  if (!ALLOWED_SOURCE_SET.has(sourceKindRaw)) {
    return {
      accepted: false,
      reason: 'NON_GREEN_SOURCE',
      details: `Source kind "${sourceKindRaw}" is not on the ADR-003 green public allowlist.`,
    };
  }

  const strippedReasons = auditStrippedCallerKeys(input);
  let strippedPiiCount = strippedReasons.length;

  const { roleEmails, strippedCount: strippedEmails } = collectStrictRoleEmails(input.emails, domain);
  if (strippedEmails > 0) {
    strippedPiiCount += strippedEmails;
    strippedReasons.push(`stripped_non_role_emails:${strippedEmails}`);
  }

  const { linkedinCompanyUrl, strippedPersonalCount } = collectLinkedinCompanyUrl(input);
  if (strippedPersonalCount > 0) {
    strippedPiiCount += strippedPersonalCount;
    strippedReasons.push(`stripped_personal_linkedin:${strippedPersonalCount}`);
  }

  const legalScrubbed = scrubFactualText(input.legalName ?? input.title, 160);
  const summaryResult = buildDerivedSummary(input);
  const categoriesResult = sanitizeProductCategories(input.productCategories);
  const textPii = legalScrubbed.strippedPii + summaryResult.strippedPii + categoriesResult.strippedPii;
  if (textPii > 0) {
    strippedPiiCount += textPii;
    strippedReasons.push(`scrubbed_inline_pii:${textPii}`);
  }

  const switchboardPhones = sanitizeSwitchboardPhones(input.phones);
  const homepageUrl = sanitizeCompanySiteUrl(input.homepageUrl, domain) ?? `https://${domain}/`;
  const inquiryFormUrl = sanitizeCompanySiteUrl(input.inquiryFormUrl, domain);
  const contactPageUrl = sanitizeCompanySiteUrl(input.contactPageUrl, domain);
  const impressumUrl = sanitizeCompanySiteUrl(input.impressumUrl, domain);

  const hasObjectiveSignal = Boolean(
    legalScrubbed.text ||
      summaryResult.summary ||
      roleEmails.length > 0 ||
      switchboardPhones.length > 0 ||
      inquiryFormUrl ||
      contactPageUrl ||
      linkedinCompanyUrl ||
      categoriesResult.categories.length > 0,
  );
  if (!hasObjectiveSignal) {
    return {
      accepted: false,
      reason: 'INSUFFICIENT_GREEN_FACTS',
      details: 'No objective corporate facts remained after PII stripping.',
    };
  }

  const now = opts.now ?? new Date();
  const ttlDays = clampTtlDays(opts.ttlDays);
  const observedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlDays * MS_PER_DAY).toISOString();

  const fact: GreenCompanyFact = {
    schemaVersion: GREEN_COMPANY_FACT_SCHEMA_VERSION,
    domain,
    homepageUrl,
    legalName: legalScrubbed.text,
    country: normalizeCountry(input.country),
    tradeRole: normalizeTradeRole(input.tradeRole),
    websiteSummary: summaryResult.summary,
    roleEmails,
    switchboardPhones,
    inquiryFormUrl,
    contactPageUrl,
    impressumUrl,
    linkedinCompanyUrl,
    productCategories: categoriesResult.categories,
    sourceKind: sourceKindRaw as GreenFactSourceKind,
    observedAt,
    expiresAt,
    ttlDays,
  };

  return {
    accepted: true,
    fact,
    strippedPiiCount,
    strippedReasons,
  };
}

function assertNoForbiddenKeys(value: unknown, path = 'root'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoForbiddenKeys(value[i], `${path}[${i}]`);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_TENANT_OR_PII_KEYS.has(key.toLowerCase())) {
      throw new Error(`ADR003_FORBIDDEN_FIELD:${path}.${key}`);
    }
    assertNoForbiddenKeys(nested, `${path}.${key}`);
  }
}

export function assertGreenCompanyFactClean(value: unknown): asserts value is GreenCompanyFact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ADR003_INVALID_FACT_OBJECT');
  }
  assertNoForbiddenKeys(value);
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== GREEN_COMPANY_FACT_SCHEMA_VERSION) {
    throw new Error('ADR003_INVALID_SCHEMA_VERSION');
  }
  const domain = normalizeCompanyDomain(record.domain as string);
  if (!domain || record.domain !== domain) {
    throw new Error('ADR003_INVALID_DOMAIN');
  }
  if (typeof record.sourceKind !== 'string' || !ALLOWED_SOURCE_SET.has(record.sourceKind)) {
    throw new Error('ADR003_INVALID_SOURCE_KIND');
  }
  if (!Array.isArray(record.roleEmails)) {
    throw new Error('ADR003_INVALID_ROLE_EMAILS');
  }
  for (const email of record.roleEmails) {
    if (typeof email !== 'string' || !isStrictRoleEmail(email, domain)) {
      throw new Error('ADR003_PERSONAL_OR_OFFDOMAIN_EMAIL_FORBIDDEN');
    }
  }
  if (record.linkedinCompanyUrl !== null) {
    if (
      typeof record.linkedinCompanyUrl !== 'string' ||
      sanitizeLinkedinCompanyUrl(record.linkedinCompanyUrl) !== record.linkedinCompanyUrl
    ) {
      throw new Error('ADR003_INVALID_LINKEDIN_COMPANY_URL');
    }
  }
  if (record.websiteSummary !== null) {
    if (typeof record.websiteSummary !== 'string' || record.websiteSummary.length > MAX_WEBSITE_SUMMARY_CHARS) {
      throw new Error('ADR003_INVALID_WEBSITE_SUMMARY');
    }
    if (EMAIL_TOKEN_TEST_RE.test(record.websiteSummary) || PERSONAL_LINKEDIN_TEST_RE.test(record.websiteSummary)) {
      throw new Error('ADR003_INLINE_PII_IN_SUMMARY');
    }
  }
  const ttl = Number(record.ttlDays);
  if (!Number.isInteger(ttl) || ttl < MIN_GREEN_FACT_TTL_DAYS || ttl > MAX_GREEN_FACT_TTL_DAYS) {
    throw new Error('ADR003_INVALID_TTL_DAYS');
  }
  if (typeof record.observedAt !== 'string' || typeof record.expiresAt !== 'string') {
    throw new Error('ADR003_INVALID_TIMESTAMPS');
  }
}

export function isGreenCompanyFactExpired(fact: GreenCompanyFact, nowMs = Date.now()): boolean {
  const expiresMs = Date.parse(fact.expiresAt);
  return !Number.isFinite(expiresMs) || expiresMs <= nowMs;
}
