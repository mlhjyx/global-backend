import { describe, expect, it } from 'vitest';
import {
  assertGreenCompanyFactClean,
  GREEN_COMPANY_FACT_SCHEMA_VERSION,
  isGreenCompanyFactExpired,
  isStrictRoleEmail,
  normalizeCompanyDomain,
  sanitizeLinkedinCompanyUrl,
  sanitizeToGreenCompanyFact,
} from './green-company-fact';

describe('ADR-003 Layer 1 green-company-fact model & sanitizer', () => {
  it('normalizes corporate domains and rejects IPs, localhost, and free webmail', () => {
    expect(normalizeCompanyDomain('https://www.Memodo.DE/products?a=1')).toBe('memodo.de');
    expect(normalizeCompanyDomain('SOLARE-ITALIA.IT')).toBe('solare-italia.it');
    expect(normalizeCompanyDomain('192.168.1.10')).toBeNull();
    expect(normalizeCompanyDomain('localhost')).toBeNull();
    expect(normalizeCompanyDomain('gmail.com')).toBeNull();
    expect(normalizeCompanyDomain('user:pass@memodo.de')).toBeNull();
  });

  it('allows strict functional role emails and rejects personal / off-domain / free-webmail emails', () => {
    expect(isStrictRoleEmail('sales@memodo.de', 'memodo.de')).toBe(true);
    expect(isStrictRoleEmail('export.eu@memodo.de', 'memodo.de')).toBe(true);
    expect(isStrictRoleEmail('einkauf@shop.memodo.de', 'memodo.de')).toBe(true);
    expect(isStrictRoleEmail('info-de@memodo.de', 'memodo.de')).toBe(true);

    // Personal emails must be rejected
    expect(isStrictRoleEmail('john.doe@memodo.de', 'memodo.de')).toBe(false);
    expect(isStrictRoleEmail('sales.john@memodo.de', 'memodo.de')).toBe(false);
    expect(isStrictRoleEmail('m.mueller@memodo.de', 'memodo.de')).toBe(false);
    expect(isStrictRoleEmail('maria@memodo.de', 'memodo.de')).toBe(false);

    // Off-domain & free webmail must be rejected
    expect(isStrictRoleEmail('sales@gmail.com', 'memodo.de')).toBe(false);
    expect(isStrictRoleEmail('info@other-agency.de', 'memodo.de')).toBe(false);
  });

  it('keeps only LinkedIn /company/ URLs and strips /in/ personal profiles and query tokens', () => {
    expect(
      sanitizeLinkedinCompanyUrl('https://de.linkedin.com/company/memodo-gmbh/about/?trk=abc'),
    ).toBe('https://www.linkedin.com/company/memodo-gmbh');
    expect(sanitizeLinkedinCompanyUrl('https://www.linkedin.com/in/max-mustermann')).toBeNull();
    expect(sanitizeLinkedinCompanyUrl('https://www.linkedin.com/pub/max-mustermann/1/2/3')).toBeNull();
    expect(sanitizeLinkedinCompanyUrl('https://evil-linkedin.com/company/memodo')).toBeNull();
    expect(sanitizeLinkedinCompanyUrl('javascript:alert(1)')).toBeNull();
  });

  it('hard-blocks imported_buyer and tenant-private provenance from entering Layer 1', () => {
    const byFlag = sanitizeToGreenCompanyFact({
      domain: 'private-buyer.de',
      legalName: 'Private Buyer GmbH',
      isImportedBuyer: true,
    });
    expect(byFlag.accepted).toBe(false);
    if (!byFlag.accepted) expect(byFlag.reason).toBe('IMPORTED_BUYER_FORBIDDEN');

    const bySource = sanitizeToGreenCompanyFact({
      domain: 'private-buyer.de',
      legalName: 'Private Buyer GmbH',
      sourceKind: 'imported_buyer',
    });
    expect(bySource.accepted).toBe(false);
    if (!bySource.accepted) expect(bySource.reason).toBe('IMPORTED_BUYER_FORBIDDEN');

    const byExternalRef = sanitizeToGreenCompanyFact({
      domain: 'private-buyer.de',
      legalName: 'Private Buyer GmbH',
      channelExternalRefs: ['import:batch-123:4'],
    });
    expect(byExternalRef.accepted).toBe(false);
    if (!byExternalRef.accepted) expect(byExternalRef.reason).toBe('IMPORTED_BUYER_FORBIDDEN');

    const byAttrs = sanitizeToGreenCompanyFact({
      domain: 'private-buyer.de',
      legalName: 'Private Buyer GmbH',
      companyAttributes: { origin: 'imported_buyer' },
    });
    expect(byAttrs.accepted).toBe(false);
    if (!byAttrs.accepted) expect(byAttrs.reason).toBe('IMPORTED_BUYER_FORBIDDEN');
  });

  it('strips natural-person PII, workspaceId, and raw page text while preserving green company facts', () => {
    const now = new Date('2026-11-26T00:00:00.000Z');
    const result = sanitizeToGreenCompanyFact(
      {
        workspaceId: '10000000-0000-4000-8000-000000000001',
        companyId: '50000000-0000-4000-8000-000000000005',
        contactName: 'Hans Mueller',
        rawHtml: '<html>secret</html>',
        domain: 'https://www.memodo.de',
        legalName: 'Memodo GmbH',
        country: 'de',
        tradeRole: 'distributor',
        metaDescription:
          'Wholesale distributor of PV modules and storage. Reach hans.mueller@memodo.de or https://linkedin.com/in/hans-mueller for quotes.',
        emails: [
          'sales@memodo.de',
          'hans.mueller@memodo.de',
          'procurement.eu@memodo.de',
          'sales@gmail.com',
        ],
        phones: ['+49 89 90410150', '123'],
        inquiryFormUrl: 'https://www.memodo.de/kontakt?utm_source=x',
        socialLinks: [
          'https://www.linkedin.com/in/hans-mueller',
          'https://www.linkedin.com/company/memodo-gmbh/',
        ],
        productCategories: ['Photovoltaic Modules', 'Battery Storage'],
        sourceKind: 'public_web_streaming',
      },
      { now, ttlDays: 25 },
    );

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;

    expect(result.strippedPiiCount).toBeGreaterThanOrEqual(7);
    expect(result.fact).toEqual({
      schemaVersion: GREEN_COMPANY_FACT_SCHEMA_VERSION,
      domain: 'memodo.de',
      homepageUrl: 'https://memodo.de/',
      legalName: 'Memodo GmbH',
      country: 'DE',
      tradeRole: 'distributor',
      websiteSummary:
        'Wholesale distributor of PV modules and storage. Reach or for quotes.',
      roleEmails: ['sales@memodo.de', 'procurement.eu@memodo.de'],
      switchboardPhones: ['+498990410150'],
      inquiryFormUrl: 'https://www.memodo.de/kontakt',
      contactPageUrl: null,
      impressumUrl: null,
      linkedinCompanyUrl: 'https://www.linkedin.com/company/memodo-gmbh',
      productCategories: ['Photovoltaic Modules', 'Battery Storage'],
      sourceKind: 'public_web_streaming',
      observedAt: '2026-11-26T00:00:00.000Z',
      expiresAt: '2026-12-21T00:00:00.000Z',
      ttlDays: 25,
    });

    // Zero tenant leakage in serialized payload
    const serialized = JSON.stringify(result.fact);
    expect(serialized).not.toContain('workspaceId');
    expect(serialized).not.toContain('10000000-0000-4000-8000-000000000001');
    expect(serialized).not.toContain('hans.mueller');
    expect(serialized).not.toContain('/in/');
    expect(() => assertGreenCompanyFactClean(result.fact)).not.toThrow();
    expect(isGreenCompanyFactExpired(result.fact, Date.parse('2026-12-10T00:00:00.000Z'))).toBe(false);
    expect(isGreenCompanyFactExpired(result.fact, Date.parse('2026-12-22T00:00:00.000Z'))).toBe(true);
  });

  it('clamps TTL to 14-30 days and throws in assertGreenCompanyFactClean on tampered payloads', () => {
    const clampedLow = sanitizeToGreenCompanyFact(
      { domain: 'acme-solar.it', legalName: 'Acme Solar' },
      { ttlDays: 2 },
    );
    expect(clampedLow.accepted && clampedLow.fact.ttlDays).toBe(14);

    const clampedHigh = sanitizeToGreenCompanyFact(
      { domain: 'acme-solar.it', legalName: 'Acme Solar' },
      { ttlDays: 90 },
    );
    expect(clampedHigh.accepted && clampedHigh.fact.ttlDays).toBe(30);

    if (!clampedHigh.accepted) return;
    expect(() =>
      assertGreenCompanyFactClean({ ...clampedHigh.fact, workspaceId: 'ws-leak' }),
    ).toThrow(/ADR003_FORBIDDEN_FIELD/);
    expect(() =>
      assertGreenCompanyFactClean({
        ...clampedHigh.fact,
        roleEmails: ['john.smith@acme-solar.it'],
      }),
    ).toThrow(/ADR003_PERSONAL_OR_OFFDOMAIN_EMAIL_FORBIDDEN/);
    expect(() =>
      assertGreenCompanyFactClean({
        ...clampedHigh.fact,
        linkedinCompanyUrl: 'https://www.linkedin.com/in/john-smith',
      }),
    ).toThrow(/ADR003_INVALID_LINKEDIN_COMPANY_URL/);
  });
});
