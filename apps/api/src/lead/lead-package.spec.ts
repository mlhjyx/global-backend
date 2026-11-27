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

  it('Phase 1: projects company_signal rows and falls back to digital_footprint / structured_harvest when intent.events is empty', () => {
    const input = base();
    const withoutIntent = {
      ...input,
      company: {
        ...input.company,
        attributes: {
          website_profile: (input.company.attributes as Record<string, unknown>).website_profile,
        },
      },
      companySignals: [
        {
          providerKey: 'structured_harvest',
          signalKind: 'page_change',
          sourceUrl: 'https://beispiel-pumpen.de/careers',
          title: '正在招聘采购/供应链相关岗位（3 个开放职位）',
          excerpt: 'Head of Procurement, Supply Chain Manager',
          observedAt: new Date('2026-11-24T12:00:00.000Z'),
        },
        {
          providerKey: 'rss',
          signalKind: 'rss_item',
          sourceUrl: 'https://news.example.de/expansion',
          title: 'Beispiel Pumpen expands warehouse',
          excerpt: 'New regional logistics center opened.',
          observedAt: new Date('2026-11-20T08:00:00.000Z'),
        },
      ],
    };
    const pkg = buildLeadPackage(withoutIntent);
    expect(pkg.signals).toHaveLength(2);
    expect(pkg.signals[0]).toMatchObject({
      type: 'HIRING_BUYING_ROLE',
      at: '2026-11-24T12:00:00.000Z',
      url: 'https://beispiel-pumpen.de/careers',
      title: '正在招聘采购/供应链相关岗位（3 个开放职位）',
      provider: 'structured_harvest',
    });
    expect(pkg.signals[1]).toMatchObject({
      type: 'NEWS_MENTION',
      at: '2026-11-20T08:00:00.000Z',
      url: 'https://news.example.de/expansion',
      provider: 'rss',
    });

    const fallbackPkg = buildLeadPackage({
      ...input,
      company: {
        ...input.company,
        attributes: {
          digital_footprint: {
            is_advertiser: true,
            ad_pixels: ['google_ads', 'meta_pixel'],
            _ts: '2026-11-22T09:00:00.000Z',
          },
          structured_harvest: {
            careers_url: 'https://beispiel-pumpen.de/jobs',
            hiring_signal: { open_roles: 2, titles: ['Procurement Lead'], has_buying_role: true },
            _ts: '2026-11-23T09:00:00.000Z',
          },
        },
      },
    });
    expect(fallbackPkg.signals).toHaveLength(2);
    expect(fallbackPkg.signals[0]).toMatchObject({
      type: 'HIRING_BUYING_ROLE',
      at: '2026-11-23T09:00:00.000Z',
      url: 'https://beispiel-pumpen.de/jobs',
      provider: 'structured_harvest',
    });
    expect(fallbackPkg.signals[1]).toMatchObject({
      type: 'AD_CAMPAIGN_ACTIVE',
      at: '2026-11-22T09:00:00.000Z',
      provider: 'digital_footprint',
    });
  });

  it('prefers VIES-verified vat_id over self-reported website_profile.vat_id in identifiers', () => {
    const input = base();
    const pkg = buildLeadPackage({
      ...input,
      company: {
        ...input.company,
        attributes: {
          ...input.company.attributes,
          vies: { vat_id: 'IT04553650989', verified_status: 'VALID' },
        },
      },
    });
    expect(pkg.identifiers.vat_id).toBe('IT04553650989');
  });

  it('Phase 3B: attaches grounded bilingual icebreakerSuggestions and omits them when omitSocials is true', () => {
    const input = base();
    const pkg = buildLeadPackage({
      ...input,
      company: {
        ...input.company,
        name: 'Rhein Solar EPC GmbH',
        attributes: {
          ted: {
            publication_number: '654321-2026',
            publication_date: '2026-11-24',
            notice_type: 'can-standard',
            cpv: ['45261215'],
            self_role: 'buyer',
          },
        },
      },
      companySignals: [
        {
          providerKey: 'changedetection',
          signalKind: 'page_change',
          sourceUrl: 'https://rhein-epc.de/projects',
          title: '官网新增工业光伏项目案例页',
          excerpt: null,
          observedAt: new Date('2026-11-25T10:00:00.000Z'),
        },
      ],
    });

    expect(pkg.icebreakerSuggestions.length).toBe(2);
    expect(pkg.icebreakerSuggestions[0]).toMatchObject({
      signalType: 'PAGE_CHANGE',
      signalUrl: 'https://rhein-epc.de/projects',
    });
    expect(pkg.icebreakerSuggestions[1]).toMatchObject({
      signalType: 'TENDER_AWARDED',
      signalUrl: 'https://ted.europa.eu/en/notice/-/detail/654321-2026',
    });
    expect(pkg.icebreakerSuggestions[1]!.openerZh).toContain('Rhein Solar EPC GmbH');
    expect(pkg.icebreakerSuggestions[1]!.openerEn).toContain('Rhein Solar EPC GmbH');

    const suppressedPkg = buildLeadPackage({
      ...input,
      omitSocials: true,
    });
    expect(suppressedPkg.icebreakerSuggestions).toEqual([]);
  });
});

