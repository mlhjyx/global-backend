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
});
