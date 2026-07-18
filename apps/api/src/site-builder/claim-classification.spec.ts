import { describe, expect, it } from 'vitest';
import { isCertificationClaim } from './claim-classification';

describe('isCertificationClaim', () => {
  it.each([
    { key: 'capability', value: 'We reach customers in 50 countries' },
    { key: 'export_markets', value: 'Reach global buyers' },
    { key: 'capability', value: 'Our services reach Europe' },
  ])('does not classify the ordinary verb reach as certification', (input) => {
    expect(isCertificationClaim(input)).toBe(false);
  });

  it.each([
    { key: 'environmental_compliance', value: 'REACH compliant' },
    { key: 'standard', value: 'Compliant with the REACH regulation' },
    { key: 'certification', value: 'REACH' },
  ])('keeps the EU REACH mark in an explicit compliance context', (input) => {
    expect(isCertificationClaim(input)).toBe(true);
  });
});
