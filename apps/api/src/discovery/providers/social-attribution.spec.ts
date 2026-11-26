import { describe, expect, it } from 'vitest';
import { scoreSocialAttribution } from './social-attribution';

describe('Fellegi-Sunter v1 social attribution (social-attribution.ts)', () => {
  it('holds a profile when its only mention of the target company is previous employment', () => {
    const company = { name: 'Valleverde Components', domain: 'valleverde.example', country: 'IT' };
    const hit = {
      url: 'https://www.linkedin.com/in/alex-fixture',
      title: 'Alex Fixture - Procurement Director at Altacrest | LinkedIn',
    };
    const previous = scoreSocialAttribution({
      ...hit,
      snippet: 'Former Procurement Director at Valleverde Components.',
    }, company);
    const current = scoreSocialAttribution({
      ...hit,
      title: 'Alex Fixture - Procurement Director at Valleverde Components | LinkedIn',
      snippet: 'Previously held a procurement role at Altacrest.',
    }, company);
    const previousHeadline = scoreSocialAttribution({
      ...hit,
      title: 'Alex Fixture - Former Procurement Director at Valleverde Components | LinkedIn',
    }, company);
    const currentWithOtherHistory = scoreSocialAttribution({
      ...hit,
      title: 'Alex Fixture | LinkedIn',
      snippet: 'Procurement Director at Valleverde Components, previously at Altacrest.',
    }, company);

    expect(previous.decision).toBe('REVIEW');
    expect(current.decision).toBe('ACCEPTED');
    expect(previousHeadline.decision).toBe('REVIEW');
    expect(currentWithOtherHistory.decision).toBe('ACCEPTED');
  });

  it('accepts Novacrest /in/miralevinnovacrest via URL slug residual + role evidence (>= 0.75)', () => {
    const res = scoreSocialAttribution(
      {
        url: 'https://it.linkedin.com/in/miralevinnovacrest',
        title: 'Mira Levin - Responsabile Commerciale | LinkedIn',
      },
      { name: 'Novacrest S.r.l.', domain: 'novacrest.example', country: 'IT' },
    );

    expect(res.decision).toBe('ACCEPTED');
    expect(res.score).toBeGreaterThanOrEqual(0.75);
    expect(res.fullName).toBe('Mira Levin');
    expect(res.matchedFeatures).toContain('slug_company_distinctive');
  });

  it('accepts Novacrest /in/miralevinnovacrest when role is provided in snippet/highlights (>= 0.75)', () => {
    const res = scoreSocialAttribution(
      {
        url: 'https://it.linkedin.com/in/miralevinnovacrest',
        title: 'Mira Levin | LinkedIn',
        snippet: 'Direttore Commerciale — fotovoltaico B2B',
      },
      { name: 'Novacrest S.r.l.', domain: 'novacrest.example', country: 'IT' },
    );

    expect(res.decision).toBe('ACCEPTED');
    expect(res.score).toBeGreaterThanOrEqual(0.75);
    expect(res.matchedFeatures).toContain('role_context');
  });

  it('accepts Tavia Energy /in/kieran-nolan-bbb26167 via snippet/highlights company + role (>= 0.75)', () => {
    const res = scoreSocialAttribution(
      {
        url: 'https://it.linkedin.com/in/kieran-nolan-bbb26167',
        title: 'Kieran Nolan | LinkedIn',
        snippet: 'Purchasing Manager at Tavia Energy S.r.l. (2020-2026)',
        highlights: ['Responsible for PV module procurement at Tavia Energy'],
      },
      { name: 'Tavia Energy S.r.l.', domain: 'taviaenergy.example', country: 'IT' },
    );

    expect(res.decision).toBe('ACCEPTED');
    expect(res.score).toBeGreaterThanOrEqual(0.75);
    expect(res.fullName).toBe('Kieran Nolan');
    expect(res.matchedFeatures).toContain('context_company_distinctive');
    expect(res.matchedFeatures).toContain('company_phrase_match');
  });

  it('rejects true namesake passersby and generic-company collisions (< 0.45)', () => {
    const namesake = scoreSocialAttribution(
      {
        url: 'https://www.linkedin.com/in/leo-valmont',
        title: 'Leo Valmont – Harborpoint Engineering College | LinkedIn',
      },
      { name: 'Valmont', domain: 'valmont.example', country: 'DE' },
    );
    expect(namesake.decision).toBe('REJECTED');
    expect(namesake.score).toBeLessThan(0.45);
    expect(namesake.dropReason).toBe('namesake');

    const differentEmployer = scoreSocialAttribution(
      {
        url: 'https://www.linkedin.com/in/kieran-nolan-other',
        title: 'Kieran Nolan - Purchasing Manager - Energy Solutions Corp | LinkedIn',
      },
      { name: 'Tavia Energy S.r.l.', domain: 'taviaenergy.example', country: 'IT' },
    );
    expect(differentEmployer.decision).toBe('REJECTED');
    expect(differentEmployer.score).toBeLessThan(0.45);
    expect(differentEmployer.dropReason).toBe('namesake');

    const redlineTechnical = scoreSocialAttribution(
      {
        url: 'https://www.linkedin.com/in/mira-levin-redline',
        title: 'Mira Levin - Technical Manager - Redline Technical | LinkedIn',
      },
      { name: 'Technical', domain: 'technical.de', country: 'DE' },
    );
    expect(redlineTechnical.decision).toBe('REJECTED');
    expect(redlineTechnical.score).toBeLessThan(0.45);
    expect(redlineTechnical.dropReason).toBe('generic_name');
  });

  it('rejects organization profiles and company-only headlines without role evidence (< 0.45)', () => {
    const org = scoreSocialAttribution(
      {
        url: 'https://www.linkedin.com/in/bts-org',
        title: 'BTS Engineering Consultants (Projects, Training) | LinkedIn',
      },
      { name: 'BTS Engineering', domain: 'bts.example' },
    );
    expect(org.decision).toBe('REJECTED');
    expect(org.score).toBeLessThan(0.45);
    expect(org.dropReason).toBe('organisation');

    const roleFree = scoreSocialAttribution(
      {
        url: 'https://www.linkedin.com/in/jane-doe-valmont',
        title: 'Jane Doe - Valmont | LinkedIn',
      },
      { name: 'Valmont', domain: 'valmont.example' },
    );
    expect(roleFree.decision).toBe('REJECTED');
    expect(roleFree.score).toBeLessThan(0.45);
    expect(roleFree.dropReason).toBe('uninformative');
  });
});
