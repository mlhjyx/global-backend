import { describe, expect, it } from 'vitest';
import { UTF8_BOM } from './csv';
import { BATTLE_CSV_HEADERS, maskEmailLocalPart, renderBattleCsv } from './battle-csv';

describe('Gate 1 Multi-Channel Battle CSV exporter (CWE-1236 safe)', () => {
  it('neutralizes spreadsheet formula injection, preserves UTF-8 BOM, and supports optional email masking', () => {
    const csv = renderBattleCsv(
      [
        {
          companyName: '=HYPERLINK("https://evil.example","ReFeel EPC")',
          country: 'IT',
          domain: 'refeel-epc.it',
          fitScore: 0.91,
          evidenceSummary: 'C1: Ground-mount solar EPC; C4: Hiring PV PM + KEY 2026',
          channelTier: 'S',
          contactName: 'Mattia Masotti',
          contactTitle: 'Head of Operations & Sales',
          committeeTrack: '技术定标旁路轨',
          contactEmail: 'm.masotti@refeel-epc.it',
          emailVerificationState: 'VALID',
          linkedinUrl: 'https://www.linkedin.com/in/mattia-masotti',
          triggerHook: '+CMD("hiring solar PM")',
          linkedinNote: 'Buongiorno Mattia, ho visto il suo annuncio...',
          referralInfoDraft: null,
          vendorPortalOrWhatsapp: null,
          complianceTag: 'IT:GDPR_LI+ART14',
          legalNoticeStatus: 'ART14_SCHEDULED_30D',
          sellerInboundFooter: 'Liansheng PV Co., Ltd. | https://wa.me/8613800000000',
        },
      ],
      { maskEmails: true },
    );

    expect(csv.startsWith(UTF8_BOM)).toBe(true);
    expect(csv).toContain(BATTLE_CSV_HEADERS.join(','));
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.example"",""ReFeel EPC"")"`);
    expect(csv).toContain(`"'+CMD(""hiring solar PM"")"`);
    expect(csv).toContain('m.***@refeel-epc.it');
    expect(csv).not.toContain('m.masotti@refeel-epc.it');
  });

  it('masks email local parts safely and retains raw email when maskEmails=false', () => {
    expect(maskEmailLocalPart('elena.bacchetti@refeel-epc.it')).toBe('el***@refeel-epc.it');
    const unmasked = renderBattleCsv(
      [
        {
          companyName: 'Memodo GmbH',
          country: 'DE',
          domain: 'memodo.de',
          fitScore: 0.89,
          evidenceSummary: 'Top German PV wholesaler',
          channelTier: 'A',
          contactName: 'André Jäger',
          contactTitle: 'Director SCM',
          committeeTrack: '寻源/采购主轨',
          contactEmail: 'einkauf@memodo.de',
          emailVerificationState: 'VALID',
          linkedinUrl: 'https://linkedin.com/in/andre-jaeger',
          triggerHook: null,
          linkedinNote: null,
          referralInfoDraft: null,
          vendorPortalOrWhatsapp: 'https://memodo.de/suppliers',
          complianceTag: 'DE:UWG_STRICT_LINKEDIN_FIRST+ART14',
          legalNoticeStatus: 'FUNCTIONAL_AMBER',
          sellerInboundFooter: null,
        },
      ],
      { maskEmails: false },
    );
    expect(unmasked).toContain('einkauf@memodo.de');
  });
});
