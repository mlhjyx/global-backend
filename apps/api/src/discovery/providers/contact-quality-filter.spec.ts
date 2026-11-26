import { describe, expect, it } from 'vitest';
import {
  isCrossCompanySocialMismatch,
  isGenericSwitchboardContact,
  isJunkContactCandidate,
  isPlaceholderContact,
} from './contact-quality-filter';

describe('contact-quality-filter', () => {
  it('rejects cross-company social mismatches (K-Energy Fitness, US Corp vs IT company)', () => {
    expect(
      isCrossCompanySocialMismatch('Owner at K-Energy Fitness | LinkedIn', {
        name: 'K-Energy Srl',
        domain: 'k-energy.it',
        country: 'IT',
      }),
    ).toBe(true);

    expect(
      isCrossCompanySocialMismatch('CEO at Fast Energy Services Corp. | LinkedIn', {
        name: 'FAST ENERGY',
        domain: 'fastenergy.it',
        country: 'IT',
      }),
    ).toBe(true);

    expect(
      isCrossCompanySocialMismatch('Head of Procurement – K-Energy Srl | LinkedIn', {
        name: 'K-Energy Srl',
        domain: 'k-energy.it',
        country: 'IT',
      }),
    ).toBe(false);
  });

  it('rejects legal disclaimers, non-buyer HR/worker roles, and empty-title zero-channel placeholders', () => {
    expect(isJunkContactCandidate({ fullName: 'Verantwortlich §55 RStV', title: 'Impressum' })).toBe(true);
    expect(isJunkContactCandidate({ fullName: 'Anna Weber', title: 'HR-Managerin & Recruiting' })).toBe(true);
    expect(isJunkContactCandidate({ fullName: 'Marco Rossi', title: 'Lattoniere / Monteur' })).toBe(true);
    expect(isJunkContactCandidate({ fullName: 'Lukas Meyer', title: 'Werkstudent Controlling' })).toBe(true);
    expect(
      isJunkContactCandidate({ fullName: 'No Title Person', title: '', requireSignalOrTitle: true }),
    ).toBe(true);

    // Keeps titled executives (even before email enrichment) and contacts with direct channels
    expect(
      isJunkContactCandidate({ fullName: 'Marco Rossi', title: 'Head of Procurement', requireSignalOrTitle: true }),
    ).toBe(false);
    expect(
      isJunkContactCandidate({
        fullName: 'Marco Rossi',
        title: undefined,
        email: 'marco.rossi@solar.it',
        requireSignalOrTitle: true,
      }),
    ).toBe(false);
  });

  it('identifies generic switchboard and legacy email placeholder contacts without filtering human names', () => {
    expect(isGenericSwitchboardContact({ fullName: '公开联系点 (info@)', title: 'switchboard' })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: 'Any Label', title: 'Switchboard' })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: '公开联系点 (sales@)', title: null })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: '公开联系点（info@）', title: null })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: '公开总机', title: null })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: '个人邮箱 (servizioclienti@)', title: null })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: '个人邮箱 (max@)', title: undefined })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: '个人邮箱（max@）', title: null })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: '公司邮箱 (info@)', title: null })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: '企业邮箱 (contact@)', title: null })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: 'Company Switchboard', title: null })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: 'Switchboard', title: null })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: 'Personal Email (max@)', title: null })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: 'Company Email (info@)', title: null })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: 'Corporate Email (sales@)', title: null })).toBe(true);
    expect(isGenericSwitchboardContact({ fullName: 'Public Contact (info@)', title: null })).toBe(true);

    // Must never filter real human names (Western or CJK)
    expect(isGenericSwitchboardContact({ fullName: 'Marco Rossi', title: 'CEO' })).toBe(false);
    expect(isGenericSwitchboardContact({ fullName: 'Marco Rossi', title: null })).toBe(false);
    expect(isGenericSwitchboardContact({ fullName: "Matteo Dell'Oglio", title: 'Sales Manager Lombardia' })).toBe(false);
    expect(isGenericSwitchboardContact({ fullName: 'Tobias Michl', title: 'Teamleiter' })).toBe(false);
    expect(isGenericSwitchboardContact({ fullName: '张伟', title: '采购总监' })).toBe(false);
    expect(isGenericSwitchboardContact({ fullName: '李娜', title: null })).toBe(false);
    expect(isPlaceholderContact({ fullName: '个人邮箱 (servizioclienti@)', title: null })).toBe(true);
    expect(isPlaceholderContact({ fullName: 'Marco Rossi', title: 'CEO' })).toBe(false);
    expect(isGenericSwitchboardContact({ fullName: 'Dr. Klaus Müller', title: 'Geschäftsführer' })).toBe(false);
  });
});
