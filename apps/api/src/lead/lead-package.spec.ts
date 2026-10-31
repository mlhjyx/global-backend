import { describe, expect, it } from 'vitest';
import { buildLeadPackage, type LeadPackageInput } from './lead-package';

/**
 * BI-19/BI-21/BI-15（交付闭环设计 §2）：LeadPackage 是按线索组装的只读交付读模型。
 * 只取 green/amber 公司级事实，不读 canonical_contact；缺失的事实留空，绝不猜。
 */
const base = (): LeadPackageInput => ({
  lead: {
    id: 'lead-1',
    status: 'QUALIFIED',
    queue: 'recommended',
    fitVerdict: 'match',
    fitReasons: {
      material: '贩售工业泵',
      role: '分销商',
      process: '无',
      business_model: '经销',
      reasons: ['在售 Grundfos 与 Leo 品牌', '官网有供应商入驻页'],
    },
    scores: {
      fit: 0.9,
      role: 0,
      intent: 0.4,
      demandProof: 0.2,
      dataQuality: 0.75,
      reachability: 1,
      engagement: 0.1,
    },
    scoreDetail: {
      ruleEvaluations: [{ kind: 'MUST_HAVE', outcome: 'fail' }],
      missingFields: ['employee_count'],
      reasonCodes: [],
    },
    totalScore: 0.82,
  },
  company: {
    id: 'company-1',
    name: 'Beispiel Pumpen GmbH',
    domain: 'beispiel-pumpen.de',
    country: 'DE',
    attributes: {
      website_profile: {
        trade_role: 'distributor',
        trade_role_confidence: 0.9,
        own_manufacturing: false,
        carried_brands: [
          { name: 'Grundfos', country: 'DK' },
          { name: 'Leo', country: 'CN' },
        ],
        carries_chinese_brand: true,
        carries_foreign_brand: true,
        register_key: 'de-hrb:muenchen:12345',
        vat_id: 'DE136695976',
        registered_address: 'Musterstraße 1, 12345 Musterstadt',
        source_url: 'https://beispiel-pumpen.de/impressum',
        _ts: '2026-10-20T00:00:00.000Z',
      },
      gleif: { lei: '529900T8BM49AURSDO55', registered_city: 'München' },
      fda: { registration_number: '1234567890' },
      intent: {
        events: [
          { type: 'TENDER_PUBLISHED', at: '2026-10-01T00:00:00.000Z', strength: 0.9, page_url: 'https://ted.europa.eu/notice/1' },
          { type: 'SOURCING_OPENED', at: '2026-10-10T00:00:00.000Z', strength: 0.7, page_url: 'http://insecure.example/page' },
          { type: 'WEBSITE_CHANGE', at: '2026-09-01T00:00:00.000Z', strength: 0.2 },
          { type: 'TENDER_PUBLISHED', at: '2026-08-01T00:00:00.000Z', strength: 0.5, page_url: 'https://ted.europa.eu/notice/4' },
        ],
      },
    },
  },
  contactPoints: [
    { kind: 'contact_page', value: 'https://beispiel-pumpen.de/kontakt', status: 'UNVERIFIED' },
    { kind: 'supplier_page', value: 'https://beispiel-pumpen.de/lieferanten', status: 'UNVERIFIED' },
    { kind: 'impressum_page', value: 'https://beispiel-pumpen.de/impressum', status: 'UNVERIFIED' },
    { kind: 'linkedin_company_page', value: 'https://www.linkedin.com/company/beispiel', status: 'UNVERIFIED' },
  ],
  evidence: [
    { field: 'website_profile.trade_role', sourceUrl: 'https://beispiel-pumpen.de/impressum', fetchedAt: new Date('2026-10-20T00:00:00.000Z') },
    { field: 'website_profile.register_key', sourceUrl: 'https://beispiel-pumpen.de/impressum', fetchedAt: new Date('2026-10-20T00:00:00.000Z') },
    { field: 'gleif.lei', sourceUrl: 'https://api.gleif.org/lei/1', fetchedAt: new Date('2026-10-18T00:00:00.000Z') },
    { field: 'fda.registration_number', sourceUrl: null, fetchedAt: new Date('2026-10-17T00:00:00.000Z') },
  ],
  sanctions: { status: 'clear', screened_at: '2026-10-19T00:00:00.000Z' },
  validUntil: '2026-11-19T00:00:00.000Z',
});

