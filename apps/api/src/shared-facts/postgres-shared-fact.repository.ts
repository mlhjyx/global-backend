import {
  assertGreenCompanyFactClean,
  isGreenCompanyFactExpired,
  type GreenCompanyFact,
  type GreenFactSourceKind,
  type ObjectiveTradeRole,
} from './green-company-fact';
import type { SharedFactRepository } from './shared-green-fact.store';
import type {
  CooldownWindowSnapshot,
  DomainCooldownBackend,
} from './domain-cooldown.service';

export interface PlatformSharedSqlClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

interface CompanyFactRow {
  domain: string;
  schema_version: string;
  homepage_url: string;
  legal_name: string | null;
  country: string | null;
  trade_role: string;
  website_summary: string | null;
  role_emails: unknown;
  switchboard_phones: unknown;
  inquiry_form_url: string | null;
  contact_page_url: string | null;
  impressum_url: string | null;
  linkedin_company_url: string | null;
  product_categories: unknown;
  source_kind: string;
  observed_at: Date | string;
  expires_at: Date | string;
  ttl_days: number;
}

const HMAC_HEX_RE = /^[0-9a-f]{64}$/u;
const COOLDOWN_KEY_HMAC_RE = /([0-9a-f]{64})\}?$/u;

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function extractDomainHmac(key: string): string {
  const match = key.match(COOLDOWN_KEY_HMAC_RE);
  if (!match || !match[1] || !HMAC_HEX_RE.test(match[1])) {
    throw new Error('ADR003_COOLDOWN_DOMAIN_HMAC_INVALID');
  }
  return match[1];
}

function assertMemberHmac(member: string): string {
  if (!HMAC_HEX_RE.test(member)) {
    throw new Error('ADR003_COOLDOWN_MEMBER_HMAC_INVALID');
  }
  return member;
}

/**
 * ADR-003 physical `platform_shared.company_fact` repository.
 * Enforces reader/writer role separation:
 * - `reader` runs under `app_user` (strictly `SELECT`-only on `platform_shared`).
 * - `writer` runs under `platform_writer` (optional; absence fails closed on write).
 */
export class PostgresSharedFactRepository implements SharedFactRepository {
  constructor(
    private readonly reader: PlatformSharedSqlClient,
    private readonly writer?: PlatformSharedSqlClient,
  ) {}

  private requireWriter(): PlatformSharedSqlClient {
    if (!this.writer) {
      throw new Error('ADR003_PLATFORM_WRITER_REQUIRED');
    }
    return this.writer;
  }

