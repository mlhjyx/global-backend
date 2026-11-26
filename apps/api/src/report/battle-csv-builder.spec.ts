import { describe, expect, it } from 'vitest';
import { buildBattleCsvRow, renderBattleCsvFromRows } from './battle-csv-builder';

describe('battle-csv-builder (Batch 1.4-C 19-column audited battle CSV)', () => {
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
});