describe('buildLeadPackage', () => {
  it('assembles the design read model from company facts, scores and paths', () => {
    const pkg = buildLeadPackage(base());
    expect(pkg).toMatchObject({
      lead_id: 'lead-1',
      status: 'QUALIFIED',
      company: {
        canonical_company_id: 'company-1',
        name: 'Beispiel Pumpen GmbH',
        domain: 'beispiel-pumpen.de',
        country: 'DE',
        city: 'München',
      },
      company_profile: {
        trade_role: 'distributor',
        trade_role_confidence: 0.9,
        own_manufacturing: false,
        carried_brands: [
          { name: 'Grundfos', country: 'DK' },
          { name: 'Leo', country: 'CN' },
        ],
        carries_chinese_brand: true,
        carries_foreign_brand: true,
      },
      registered_address: 'Musterstraße 1, 12345 Musterstadt',
      identifiers: {
        register_key: 'de-hrb:muenchen:12345',
        vat_id: 'DE136695976',
        lei: '529900T8BM49AURSDO55',
        fda_reg: '1234567890',
      },
      scores: {
        fit: 0.9,
        role: 0,
        intent: 0.4,
        demand_proof: 0.2,
        reachability: 1,
        data_quality: 0.75,
        engagement: 0.1,
        total: 0.82,
      },
      fit: {
        verdict: 'match',
        reason_codes: ['FIT_MATCH', 'RULE_MUST_HAVE_FAIL', 'MISSING_EMPLOYEE_COUNT'],
        reasons: ['在售 Grundfos 与 Leo 品牌', '官网有供应商入驻页'],
      },
      sanctions: { status: 'clear', screened_at: '2026-10-19T00:00:00.000Z' },
      valid_until: '2026-11-19T00:00:00.000Z',
    });
  });

  it('lists only valid https contact paths in design priority order, with the suggested path', () => {
    const pkg = buildLeadPackage(base());
    expect(pkg.contact_points).toEqual([
      { kind: 'supplier_page', url: 'https://beispiel-pumpen.de/lieferanten', status: 'UNVERIFIED' },
      { kind: 'contact_page', url: 'https://beispiel-pumpen.de/kontakt', status: 'UNVERIFIED' },
      { kind: 'impressum_page', url: 'https://beispiel-pumpen.de/impressum', status: 'UNVERIFIED' },
      { kind: 'linkedin_company_page', url: 'https://www.linkedin.com/company/beispiel', status: 'UNVERIFIED' },
    ]);
    expect(pkg.suggested_contact_path).toMatchObject({ kind: 'supplier_page' });

    const withInvalid = base();
    const pkg2 = buildLeadPackage({
      ...withInvalid,
      contactPoints: [
        ...withInvalid.contactPoints,
        { kind: 'contact_form', value: 'https://beispiel-pumpen.de/form', status: 'INVALID' },
      ],
    });
    expect(pkg2.contact_points.map((point) => point.kind)).not.toContain('contact_form');
    expect(pkg2.suggested_contact_path?.kind).toBe('supplier_page');
  });

  it('keeps the newest three signals with their dates and only https links', () => {
    const pkg = buildLeadPackage(base());
    expect(pkg.signals).toEqual([
      { type: 'SOURCING_OPENED', at: '2026-10-10T00:00:00.000Z', url: null },
      { type: 'TENDER_PUBLISHED', at: '2026-10-01T00:00:00.000Z', url: 'https://ted.europa.eu/notice/1' },
      { type: 'WEBSITE_CHANGE', at: '2026-09-01T00:00:00.000Z', url: null },
    ]);
  });

  it('lists evidence URLs newest first, deduplicated, and drops rows without a source URL', () => {
    const pkg = buildLeadPackage(base());
    expect(pkg.evidence).toEqual([
      { field: 'website_profile.trade_role', source_url: 'https://beispiel-pumpen.de/impressum', fetched_at: '2026-10-20T00:00:00.000Z' },
      { field: 'website_profile.register_key', source_url: 'https://beispiel-pumpen.de/impressum', fetched_at: '2026-10-20T00:00:00.000Z' },
      { field: 'gleif.lei', source_url: 'https://api.gleif.org/lei/1', fetched_at: '2026-10-18T00:00:00.000Z' },
    ]);
  });

  it('falls back to the website profile source URL for website_profile evidence without one', () => {
    const input = base();
    const pkg = buildLeadPackage({
      ...input,
      evidence: [
        { field: 'website_profile.vat_id', sourceUrl: null, fetchedAt: new Date('2026-10-20T00:00:00.000Z') },
      ],
    });
    expect(pkg.evidence).toEqual([
      {
        field: 'website_profile.vat_id',
        source_url: 'https://beispiel-pumpen.de/impressum',
        fetched_at: '2026-10-20T00:00:00.000Z',
      },
    ]);
  });

  it('leaves missing facts empty and survives malformed JSON without guessing', () => {
    const pkg = buildLeadPackage({
      lead: {
        id: 'lead-2',
        status: 'DISCOVERED',
        queue: 'needs_review',
        fitVerdict: null,
        fitReasons: null,
        scores: null,
        scoreDetail: 'not-json',
        totalScore: null,
      },
      company: { id: 'company-2', name: 'Nur Name', domain: null, country: null, attributes: null },
      contactPoints: [],
      evidence: [],
      sanctions: { status: 'not_screened', screened_at: null },
      validUntil: null,
    });
    expect(pkg.company).toEqual({
      canonical_company_id: 'company-2',
      name: 'Nur Name',
      domain: null,
      country: null,
      city: null,
    });
    expect(pkg.company_profile.carried_brands).toEqual([]);
    expect(pkg.contact_points).toEqual([]);
    expect(pkg.suggested_contact_path).toBeNull();
    expect(pkg.signals).toEqual([]);
    expect(pkg.evidence).toEqual([]);
    expect(pkg.fit).toEqual({ verdict: null, reason_codes: [], reasons: [] });
    expect(pkg.scores).toEqual({
      fit: null,
      role: null,
      intent: null,
      demand_proof: null,
      reachability: null,
      data_quality: null,
      engagement: null,
      total: null,
    });
    expect(pkg.registered_address).toBeNull();
    expect(pkg.valid_until).toBeNull();
  });

  it('returns a frozen object so a caller cannot mutate the delivered facts', () => {
    const pkg = buildLeadPackage(base());
    expect(Object.isFrozen(pkg)).toBe(true);
    expect(Object.isFrozen(pkg.scores)).toBe(true);
    expect(Object.isFrozen(pkg.contact_points)).toBe(true);
    expect(Object.isFrozen(pkg.fit.reason_codes)).toBe(true);
  });
});
