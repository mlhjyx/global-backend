import { describe, expect, it } from 'vitest';
import { validateLinkedInConnectionNote } from '../enrichment/buying-committee';
import { buildBattleCsvRow, renderBattleCsvFromRows } from './battle-csv-builder';

describe('battle-csv-builder (Batch 1.4-C + Batch 1.8A 21-column audited battle CSV)', () => {
  it('builds S-tier row with buying-committee track, D3 compliance tag, Art.14/LIA status, and optional email masking', () => {
    const row = buildBattleCsvRow({
      lead: {
        id: 'lead-1',
        canonicalCompanyId: 'co-1',
        totalScore: 0.91,
        fitVerdict: 'match',
        scoreDetail: { summary: 'PV EPC in Northern Italy with 50MW utility projects' },
      },
      company: {
        id: 'co-1',
        name: 'ReFeel EPC S.r.l.',
        domain: 'refeel-epc.it',
        country: 'IT',
        attributes: {},
      },
      companyContactPoints: [{ kind: 'email', value: 'info@refeel-epc.it' }],
      decisionMakers: [
        { id: 'c-other', fullName: 'Luca Office', title: 'Office Admin', department: null, points: [] },
        {
          id: 'c-buyer',
          fullName: 'Mattia Masotti',
          title: 'Responsabile Acquisti',
          department: 'Procurement',
          points: [
            { type: 'email', value: 'm.masotti@refeel-epc.it', status: 'VERIFIED', verificationState: 'VALID' },
            { type: 'linkedin', value: 'https://www.linkedin.com/in/mattia-masotti', status: 'UNVERIFIED' },
          ],
        },
      ],
      draft: { subject: 'HJT 700W bifacial module supply', body: 'Hello' },
      article14StatusByContactId: new Map([['c-buyer', 'PENDING']]),
      hasActiveWorkspaceLia: true,
      sellerName: 'Liansheng PV Co., Ltd.',
      sellerProductSummary: 'HJT 600-720W bifacial solar modules',
    });

    expect(row.channelTier).toBe('S');
    expect(row.contactName).toBe('Mattia Masotti');
    expect(row.committeeTrack).toBe('寻源/采购主轨');
    expect(row.complianceTag).toBe('IT:GDPR_LI+ART14');
    expect(row.legalNoticeStatus).toBe('Art.14:PENDING; LIA:ACTIVE');
    expect(row.linkedinNote).toContain('Hi Mattia');

    const maskedCsv = renderBattleCsvFromRows([row], true);
    expect(maskedCsv).toContain('m.***@refeel-epc.it');
    expect(maskedCsv).not.toContain('m.masotti@refeel-epc.it');
  });

  it('builds C-tier info@ fallback row with localized Referral-First forwarding draft', () => {
    const row = buildBattleCsvRow({
      lead: {
        id: 'lead-2',
        canonicalCompanyId: 'co-2',
        totalScore: 0.72,
        fitVerdict: 'match',
        scoreDetail: null,
      },
      company: {
        id: 'co-2',
        name: 'Solar Nord GmbH',
        domain: 'solarnord.de',
        country: 'DE',
        attributes: {},
      },
      companyContactPoints: [{ kind: 'email', value: 'info@solarnord.de' }],
      decisionMakers: [],
      draft: null,
      sellerName: 'Liansheng PV Co., Ltd.',
      sellerProductSummary: 'HJT Solarmodule',
    });

    expect(row.channelTier).toBe('C');
    expect(row.referralInfoDraft).toContain('Weiterleitungsbitte');
    expect(row.complianceTag).toContain('DE:');
  });

  it('sanitizes CJK seller/product fields in Italian referral drafts and infers country from ccTLD when null', () => {
    const row = buildBattleCsvRow({
      lead: {
        id: 'lead-3',
        canonicalCompanyId: 'co-3',
        totalScore: 0.65,
        fitVerdict: 'weak',
        scoreDetail: null,
      },
      company: {
        id: 'co-3',
        name: 'Duowatt S.r.l.',
        domain: 'duowatt.it',
        country: null,
        attributes: {},
      },
      companyContactPoints: [{ kind: 'email', value: 'info@duowatt.it' }],
      decisionMakers: [],
      draft: null,
      sellerName: '琏升科技股份有限公司',
      sellerProductSummary: '高效异质结光伏组件',
    });

    expect(row.country).toBe('IT');
    expect(row.complianceTag).toContain('IT:');
    expect(row.referralInfoDraft).toContain('componenti e prodotti industriali OEM/ODM');
    expect(row.referralInfoDraft).not.toMatch(/[\p{Script=Han}]/u);
  });

  it('prefers a Sales Manager with a VALID email over a Teamleiter or VP without email (Memodo regression)', () => {
    const row = buildBattleCsvRow({
      lead: {
        id: 'lead-memodo',
        canonicalCompanyId: 'co-memodo',
        totalScore: 0.88,
        fitVerdict: 'match',
        scoreDetail: { summary: 'PV distributor in DACH and Italy' },
      },
      company: {
        id: 'co-memodo',
        name: 'Memodo GmbH',
        domain: 'memodo.it',
        country: 'IT',
        attributes: {},
      },
      companyContactPoints: [{ kind: 'email', value: 'info@memodo.it' }],
      decisionMakers: [
        {
          id: 'dm-teamleiter',
          fullName: 'Tobias Michl',
          title: 'Teamleiter',
          department: null,
          points: [{ type: 'linkedin', value: 'https://www.linkedin.com/in/tobias-michl', status: 'UNVERIFIED' }],
        },
        {
          id: 'dm-vp',
          fullName: 'Anna Weber',
          title: 'VP of Procurement',
          department: 'Procurement',
          points: [],
        },
        {
          id: 'dm-sales-valid',
          fullName: "Matteo Dell'Oglio",
          title: 'Sales Manager Lombardia',
          department: 'Sales',
          points: [
            {
              type: 'email',
              value: 'm.delloglio@memodo.it',
              status: 'VALID',
              verificationState: 'VALID',
            },
          ],
        },
      ],
      draft: null,
    });

    expect(row.contactName).toBe("Matteo Dell'Oglio");
    expect(row.contactTitle).toBe('Sales Manager Lombardia');
    expect(row.contactEmail).toBe('m.delloglio@memodo.it');
    expect(row.emailVerificationState).toBe('VALID');
    expect(row.channelTier).toBe('S');
  });

  it('prefers non-INVALID usable email over no-email and unconfirmed pattern_guess contacts', () => {
    const row = buildBattleCsvRow({
      lead: {
        id: 'lead-tier1',
        canonicalCompanyId: 'co-tier1',
        totalScore: 0.8,
        fitVerdict: 'match',
        scoreDetail: null,
      },
      company: {
        id: 'co-tier1',
        name: 'Solar Italia S.r.l.',
        domain: 'solaritalia.it',
        country: 'IT',
        attributes: {},
      },
      companyContactPoints: [{ kind: 'email', value: 'info@solaritalia.it' }],
      decisionMakers: [
        {
          id: 'dm-guess',
          fullName: 'Paolo Rossi',
          title: 'Head of Procurement',
          department: 'Procurement',
          points: [
            {
              type: 'email',
              value: 'p.rossi@solaritalia.it',
              status: 'RISKY',
              verificationState: 'CATCH_ALL_RISKY',
              sourceType: 'pattern_guess',
            },
          ],
        },
        {
          id: 'dm-usable',
          fullName: 'Elena Conti',
          title: 'Sales Manager',
          department: 'Sales',
          points: [
            {
              type: 'email',
              value: 'e.conti@solaritalia.it',
              status: 'RISKY',
              verificationState: 'CATCH_ALL_RISKY',
              sourceType: 'provider',
            },
          ],
        },
      ],
      draft: null,
    });

    expect(row.contactName).toBe('Elena Conti');
    expect(row.contactEmail).toBe('e.conti@solaritalia.it');
    expect(row.emailVerificationState).toBe('CATCH_ALL_RISKY');
  });

  it('excludes legacy 个人邮箱 (...) placeholder contacts from Battle CSV decision-maker selection (AEG Market regression)', () => {
    const row = buildBattleCsvRow({
      lead: {
        id: 'lead-aeg',
        canonicalCompanyId: 'co-aeg',
        totalScore: 0.78,
        fitVerdict: 'match',
        scoreDetail: null,
      },
      company: {
        id: 'co-aeg',
        name: 'AEG Market S.r.l.',
        domain: 'aegmarket.it',
        country: 'IT',
        attributes: {},
      },
      companyContactPoints: [{ kind: 'email', value: 'info@aegmarket.it' }],
      decisionMakers: [
        {
          id: 'dm-placeholder',
          fullName: '个人邮箱 (servizioclienti@)',
          title: null,
          department: null,
          points: [
            {
              type: 'email',
              value: 'servizioclienti@aegmarket.it',
              status: 'UNVERIFIED',
              verificationState: 'UNKNOWN',
            },
          ],
        },
      ],
      draft: null,
    });

    expect(row.contactName).toBeNull();
    expect(row.contactTitle).toBeNull();
    expect(row.linkedinNote).toBeNull();
    expect(row.channelTier).toBe('C');
  });

  it('falls back to VALID when status=VALID and verificationState=UNKNOWN, and respects authoritative CATCH_ALL_RISKY over stale status=VALID', () => {
    const legacyValidRow = buildBattleCsvRow({
      lead: {
        id: 'lead-legacy-valid',
        canonicalCompanyId: 'co-legacy-valid',
        totalScore: 0.85,
        fitVerdict: 'match',
        scoreDetail: null,
      },
      company: {
        id: 'co-legacy-valid',
        name: 'Legacy Valid S.r.l.',
        domain: 'legacyvalid.it',
        country: 'IT',
        attributes: {},
      },
      companyContactPoints: [{ kind: 'email', value: 'info@legacyvalid.it' }],
      decisionMakers: [
        {
          id: 'dm-reverified-risky',
          fullName: 'Paolo Rossi',
          title: 'Head of Procurement',
          department: 'Procurement',
          points: [
            {
              type: 'email',
              value: 'p.rossi@legacyvalid.it',
              status: 'VALID',
              verificationState: 'CATCH_ALL_RISKY',
            },
          ],
        },
        {
          id: 'dm-legacy-valid',
          fullName: 'Elena Conti',
          title: 'Sales Manager',
          department: 'Sales',
          points: [
            {
              type: 'email',
              value: 'e.conti@legacyvalid.it',
              status: 'VALID',
              verificationState: 'UNKNOWN',
            },
          ],
        },
      ],
      draft: null,
    });

    expect(legacyValidRow.contactName).toBe('Elena Conti');
    expect(legacyValidRow.contactEmail).toBe('e.conti@legacyvalid.it');
    expect(legacyValidRow.emailVerificationState).toBe('VALID');
    expect(legacyValidRow.channelTier).toBe('S');

    const downgradedRow = buildBattleCsvRow({
      lead: {
        id: 'lead-downgraded',
        canonicalCompanyId: 'co-downgraded',
        totalScore: 0.82,
        fitVerdict: 'match',
        scoreDetail: null,
      },
      company: {
        id: 'co-downgraded',
        name: 'Downgraded S.r.l.',
        domain: 'downgraded.it',
        country: 'IT',
        attributes: {},
      },
      companyContactPoints: [],
      decisionMakers: [
        {
          id: 'dm-reverified-risky',
          fullName: 'Paolo Rossi',
          title: 'Head of Procurement',
          department: 'Procurement',
          points: [
            {
              type: 'email',
              value: 'p.rossi@downgraded.it',
              status: 'VALID',
              verificationState: 'CATCH_ALL_RISKY',
            },
          ],
        },
      ],
      draft: null,
    });

    expect(downgradedRow.contactName).toBe('Paolo Rossi');
    expect(downgradedRow.emailVerificationState).toBe('CATCH_ALL_RISKY');
    expect(downgradedRow.channelTier).not.toBe('S');
  });

  it('blocks unconfirmed pattern_guess emails on placeholder contacts from leaking into switchboard fallback email', () => {
    const row = buildBattleCsvRow({
      lead: {
        id: 'lead-placeholder-guess',
        canonicalCompanyId: 'co-placeholder-guess',
        totalScore: 0.75,
        fitVerdict: 'match',
        scoreDetail: null,
      },
      company: {
        id: 'co-placeholder-guess',
        name: 'AEG Market S.r.l.',
        domain: 'aegmarket.it',
        country: 'IT',
        attributes: {},
      },
      companyContactPoints: [{ kind: 'email', value: 'info@aegmarket.it' }],
      decisionMakers: [
        {
          id: 'dm-placeholder-guess',
          fullName: '个人邮箱 (servizioclienti@)',
          title: null,
          department: null,
          points: [
            {
              type: 'email',
              value: 'guessed@aegmarket.it',
              status: 'RISKY',
              verificationState: 'CATCH_ALL_RISKY',
              sourceType: 'pattern_guess',
            },
          ],
        },
      ],
      draft: null,
    });

    expect(row.contactName).toBeNull();
    expect(row.contactEmail).toBe('info@aegmarket.it');
  });

  it('#96-1: Italian referral draft uses localized department label with zero CJK, and named CATCH_ALL_RISKY personal email is B-tier with no referralInfoDraft', () => {
    const infoFallbackRow = buildBattleCsvRow({
      lead: { id: 'lead-it-c', canonicalCompanyId: 'co-it-c', totalScore: 0.74, fitVerdict: 'match', scoreDetail: null },
      company: { id: 'co-it-c', name: 'Solaris Italia S.r.l.', domain: 'solaris.it', country: 'IT', attributes: {} },
      companyContactPoints: [{ kind: 'email', value: 'info@solaris.it' }],
      decisionMakers: [{ id: 'dm-ceo', fullName: 'Marco Bianchi', title: 'Amministratore Delegato', department: null, points: [] }],
      draft: null,
      sellerName: 'Liansheng PV Co., Ltd.',
      sellerProductSummary: 'moduli fotovoltaici HJT 700W',
    });
    expect(infoFallbackRow.channelTier).toBe('C');
    expect(infoFallbackRow.referralInfoDraft).toContain('Direzione Generale');
    expect(infoFallbackRow.referralInfoDraft).not.toMatch(/[\p{Script=Han}]/u);
    expect(infoFallbackRow.forwardableBlurb).toContain('Direzione Generale');
    expect(infoFallbackRow.forwardableBlurb).not.toMatch(/[\p{Script=Han}]/u);

    const namedRiskyRow = buildBattleCsvRow({
      lead: { id: 'lead-it-b', canonicalCompanyId: 'co-it-b', totalScore: 0.81, fitVerdict: 'match', scoreDetail: null },
      company: { id: 'co-it-b', name: 'Coenergia S.r.l.', domain: 'coenergia.com', country: 'IT', attributes: {} },
      companyContactPoints: [{ kind: 'email', value: 'info@coenergia.com' }],
      decisionMakers: [
        {
          id: 'dm-risky',
          fullName: 'Giulia Verdi',
          title: 'Responsabile Acquisti',
          department: 'Procurement',
          points: [{ type: 'email', value: 'g.verdi@coenergia.com', status: 'RISKY', verificationState: 'CATCH_ALL_RISKY' }],
        },
      ],
      draft: null,
    });
    expect(namedRiskyRow.channelTier).toBe('B');
    expect(namedRiskyRow.referralInfoDraft).toBeNull();
  });

  it('#96-2: ordinary contact_form/form_url stays C-tier with Contact:<url>, while true supplier_page upgrades to B-tier with Portal:<url>', () => {
    const ordinaryContactRow = buildBattleCsvRow({
      lead: { id: 'lead-cf', canonicalCompanyId: 'co-cf', totalScore: 0.76, fitVerdict: 'match', scoreDetail: null },
      company: { id: 'co-cf', name: 'Punto Solare S.r.l.', domain: 'puntosolare.it', country: 'IT', attributes: {} },
      companyContactPoints: [
        { kind: 'email', value: 'info@puntosolare.it' },
        { kind: 'contact_form', value: 'https://puntosolare.it/contatti' },
      ],
      companyContactChannels: [{ channel: 'form_url', value: 'https://puntosolare.it/contatti' }],
      decisionMakers: [],
      draft: null,
    });
    expect(ordinaryContactRow.channelTier).toBe('C');
    expect(ordinaryContactRow.vendorPortalOrWhatsapp).toContain('Contact:https://puntosolare.it/contatti');
    expect(ordinaryContactRow.vendorPortalOrWhatsapp).not.toContain('Portal:');

    const supplierPortalRow = buildBattleCsvRow({
      lead: { id: 'lead-sp', canonicalCompanyId: 'co-sp', totalScore: 0.85, fitVerdict: 'match', scoreDetail: null },
      company: { id: 'co-sp', name: 'Enel Green Procurement S.p.A.', domain: 'enelgreen.it', country: 'IT', attributes: {} },
      companyContactPoints: [
        { kind: 'email', value: 'info@enelgreen.it' },
        { kind: 'supplier_page', value: 'https://enelgreen.it/fornitori' },
      ],
      decisionMakers: [],
      draft: null,
    });
    expect(supplierPortalRow.channelTier).toBe('B');
    expect(supplierPortalRow.vendorPortalOrWhatsapp).toContain('Portal:https://enelgreen.it/fornitori');
  });

  it('#96-3: summarizes judgmentRecord criteria, filtered scoreDetail notes (dropping 无意图信号), and website_profile trade_role/carried_brands within 260 chars', () => {
    const row = buildBattleCsvRow({
      lead: {
        id: 'lead-ev',
        canonicalCompanyId: 'co-ev',
        totalScore: 0.9,
        fitVerdict: 'match',
        scoreDetail: {
          notes: ['无意图信号', '意大利本土光伏批发与系统集成商'],
        },
      },
      company: {
        id: 'co-ev',
        name: 'SolarStock Italia S.r.l.',
        domain: 'solarstock.it',
        country: 'IT',
        attributes: {
          website_profile: {
            trade_role: 'distributor',
            carried_brands: ['SMA', 'Fronius', 'Huawei', 'JinkoSolar'],
          },
        },
      },
      judgmentRecord: {
        verdict: 'match',
        criteria: [
          { label: '区域覆盖', applicable: true, score: 0.95, rationale: '深耕意大利北部光伏分销网络，覆盖伦巴第与威尼托' },
          { label: '品类匹配', applicable: true, score: 0.88, rationale: '常年现货分销大型工商业光伏组件与逆变器' },
          { label: '不适用项', applicable: false, score: 1, rationale: '不应出现的无关理由' },
        ],
      },
      companyContactPoints: [{ kind: 'email', value: 'info@solarstock.it' }],
      decisionMakers: [],
      draft: null,
    });

    expect(row.evidenceSummary).toContain('fit=match');
    expect(row.evidenceSummary).toContain('区域覆盖:');
    expect(row.evidenceSummary).toContain('意大利本土光伏批发与系统集成商');
    expect(row.evidenceSummary).toContain('role=distributor');
    expect(row.evidenceSummary).toContain('brands=SMA, Fronius, Huawei, JinkoSolar');
    expect(row.evidenceSummary).not.toContain('无意图信号');
    expect(row.evidenceSummary).not.toContain('不应出现的无关理由');
    expect(Array.from(row.evidenceSummary).length).toBeLessThanOrEqual(260);
  });

  it('#96-4 / #96-5 / #96-6 + 21-column Trigger/Blurb/OutreachWindow: enforces LinkedIn validator, resolves +39 phone country, separates Co-LI, and renders real signal trigger', () => {
    const row = buildBattleCsvRow({
      lead: { id: 'lead-iosolar', canonicalCompanyId: 'co-iosolar', totalScore: 0.87, fitVerdict: 'match', scoreDetail: null },
      company: {
        id: 'co-iosolar',
        name: 'IO Solar',
        domain: 'iosolar.com',
        country: null,
        attributes: {
          website_profile: {
            carried_brands: ['Longi', 'JA Solar'],
          },
        },
      },
      companyContactPoints: [
        { kind: 'email', value: 'info@iosolar.com' },
        { kind: 'linkedin_company_page', value: 'https://www.linkedin.com/company/io-solar-italia' },
      ],
      companyContactChannels: [{ channel: 'phone', value: '+39 0543 097431' }],
      decisionMakers: [
        {
          id: 'dm-io',
          fullName: 'Matteo Ferri',
          title: 'Responsabile Acquisti',
          department: 'Procurement',
          points: [
            { type: 'email', value: 'm.ferri@iosolar.com', status: 'VALID', verificationState: 'VALID' },
            { type: 'linkedin', value: 'https://www.linkedin.com/in/matteo-ferri-solar', status: 'UNVERIFIED' },
          ],
        },
      ],
      companySignals: [
        {
          providerKey: 'structured_harvest',
          signalKind: 'page_change',
          sourceUrl: 'https://iosolar.com/careers',
          title: 'Hiring Senior PV Procurement Specialist in Milan',
          excerpt: 'Expanding utility solar procurement team in Italy',
          observedAt: new Date('2026-11-20T09:00:00.000Z'),
        },
      ],
      draft: { subject: 'Fallback draft subject', body: 'Hello' },
      sellerName: 'Liansheng PV Co., Ltd.',
      // Deliberately inject URL + brochure word to verify validateLinkedInConnectionNote fallback cleanup!
      sellerProductSummary: 'HJT 700W bifacial solar modules see https://spam.example brochure [Product]',
      sellerInboundFooter: 'Liansheng PV Co., Ltd. | https://liansheng-pv.com | export@liansheng-pv.com',
    });

    // #96-5: +39 phone closes Art.14 Fail-Open gap on .com company with null country
    expect(row.country).toBe('IT');
    expect(row.complianceTag).toBe('IT:GDPR_LI+ART14');
    expect(row.outreachWindow).toBe('CET(UTC+1/+2) 09:00-17:30 | Dial:+39');

    // #96-6: personal LinkedIn in linkedinUrl, company LinkedIn in Co-LI
    expect(row.linkedinUrl).toBe('https://www.linkedin.com/in/matteo-ferri-solar');
    expect(row.vendorPortalOrWhatsapp).toContain('Co-LI:https://www.linkedin.com/company/io-solar-italia');
    expect(row.vendorPortalOrWhatsapp).toContain('Tel:+39 0543 097431');

    // #96-4: sellerInboundFooter passthrough + LinkedIn note passes hard validator
    expect(row.sellerInboundFooter).toBe('Liansheng PV Co., Ltd. | https://liansheng-pv.com | export@liansheng-pv.com');
    expect(row.linkedinNote).toBeTruthy();
    expect(validateLinkedInConnectionNote(row.linkedinNote!).ok).toBe(true);

    // Real signal trigger + forwardableBlurb (<=60 words)
    expect(row.triggerHook).toContain('[HIRING_BUYING_ROLE]');
    expect(row.triggerHook).toContain('2026-11-20');
    expect(row.forwardableBlurb).toBeTruthy();
    expect(row.forwardableBlurb!.split(/\s+/u).length).toBeLessThanOrEqual(60);

    // #96-6 when only company LinkedIn exists -> linkedinUrl must be null
    const companyOnlyLiRow = buildBattleCsvRow({
      lead: { id: 'lead-coli', canonicalCompanyId: 'co-coli', totalScore: 0.7, fitVerdict: 'match', scoreDetail: null },
      company: {
        id: 'co-coli',
        name: 'AEG Market',
        domain: 'aegmarket.com',
        country: null,
        attributes: { website_profile: { carried_brands: ['AEG Solar', 'Fronius'] } },
      },
      companyContactPoints: [
        { kind: 'email', value: 'info@aegmarket.com' },
        { kind: 'linkedin_company_page', value: 'https://www.linkedin.com/company/aeg-market' },
      ],
      companyContactChannels: [{ channel: 'phone', value: '+390289901122' }],
      decisionMakers: [],
      draft: null,
    });
    expect(companyOnlyLiRow.country).toBe('IT');
    expect(companyOnlyLiRow.linkedinUrl).toBeNull();
    expect(companyOnlyLiRow.vendorPortalOrWhatsapp).toContain('Co-LI:https://www.linkedin.com/company/aeg-market');
    expect(companyOnlyLiRow.triggerHook).toBe('官网在售品牌: AEG Solar, Fronius');
  });
});