  async getByDomain(normalizedDomain: string, nowMs = Date.now()): Promise<GreenCompanyFact | null> {
    const rows = await this.reader.$queryRaw<CompanyFactRow[]>`
      SELECT domain, schema_version, homepage_url, legal_name, country, trade_role,
             website_summary, role_emails, switchboard_phones, inquiry_form_url,
             contact_page_url, impressum_url, linkedin_company_url, product_categories,
             source_kind, observed_at, expires_at, ttl_days
      FROM platform_shared.company_fact
      WHERE domain = ${normalizedDomain}
        AND expires_at > ${new Date(nowMs)}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    const fact: GreenCompanyFact = {
      schemaVersion: row.schema_version as GreenCompanyFact['schemaVersion'],
      domain: row.domain,
      homepageUrl: row.homepage_url,
      legalName: row.legal_name,
      country: row.country ? row.country.trim() : null,
      tradeRole: row.trade_role as ObjectiveTradeRole,
      websiteSummary: row.website_summary,
      roleEmails: toStringArray(row.role_emails),
      switchboardPhones: toStringArray(row.switchboard_phones),
      inquiryFormUrl: row.inquiry_form_url,
      contactPageUrl: row.contact_page_url,
      impressumUrl: row.impressum_url,
      linkedinCompanyUrl: row.linkedin_company_url,
      productCategories: toStringArray(row.product_categories),
      sourceKind: row.source_kind as GreenFactSourceKind,
      observedAt: toIsoString(row.observed_at),
      expiresAt: toIsoString(row.expires_at),
      ttlDays: Number(row.ttl_days),
    };
    assertGreenCompanyFactClean(fact);
    return isGreenCompanyFactExpired(fact, nowMs) ? null : fact;
  }

  async upsert(fact: GreenCompanyFact): Promise<void> {
    assertGreenCompanyFactClean(fact);
    const writer = this.requireWriter();
    await writer.$executeRaw`
      INSERT INTO platform_shared.company_fact (
        domain, schema_version, homepage_url, legal_name, country, trade_role,
        website_summary, role_emails, switchboard_phones, inquiry_form_url,
        contact_page_url, impressum_url, linkedin_company_url, product_categories,
        source_kind, observed_at, expires_at, ttl_days, updated_at
      )
      VALUES (
        ${fact.domain},
        ${fact.schemaVersion},
        ${fact.homepageUrl},
        ${fact.legalName},
        ${fact.country},
        ${fact.tradeRole},
        ${fact.websiteSummary},
        ${JSON.stringify(fact.roleEmails)}::jsonb,
        ${JSON.stringify(fact.switchboardPhones)}::jsonb,
        ${fact.inquiryFormUrl},
        ${fact.contactPageUrl},
        ${fact.impressumUrl},
        ${fact.linkedinCompanyUrl},
        ${JSON.stringify(fact.productCategories)}::jsonb,
        ${fact.sourceKind},
        ${new Date(fact.observedAt)},
        ${new Date(fact.expiresAt)},
        ${fact.ttlDays},
        now()
      )
      ON CONFLICT (domain) DO UPDATE SET
        schema_version = EXCLUDED.schema_version,
        homepage_url = EXCLUDED.homepage_url,
        legal_name = EXCLUDED.legal_name,
        country = EXCLUDED.country,
        trade_role = EXCLUDED.trade_role,
        website_summary = EXCLUDED.website_summary,
        role_emails = EXCLUDED.role_emails,
        switchboard_phones = EXCLUDED.switchboard_phones,
        inquiry_form_url = EXCLUDED.inquiry_form_url,
        contact_page_url = EXCLUDED.contact_page_url,
        impressum_url = EXCLUDED.impressum_url,
        linkedin_company_url = EXCLUDED.linkedin_company_url,
        product_categories = EXCLUDED.product_categories,
        source_kind = EXCLUDED.source_kind,
        observed_at = EXCLUDED.observed_at,
        expires_at = EXCLUDED.expires_at,
        ttl_days = EXCLUDED.ttl_days,
        updated_at = now()
    `;
  }

  async deleteByDomain(normalizedDomain: string): Promise<boolean> {
    const writer = this.requireWriter();
    const removed = await writer.$executeRaw`
      DELETE FROM platform_shared.company_fact
      WHERE domain = ${normalizedDomain}
    `;
    return removed > 0;
  }
}

/**
 * ADR-003 physical `platform_shared.domain_cooldown_touch` backend.
 * Stores strictly 64-hex HMAC-SHA256 digests (`domain_hmac`, `workspace_touch_hmac`).
 */
export class PostgresDomainCooldownBackend implements DomainCooldownBackend {
  constructor(
    private readonly reader: PlatformSharedSqlClient,
    private readonly writer?: PlatformSharedSqlClient,
  ) {}

  private async inspectWindow(
    domainHmac: string,
    windowStartMs: number,
    threshold: number,
  ): Promise<CooldownWindowSnapshot> {
    const rows = await this.reader.$queryRaw<Array<{ touched_at: Date | string }>>`
      SELECT touched_at
      FROM platform_shared.domain_cooldown_touch
      WHERE domain_hmac = ${domainHmac}
        AND touched_at > ${new Date(windowStartMs)}
      ORDER BY touched_at ASC
    `;
    const count = rows.length;
    if (count < threshold) {
      return { count, pivotTimestampMs: null };
    }
    const pivotIndex = Math.max(0, count - threshold);
    const pivot = rows[pivotIndex]?.touched_at;
    const pivotMs = pivot ? new Date(pivot).getTime() : null;
    return {
      count,
      pivotTimestampMs: pivotMs !== null && Number.isFinite(pivotMs) ? pivotMs : null,
    };
  }

  async pruneAndInspect(
    key: string,
    windowStartMs: number,
    threshold: number,
  ): Promise<CooldownWindowSnapshot> {
    const domainHmac = extractDomainHmac(key);
    if (this.writer) {
      await this.writer.$executeRaw`
        DELETE FROM platform_shared.domain_cooldown_touch
        WHERE domain_hmac = ${domainHmac}
          AND touched_at <= ${new Date(windowStartMs)}
      `;
    }
    return this.inspectWindow(domainHmac, windowStartMs, threshold);
  }

  async recordAndInspect(
    key: string,
    member: string,
    nowMs: number,
    windowMs: number,
    threshold: number,
  ): Promise<CooldownWindowSnapshot> {
    if (!this.writer) {
      throw new Error('ADR003_PLATFORM_WRITER_REQUIRED');
    }
    const domainHmac = extractDomainHmac(key);
    const touchHmac = assertMemberHmac(member);
    const windowStartMs = nowMs - windowMs;
    const touchedAt = new Date(nowMs);
    const expiresAt = new Date(nowMs + windowMs);

    await this.writer.$executeRaw`
      DELETE FROM platform_shared.domain_cooldown_touch
      WHERE domain_hmac = ${domainHmac}
        AND touched_at <= ${new Date(windowStartMs)}
    `;
    await this.writer.$executeRaw`
      INSERT INTO platform_shared.domain_cooldown_touch (
        domain_hmac, workspace_touch_hmac, touched_at, expires_at
      )
      VALUES (${domainHmac}, ${touchHmac}, ${touchedAt}, ${expiresAt})
      ON CONFLICT (domain_hmac, workspace_touch_hmac)
      DO UPDATE SET touched_at = EXCLUDED.touched_at, expires_at = EXCLUDED.expires_at
    `;
    return this.inspectWindow(domainHmac, windowStartMs, threshold);
  }
}
