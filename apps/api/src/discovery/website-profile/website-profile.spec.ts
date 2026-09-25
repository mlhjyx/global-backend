import { describe, expect, it } from 'vitest';
import {
  isValidGermanVat,
  parseImpressum,
} from './impressum';
import { matchCarriedBrands } from './brands';
import { classifyTradeRoleByRules } from './trade-role-rules';
import { scrubPii } from '../../site-builder/agents/pii';
import {
  MAX_ARTIFACT_PAGE_TEXT_CODE_POINTS,
  normalizeArtifactPageText,
} from '../../durable-results/artifact/artifact-page-text';

const IMPRESSUM = `
# Impressum

**Pumpen Handel GmbH**
Industriestraße 12
12345 Musterstadt

Geschäftsführer: Max Mustermann
Telefon: +49 30 1234567
E-Mail: info@pumpen-handel.example

Registergericht: Amtsgericht Charlottenburg (Berlin)
Registernummer: HRB 123456 B
Umsatzsteuer-Identifikationsnummer gemäß § 27a UStG: DE136695976
`;

describe('parseImpressum (G3 5.4)', () => {
  it('extracts the register court/number, a checksum-valid VAT id and the capital-company legal name', () => {
    expect(parseImpressum(IMPRESSUM)).toEqual({
      legalName: 'Pumpen Handel GmbH',
      register: {
        type: 'HRB',
        number: '123456 B',
        court: 'Charlottenburg (Berlin)',
        key: 'de-hrb:charlottenburg-berlin:123456b',
      },
      vatId: 'DE136695976',
    });
  });

  it('accepts register-first ordering and an AG legal form', () => {
    const text = 'Muster Pumpentechnik AG\nHRB 98765, Amtsgericht München\nUSt-IdNr.: DE 136695976';
    expect(parseImpressum(text)).toMatchObject({
      legalName: 'Muster Pumpentechnik AG',
      register: { type: 'HRB', number: '98765', court: 'München', key: 'de-hrb:muenchen:98765' },
      vatId: 'DE136695976',
    });
  });

  it('never returns a personal name: sole traders and person lines are rejected', () => {
    const text = 'Max Mustermann e.K.\nInhaber: Max Mustermann\nHRA 1234, Amtsgericht Köln';
    const parsed = parseImpressum(text);
    expect(parsed.legalName).toBeNull();
    expect(parsed.register).toMatchObject({ type: 'HRA', key: 'de-hra:koeln:1234' });
  });

  it('rejects checksum-invalid VAT ids and returns nulls for unrelated text', () => {
    expect(isValidGermanVat('DE136695976')).toBe(true);
    expect(isValidGermanVat('DE136695977')).toBe(false);
    expect(isValidGermanVat('DE12345678')).toBe(false);
    expect(parseImpressum('USt-IdNr.: DE136695977')).toMatchObject({ vatId: null });
    expect(parseImpressum('Willkommen bei uns')).toEqual({ legalName: null, register: null, vatId: null });
  });

  it('does not accept management/registry lines as the legal name', () => {
    const text = 'Geschäftsführer der Beispiel GmbH: Erika Musterfrau\nSitz der Gesellschaft: Hamburg';
    expect(parseImpressum(text).legalName).toBeNull();
  });
});

describe('artifact page text keeps company tax identifiers (G3 5.4)', () => {
  it('redacts phones and emails but keeps a DE VAT id, and leaves Site Builder scrubbing unchanged', () => {
    const raw = 'Tel. +49 30 1234567, info@x.example, USt-IdNr.: DE136695976 / DE 136695976';
    const artifact = normalizeArtifactPageText(raw);
    expect(artifact).toContain('[redacted-phone]');
    expect(artifact).toContain('[redacted-email]');
    expect(artifact).toContain('DE136695976');
    expect(artifact).toContain('DE 136695976');
    expect(scrubPii(raw)).not.toContain('DE136695976');
  });

  it('keeps pages far beyond the 20k evidence cap, bounded within the 300 kB artifact contract', () => {
    const long = 'Pumpen '.repeat(10_000);
    const normalized = normalizeArtifactPageText(long);
    expect(Array.from(normalized).length).toBeGreaterThan(20_000);
    const huge = normalizeArtifactPageText('€'.repeat(200_000));
    expect(Array.from(huge).length).toBe(MAX_ARTIFACT_PAGE_TEXT_CODE_POINTS);
    expect(Buffer.byteLength(huge, 'utf8')).toBeLessThanOrEqual(300_000);
  });
});

describe('matchCarriedBrands (G3 5.4)', () => {
  it('finds carried brands with their home country and flags Chinese/foreign brands', () => {
    const result = matchCarriedBrands(
      'Wir führen Pumpen von GRUNDFOS, Wilo, Leo Pumps und Pedrollo – ab Lager.',
      'de',
    );
    expect(result.brands.map((b) => b.name)).toEqual(['Grundfos', 'Wilo', 'Leo', 'Pedrollo']);
    expect(result.carriesChineseBrand).toBe(true);
    expect(result.carriesForeignBrand).toBe(true);
  });

  it('does not match brand names inside other words', () => {
    expect(matchCarriedBrands('Leonardo Sanitär, Dabei, Ksbx', 'de').brands).toEqual([]);
  });

  it('treats only home-country brands as not foreign', () => {
    const result = matchCarriedBrands('Vertrieb von KSB und Wilo Pumpen', 'de');
    expect(result.carriesForeignBrand).toBe(false);
    expect(result.carriesChineseBrand).toBe(false);
  });
});

describe('classifyTradeRoleByRules (G3 5.4)', () => {
  it('is decisive for a clear wholesaler', () => {
    const result = classifyTradeRoleByRules(
      'Ihr Pumpen-Großhandel. Wir sind autorisierter Händler und Vertriebspartner. Großes Lagerprogramm ab Lager, Online-Shop.',
    );
    expect(result).toMatchObject({ role: 'distributor', decisive: true });
  });

  it('is decisive for a clear manufacturer', () => {
    const result = classifyTradeRoleByRules(
      'Als Hersteller entwickeln und fertigen wir Pumpen. Eigene Fertigung und Produktion in Deutschland. Made in Germany.',
    );
    expect(result).toMatchObject({ role: 'manufacturer', decisive: true });
  });

  it('is not decisive for mixed or thin evidence (the model decides)', () => {
    expect(classifyTradeRoleByRules('Hersteller und Händler von Pumpen').decisive).toBe(false);
    expect(classifyTradeRoleByRules('Willkommen').decisive).toBe(false);
  });
});

describe('parseImpressum legal-name boundaries', () => {
  it('keeps company names that merely contain excluded fragments', () => {
    expect(parseImpressum('Muster Steuerungstechnik GmbH\nHRB 1').legalName).toBe('Muster Steuerungstechnik GmbH');
  });
});
