import { describe, expect, it } from 'vitest';
import { canonicalizeSuppressionValue, canonicalizeSuppressionValues } from './suppression-value';

describe('canonicalizeSuppressionValue', () => {
  it('canonicalizes safe equivalent values to one matching key', () => {
    expect(canonicalizeSuppressionValue('email', ' Sales@EXAMPLE.COM ')).toBe('sales@example.com');
    expect(canonicalizeSuppressionValue('domain', 'https://www.Example.COM./path')).toBe('example.com');
    expect(canonicalizeSuppressionValue('company_name', '  ACME\t GmbH  ')).toBe('acme gmbh');
  });

  it.each([
    ['domain', '127.0.0.1'],
    ['domain', 'https://[::1]/'],
    ['email', 'person@-bad.example'],
    ['email', '.person@example.com'],
    ['email', 'person..alias@example.com'],
    ['email', `${'a'.repeat(2049)}@example.com`],
    ['company_name', `ACME\u0000GmbH`],
    ['company_name', 'x'.repeat(2049)],
  ])('rejects unsafe or unbounded %s value before persistence', (type, value) => {
    expect(canonicalizeSuppressionValue(type, value)).toBeNull();
  });

  it('canonicalizes legacy stored rows with the same keys used for new candidates', () => {
    expect(canonicalizeSuppressionValues('email', [' SALES@Example.com ', 'invalid'])).toEqual(
      new Set(['sales@example.com']),
    );
    expect(canonicalizeSuppressionValues('domain', ['https://www.Example.com/path'])).toEqual(
      new Set(['example.com']),
    );
    expect(canonicalizeSuppressionValues('company_name', ['  ACME   GmbH '])).toEqual(
      new Set(['acme gmbh']),
    );
  });
});
