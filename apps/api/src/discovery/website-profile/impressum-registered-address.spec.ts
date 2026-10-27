import { describe, expect, it } from 'vitest';
import { parseImpressum } from './impressum';

/**
 * BI-15 / 交付闭环设计 §0、§5、L6：从 Impressum 抽公司注册地址（寄信或样册用）。
 * 只存公司事实；独资商号（无资本形式、e.K. 等个人商号）一律不存，避免把个人住址当公司事实。
 */
describe('parseImpressum — registered address (L6)', () => {
  const company = 'Muster Pumpentechnik GmbH\nSitz der Gesellschaft: Musterstraße 1, 12345 Musterstadt\nHRB 98765, Amtsgericht München';

  it('reads the address after the usual German labels', () => {
    for (const label of [
      'Sitz der Gesellschaft',
      'Sitz',
      'Firmensitz',
      'Hauptsitz',
      'Anschrift',
      'Adresse',
      'Postanschrift',
    ]) {
      expect(parseImpressum(`${company.split('\n')[0]}\n${label}: Musterstraße 1, 12345 Musterstadt`).registeredAddress).toBe(
        'Musterstraße 1, 12345 Musterstadt',
      );
    }
  });

  it('reads the address from the line after a label that ends with a colon', () => {
    const text = 'Muster Pumpentechnik GmbH\nAnschrift:\nMusterstraße 1\n12345 Musterstadt';
    expect(parseImpressum(text).registeredAddress).toBe('Musterstraße 1, 12345 Musterstadt');
  });

  it('never stores an address for a sole trader (no capital form)', () => {
    const text = 'Max Mustermann e.K.\nInhaber: Max Mustermann\nSitz: Musterstraße 1, 12345 Musterstadt';
    expect(parseImpressum(text).registeredAddress).toBeNull();
  });

  it('drops candidate lines about people, contact details or without a postal code', () => {
    const gmbh = 'Muster Pumpentechnik GmbH\n';
    expect(parseImpressum(`${gmbh}Geschäftsführer: Erika Musterfrau, Musterstraße 1, 12345 Musterstadt`).registeredAddress).toBeNull();
    expect(parseImpressum(`${gmbh}Anschrift: Musterstraße 1, 12345 Musterstadt, info@example.de`).registeredAddress).toBeNull();
    expect(parseImpressum(`${gmbh}Anschrift: Musterstraße 1, Musterstadt`).registeredAddress).toBeNull();
    expect(parseImpressum(`${gmbh}Anschrift: Tel. 030 1234567, Musterstraße 1, 12345 Musterstadt`).registeredAddress).toBeNull();
  });

  it('returns null for unrelated text and keeps the existing identifiers working', () => {
    expect(parseImpressum('Willkommen bei uns').registeredAddress).toBeNull();
    const parsed = parseImpressum(company);
    expect(parsed).toMatchObject({
      legalName: 'Muster Pumpentechnik GmbH',
      register: { type: 'HRB', number: '98765', court: 'München' },
      registeredAddress: 'Musterstraße 1, 12345 Musterstadt',
    });
  });
});
