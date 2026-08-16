import { describe, expect, it } from 'vitest';
import { worldBankBusinessEvidenceMatches } from './world-bank-keyword-match';

describe('World Bank business evidence keyword matching', () => {
  it('matches exact business tokens and conservative singular/plural variants', () => {
    expect(worldBankBusinessEvidenceMatches({ title: 'Industrial pumps' }, ['pump'])).toBe(true);
    expect(worldBankBusinessEvidenceMatches({ title: 'Maintenance service' }, ['services'])).toBe(true);
    expect(worldBankBusinessEvidenceMatches({ title: 'Battery supplies' }, ['battery'])).toBe(true);
  });

  it('does not treat stop words or overly short tokens as business evidence', () => {
    expect(worldBankBusinessEvidenceMatches(
      { organizationName: 'Roads Authority', title: 'Construction of bridge' },
      ['supply of water pumps'],
    )).toBe(false);
    expect(worldBankBusinessEvidenceMatches({ title: 'AI platform' }, ['AI'])).toBe(false);
  });

  it('does not invent a singular by stripping s from non-plural words', () => {
    expect(worldBankBusinessEvidenceMatches({ title: 'analysi' }, ['analysis'])).toBe(false);
    expect(worldBankBusinessEvidenceMatches({ title: 'busines' }, ['business'])).toBe(false);
  });
});
