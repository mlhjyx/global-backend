import { describe, expect, it } from 'vitest';
import {
  canonicalizeSuppressionValue,
  canonicalizeSuppressionValues,
  companyMatchesSuppression,
} from './suppression-value';

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
    expect(companyMatchesSuppression(
      [{ type: 'domain', value: ' HTTPS://WWW.EXAMPLE.COM/path ' }],
      { domain: 'example.com', name: 'Different Co' },
    )).toBe(true);
  });

  it.each([
    // A source that changes URL presentation must not bypass a stored ASCII domain suppression.
    ['domain', 'example.com', 'example.com'],
    ['domain', ' HTTPS://WWW.Example.COM./directory ', 'example.com'],
    // IP, malformed, and unbounded domains must fail closed rather than become matching keys.
    ['domain', '999.999.999.999', null],
    ['domain', 'https://[2001:db8::1]/', null],
    ['domain', `${'a'.repeat(64)}.example.com`, null],
    // NFC and whitespace normalization must produce exactly one stored company-name key.
    ['company_name', '  A\u0308cme\tGmbH  ', 'äcme gmbh'],
  ])('keeps literal SQL-parity suppression value %s %j', (type, raw, expected) => {
    expect(canonicalizeSuppressionValue(type, raw)).toBe(expected);
  });

  it('fails closed for legacy noncanonical company domains instead of treating raw stored text as a key', () => {
    expect(
      companyMatchesSuppression(
        [{ type: 'domain', value: 'not a canonical domain' }],
        { domain: 'example.com', name: 'Acme GmbH' },
      ),
    ).toBe(false);
  });
});