describe('lead company overview projection', () => {
  const website = {
    description: 'Vertrieb und Wartung von Pumpen für Industriebetriebe.',
    main_business: ['Pumpen', 'Wartung'],
    source_url: 'https://beispiel-pumpen.de/leistungen',
    fetched_at: '2026-11-27T08:30:00.000Z',
  };
  function projection(value: unknown, allowedActions = ['display'], sourcePolicyCurrent = true) {
    const input = base();
    return buildLeadPackage({
      ...input,
      company: {
        ...input.company,
        attributes: { ...(input.company.attributes as object), company_website_overview: value },
      },
      allowedCompanyWebsiteUrls: sourcePolicyCurrent ? [website.source_url] : [],
      evidence: [
        ...input.evidence,
        { field: 'company_website_overview', sourceUrl: website.source_url, fetchedAt: website.fetched_at, allowedActions },
        { field: 'gleif.registered_city', sourceUrl: 'https://api.gleif.org/lei/1', fetchedAt: '2026-10-18T00:00:00.000Z', allowedActions: ['display'] },
        { field: 'country', sourceUrl: 'https://internal-example.net/registry', fetchedAt: '2026-10-18T00:00:00.000Z', allowedActions: ['match'] },
      ],
    });
  }

  it('serves the approved company facts and displayable citations in a typed optional field', () => {
    const result = projection(website);
    expect(result.company).toMatchObject({ country: 'DE', city: 'München' });
    expect(result).toHaveProperty('company_overview', {
      description: website.description,
      main_business: website.main_business,
      official_website: 'https://beispiel-pumpen.de/',
      sources: [
        { field: 'description', source_url: website.source_url, fetched_at: website.fetched_at },
        { field: 'main_business', source_url: website.source_url, fetched_at: website.fetched_at },
        { field: 'website', source_url: website.source_url, fetched_at: website.fetched_at },
        { field: 'location', source_url: 'https://api.gleif.org/lei/1', fetched_at: '2026-10-18T00:00:00.000Z' },
      ],
    });
  });

  it('withholds copies when the provenance is match-only or the current display permission was removed', () => {
    for (const result of [projection(website, ['match']), projection(website, ['display'], false)]) {
      expect(result).toHaveProperty('company_overview.description', null);
      expect(result).toHaveProperty('company_overview.main_business', []);
      expect(result).toHaveProperty('company_overview.official_website', null);
    }
  });

  it('withholds stale attribution after a domain mismatch and legacy rows retain their real location', () => {
    const result = projection({ ...website, source_url: 'https://unrelated-shop.de/' });
    expect(result).toHaveProperty('company_overview.description', null);
    expect(result).toHaveProperty('company_overview.main_business', []);
    expect(result.company).toMatchObject({ domain: 'beispiel-pumpen.de', country: 'DE', city: 'München' });
  });
});
