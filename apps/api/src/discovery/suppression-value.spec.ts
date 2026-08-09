import { describe, expect, it } from 'vitest';
import { canonicalizeSuppressionValue } from './suppression-value';

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
    ['email', `${'a'.repeat(2049)}@example.com`],
    ['company_name', `ACME\u0000GmbH`],
    ['company_name', 'x'.repeat(2049)],
  ])('rejects unsafe or unbounded %s value before persistence', (type, value) => {
    expect(canonicalizeSuppressionValue(type, value)).toBeNull();
  });
});
