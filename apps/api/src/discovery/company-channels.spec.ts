import { describe, expect, it, vi } from 'vitest';
import {
  extractCompanySocialProfiles,
  filterDecisionMakerContacts,
  filterReachableCompanyChannels,
  loadLeadListChannelSummaries,
} from './company-channels';

describe('lead-channels', () => {
  const company = { id: 'co-1', name: 'Coenergia srl', domain: 'coenergia.com', status: 'ENRICHED' };

  it('filters invalid, suppressed, and non-contact historical dirty form_url channels (#96-2)', () => {
    const out = filterReachableCompanyChannels(
      [
        { channel: 'email', value: 'info@coenergia.com', emailType: 'role', status: 'UNVERIFIED', sourceType: 'homepage', sourceUrl: 'https://coenergia.com/' },
        { channel: 'email', value: 'blocked@coenergia.com', emailType: 'role', status: 'UNVERIFIED', sourceType: 'homepage', sourceUrl: null },
        { channel: 'phone', value: '+39 0386 734092', emailType: null, status: 'UNVERIFIED', sourceType: 'contact_page', sourceUrl: null },
        { channel: 'form_url', value: 'https://coenergia.com/contatti', emailType: null, status: 'INVALID', sourceType: 'contact_page', sourceUrl: null },
        { channel: 'form_url', value: 'https://memodo.it/fotovoltaico/accessori/phoenix-contact/', emailType: null, status: 'UNVERIFIED', sourceType: 'contact_page', sourceUrl: null },
        { channel: 'form_url', value: 'https://coenergia.com/it/contatti/', emailType: null, status: 'UNVERIFIED', sourceType: 'contact_page', sourceUrl: null },
      ],
      [{ type: 'email', value: 'blocked@coenergia.com' }],
      company,
    );
    expect(out).toHaveLength(3);
    expect(out.map((c) => [c.channel, c.value])).toEqual([
      ['email', 'info@coenergia.com'],
      ['phone', '+39 0386 734092'],
      ['form_url', 'https://coenergia.com/it/contatti/'],
    ]);
  });

  it('merges and deduplicates social profiles from contact_point and structured_org.same_as', () => {
    const socials = extractCompanySocialProfiles(
      [
        { kind: 'linkedin_company_page', value: 'https://www.linkedin.com/company/coenergia', status: 'UNVERIFIED' },
        { kind: 'contact_page', value: 'https://coenergia.com/contatti', status: 'UNVERIFIED' },
      ],
      {
        digital_footprint: {
          structured_org: {
            same_as: [
              'https://www.linkedin.com/company/coenergia/',
              'https://www.facebook.com/coenergia/',
              'https://www.instagram.com/coenergia/?utm_source=web',
              'https://www.youtube.com/@coenergia',
            ],
          },
        },
      },
    );
    expect(socials.map((s) => [s.platform, s.url])).toEqual([
      ['linkedin', 'https://www.linkedin.com/company/coenergia'],
      ['facebook', 'https://www.facebook.com/coenergia'],
      ['instagram', 'https://www.instagram.com/coenergia'],
      ['youtube', 'https://www.youtube.com/@coenergia'],
    ]);
  });

  it('builds company-only list summaries and excludes switchboard placeholders from decisionMakerCount', async () => {
    const tx = {
      companyContactChannel: {
        findMany: vi.fn(async () => [
          { companyId: 'co-1', channel: 'email', value: 'info@coenergia.com', emailType: 'role', status: 'UNVERIFIED', sourceType: 'homepage', sourceUrl: null },
          { companyId: 'co-1', channel: 'phone', value: '+39 0386 734092', emailType: null, status: 'UNVERIFIED', sourceType: 'homepage', sourceUrl: null },
        ]),
      },
      companyContactPoint: {
        findMany: vi.fn(async () => [
          { companyId: 'co-1', kind: 'linkedin_company_page', value: 'https://www.linkedin.com/company/coenergia', status: 'UNVERIFIED' },
          { companyId: 'co-1', kind: 'contact_form', value: 'https://coenergia.com/contatti', status: 'UNVERIFIED' },
        ]),
      },
      canonicalContact: {
        findMany: vi.fn(async () => [
          { companyId: 'co-1', fullName: '公开联系点 (info@)', title: 'switchboard', contactPoints: [] },
          { companyId: 'co-1', fullName: '个人邮箱 (servizioclienti@)', title: null, contactPoints: [] },
          { companyId: 'co-1', fullName: '公司邮箱 (vendite@)', title: null, contactPoints: [] },
          { companyId: 'co-1', fullName: 'Marco Rossi', title: 'CEO', contactPoints: [{ type: 'email', value: 'm@coenergia.com', status: 'VALID' }] },
        ]),
      },
      suppressionRecord: { findMany: vi.fn(async () => []) },
    };

    const map = await loadLeadListChannelSummaries(tx as never, [
      { ...company, attributes: { digital_footprint: { structured_org: { same_as: ['https://www.facebook.com/coenergia'] } } } },
    ]);
    const summary = map.get('co-1');
    expect(summary).toEqual({
      emails: ['info@coenergia.com'],
      phones: ['+39 0386 734092'],
      forms: ['https://coenergia.com/contatti'],
      socials: [
        { platform: 'linkedin', url: 'https://www.linkedin.com/company/coenergia' },
        { platform: 'facebook', url: 'https://www.facebook.com/coenergia' },
      ],
      decisionMakerCount: 1,
      verifiedEmailCount: 1,
    });
  });

  it('filterDecisionMakerContacts drops legacy placeholder contacts and ranks VALID email contacts first', () => {
    const out = filterDecisionMakerContacts([
      { id: 'c-placeholder', fullName: '个人邮箱 (servizioclienti@)', title: null, contactPoints: [] },
      { id: 'c-vp-none', fullName: 'Tobias Michl', title: 'VP of Procurement', contactPoints: [] },
      {
        id: 'c-sales-valid',
        fullName: "Matteo Dell'Oglio",
        title: 'Sales Manager Lombardia',
        contactPoints: [{ type: 'email', value: 'm.delloglio@memodo.it', status: 'VALID', verificationState: 'VALID' }],
      },
    ]);
    expect(out.map((c) => c.id)).toEqual(['c-sales-valid', 'c-vp-none']);
  });
});
