import { describe, expect, it } from 'vitest';
import {
  buildBuyingCommitteeQueries,
  buildLinkedInCoPilotPlaybook,
  buildReferralFirstInfoDraft,
  classifyBuyingCommitteeTrack,
  classifyContactChannelTier,
  validateLinkedInConnectionNote,
} from './buying-committee';

describe('Batch 1.3-A Anti-info@ 4-track Buying Committee engine', () => {
  it('builds localized Exa People, quoted Serper LinkedIn X-Ray, and Trigger Radar queries', () => {
    const plan = buildBuyingCommitteeQueries({
      companyName: 'ReFeel EPC',
      domain: 'refeel-epc.it',
      country: 'IT',
      industry: 'solar PV',
      tradeFairs: ['KEY Energy Rimini', 'Intersolar Europe'],
    });
    expect(plan.exaPeopleQuery).toContain('ReFeel EPC');
    expect(plan.exaPeopleQuery).toContain('Responsabile Acquisti');
    expect(plan.serperXrayQueries[0]).toContain('site:linkedin.com/in "ReFeel EPC"');
    expect(plan.serperXrayQueries[1]).toContain('Direttore Tecnico');
    expect(plan.serperTriggerQuery).toContain('site:linkedin.com/posts "ReFeel EPC"');
    expect(plan.serperTriggerQuery).toContain('"KEY Energy Rimini"');
  });

  it('classifies multilingual titles into sourcing, technical, executive, and assistant tracks', () => {
    expect(classifyBuyingCommitteeTrack('Strategic Buyer / Einkaufsleiter').track).toBe('sourcing');
    expect(classifyBuyingCommitteeTrack('Coordenador de Compras').track).toBe('sourcing');
    expect(classifyBuyingCommitteeTrack('Head of Engineering & Photovoltaic Division').track).toBe('technical');
    expect(classifyBuyingCommitteeTrack('Geschäftsführer').track).toBe('executive');
    expect(classifyBuyingCommitteeTrack('Referent der Einkaufsleitung').track).toBe('assistant');
  });

  it('separates S / A / B / C contact channel tiers cleanly without treating info@ as A-tier', () => {
    expect(
      classifyContactChannelTier({
        fullName: 'Mattia Masotti',
        email: 'm.masotti@refeel-epc.it',
        emailVerificationState: 'VALID',
      }),
    ).toBe('S');
    expect(classifyContactChannelTier({ email: 'acquisti@refeel-epc.it' })).toBe('A');
    expect(classifyContactChannelTier({ email: 'einkauf@memodo.de' })).toBe('A');
    expect(
      classifyContactChannelTier({
        email: 'info@refeel-epc.it',
        linkedinUrl: 'https://linkedin.com/in/mattia-masotti',
      }),
    ).toBe('B');
    expect(classifyContactChannelTier({ email: 'info@refeel-epc.it' })).toBe('C');
  });

  it('validates LinkedIn 3-sentence notes strictly (<=280 chars, no placeholders/URLs/PDFs/robotic openers)', () => {
    const playbook = buildLinkedInCoPilotPlaybook({
      firstName: 'Mattia',
      companyName: 'ReFeel EPC',
      sellerValueProp: '600-720W HJT bifacial modules with -0.24%/°C temp coeff',
      commonGroundHook: 'your ground-mount solar PM hiring post',
    });
    for (const note of Object.values(playbook.templates)) {
      expect(validateLinkedInConnectionNote(note).ok).toBe(true);
    }
    expect(playbook.pacingLimits.newAccountMaxPerDay).toBe(15);
    expect(playbook.pacingLimits.agedAccountMaxPerDay).toBe(25);

    expect(validateLinkedInConnectionNote('Hi [Name], check https://example.com for our PDF price list').violations).toEqual(
      expect.arrayContaining(['UNREPLACED_PLACEHOLDER', 'CONTAINS_URL', 'CONTAINS_ATTACHMENT_OR_PRICE_PITCH']),
    );
    expect(validateLinkedInConnectionNote('I would like to introduce our company').violations).toContain(
      'ROBOTIC_OPENER',
    );
  });

  it('generates concise multilingual Referral-First forwarding drafts for C-tier info@ fallback', () => {
    const de = buildReferralFirstInfoDraft({
      language: 'de',
      buyerCompanyName: 'Memodo GmbH',
      targetDepartmentLabel: 'Einkauf / Modulbeschaffung',
      sellerProductSummary: 'N-type HJT Solarmodule (600–720 W)',
      sellerLegalName: 'Liansheng PV Co., Ltd.',
    });
    expect(de.subject).toContain('Weiterleitungsbitte');
    expect(de.body).toContain('Memodo GmbH');

    const itDraft = buildReferralFirstInfoDraft({
      language: 'it',
      buyerCompanyName: 'ReFeel EPC',
      targetDepartmentLabel: 'Ufficio Acquisti Fotovoltaico',
      sellerProductSummary: 'moduli bifacciali HJT 600-720W',
      sellerLegalName: 'Liansheng PV Co., Ltd.',
    });
    expect(itDraft.subject).toContain('inoltro');
    expect(itDraft.body).toContain('ReFeel EPC');
  });
});
