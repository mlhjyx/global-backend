import { describe, expect, it } from 'vitest';
import { canonicalizeSuppressionValue } from '../discovery/suppression-value';
import { evaluateMultiChannelOutreachPolicy, isUkCorporateSubscriber } from './multi-channel-playbook';

describe('D3 Multi-Channel Jurisdiction Outreach Policy', () => {
  it('enforces CONSENT_REQUIRED for CA, AE, and SA', () => {
    for (const cc of ['CA', 'AE', 'SA']) {
      const decision = evaluateMultiChannelOutreachPolicy({
        country: cc,
        companyName: 'Desert Solar Trading LLC',
        isPersonalEmail: true,
      });
      expect(decision.emailPolicy).toBe('CONSENT_REQUIRED');
      expect(decision.emailAllowedNow).toBe(false);
      expect(decision.manualLinkedInAllowed).toBe(true);
      expect(decision.manualOutboundWhatsappAllowed).toBe(false);
    }
  });

  it('applies UK PECR corporate subscriber gate (Ltd/PLC/LLP vs sole trader)', () => {
    expect(isUkCorporateSubscriber('SunGrid Energy Ltd')).toBe(true);
    expect(isUkCorporateSubscriber('John Smith Solar Installations')).toBe(false);

    const corp = evaluateMultiChannelOutreachPolicy({
      country: 'GB',
      companyName: 'SunGrid Energy Ltd',
      isPersonalEmail: true,
    });
    expect(corp.ukCorporateSubscriberVerified).toBe(true);
    expect(corp.emailAllowedNow).toBe(true);
    expect(corp.requiresArticle14Notice).toBe(true);

    const sole = evaluateMultiChannelOutreachPolicy({
      country: 'GB',
      companyName: 'John Smith Solar Installations',
      isPersonalEmail: true,
    });
    expect(sole.ukCorporateSubscriberVerified).toBe(false);
    expect(sole.emailPolicy).toBe('CONSENT_REQUIRED');
    expect(sole.emailAllowedNow).toBe(false);
  });

  it('blocks outbound WhatsApp in DE/IT/US and requires Art.14 + LIA in EU', () => {
    const de = evaluateMultiChannelOutreachPolicy({
      country: 'DE',
      companyName: 'Memodo GmbH',
      isPersonalEmail: true,
      publicBusinessWhatsappUrl: 'https://wa.me/49891234567',
    });
    expect(de.emailPolicy).toBe('CONSENT_REQUIRED');
    expect(de.requiresArticle14Notice).toBe(true);
    expect(de.requiresLiaRecord).toBe(true);
    expect(de.manualOutboundWhatsappAllowed).toBe(false);
    expect(de.recommendedSequence[0]).toBe('linkedin_copilot');

    const itBuyer = evaluateMultiChannelOutreachPolicy({
      country: 'IT',
      companyName: 'ReFeel EPC S.r.l.',
      isPersonalEmail: true,
    });
    expect(itBuyer.emailPolicy).toBe('LEGITIMATE_INTEREST_STRICT');
    expect(itBuyer.requiresArticle14Notice).toBe(true);
    expect(itBuyer.manualOutboundWhatsappAllowed).toBe(false);
  });

  it('allows 4-guardrail manual WhatsApp in BR only with public wa.me and no phone/whatsapp suppression', () => {
    const allowed = evaluateMultiChannelOutreachPolicy({
      country: 'BR',
      companyName: 'Aldo Solar Ltda',
      isPersonalEmail: true,
      publicBusinessWhatsappUrl: 'https://wa.me/554432612000',
    });
    expect(allowed.manualOutboundWhatsappAllowed).toBe(true);

    const suppressedPhone = canonicalizeSuppressionValue('whatsapp', 'https://wa.me/554432612000')!;
    expect(suppressedPhone).toBe('+554432612000');
    const blocked = evaluateMultiChannelOutreachPolicy({
      country: 'BR',
      companyName: 'Aldo Solar Ltda',
      isPersonalEmail: true,
      publicBusinessWhatsappUrl: 'https://wa.me/554432612000',
      suppressedPhones: new Set([suppressedPhone]),
    });
    expect(blocked.manualOutboundWhatsappAllowed).toBe(false);
    expect(blocked.outboundWhatsappBlockedReason).toBe('PHONE_OR_WHATSAPP_SUPPRESSED');
  });
});
