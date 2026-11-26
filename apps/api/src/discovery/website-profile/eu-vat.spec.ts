import { describe, expect, it } from 'vitest';
import {
  VIES_PUBLIC_NAME_REDACTED_COUNTRIES,
  extractEuVat,
  isValidEuVat,
  isValidGermanVat,
  isValidItalianVat,
  normalizeEuVat,
  splitViesVat,
} from './eu-vat';

describe('EU VAT validation and extraction (eu-vat)', () => {
  it('validates all 7 real Italian solar buyer P.IVA numbers and rejects bad checksums and all-zeros', () => {
    for (const vat of [
      'IT04553650989', // Effe Energy
      'IT02053810517', // Italsol
      'IT03899910925', // Solarplace
      'IT00204910426', // IMAC
      'IT05503370289', // Gruppo HVC
      'IT02390660039', // AEG Market
      'IT02626290304', // Solarstock
    ]) {
      expect(isValidItalianVat(vat), vat).toBe(true);
      expect(isValidEuVat(vat), vat).toBe(true);
    }

    expect(isValidItalianVat('IT00000000000')).toBe(false);
    expect(isValidItalianVat('IT04553650988')).toBe(false);
    expect(isValidItalianVat('IT0455365098')).toBe(false);
    expect(isValidItalianVat('IT045536509890')).toBe(false);
    expect(isValidEuVat('IT00000000000')).toBe(false);
    expect(isValidEuVat('IT 04553650989')).toBe(false);
    expect(isValidEuVat('it04553650989')).toBe(false);
  });

  it('validates DE, FR, BE, NL, PL checksums and AT, ES, EL/GR, XI formats', () => {
    expect(isValidGermanVat('DE136695976')).toBe(true);
    expect(isValidGermanVat('DE252368289')).toBe(true);
    expect(isValidGermanVat('DE311761178')).toBe(true);
    expect(isValidGermanVat('DE136695977')).toBe(false);
    expect(isValidEuVat('DE252368289')).toBe(true);
    expect(isValidEuVat('DE252368280')).toBe(false);

    // FR: SIREN 732829320 -> (12 + 3 * (732829320 % 97)) % 97 = 44
    expect(isValidEuVat('FR44732829320')).toBe(true);
    expect(isValidEuVat('FR45732829320')).toBe(false);
    expect(isValidEuVat('FRXX732829320')).toBe(true);
    expect(isValidEuVat('FROO732829320')).toBe(false);

    // BE: 04030192 -> 97 - (4030192 % 97) = 61
    expect(isValidEuVat('BE0403019261')).toBe(true);
    expect(isValidEuVat('BE0403019262')).toBe(false);

    // NL: old 11-proef (004495445B01) and 2020 mod 97
    expect(isValidEuVat('NL004495445B01')).toBe(true);
    expect(isValidEuVat('NL004495446B01')).toBe(false);
    expect(isValidEuVat('NL000099998B57')).toBe(true); // 2020 mod 97 valid

    // PL: 5260001246 -> weights [6,5,7,2,3,4,5,6,7] -> check 6
    expect(isValidEuVat('PL5260001246')).toBe(true);
    expect(isValidEuVat('PL5260001247')).toBe(false);

    // AT / ES / EL / GR / XI / remaining EU
    expect(isValidEuVat('ATU64332109')).toBe(true);
    expect(isValidEuVat('ESB12345678')).toBe(true);
    expect(isValidEuVat('EL094014201')).toBe(true);
    expect(isValidEuVat('GR094014201')).toBe(true);
    expect(isValidEuVat('XI123456789')).toBe(true);
    expect(isValidEuVat('PT502011478')).toBe(true);
    expect(isValidEuVat('SE556036079301')).toBe(true);
    expect(isValidEuVat('XX123456789')).toBe(false);
    expect(isValidEuVat('EL000000000')).toBe(false);
  });

  it('normalizes Greece GR -> EL and splits VIES vatId with ISO country GR', () => {
    expect(normalizeEuVat('gr 094.014.201')).toBe('EL094014201');
    expect(splitViesVat('GR094014201')).toEqual({
      countryCode: 'EL',
      vatNumber: '094014201',
      isoCountry: 'GR',
      vatId: 'EL094014201',
    });
    expect(splitViesVat('IT04553650989')).toEqual({
      countryCode: 'IT',
      vatNumber: '04553650989',
      isoCountry: 'IT',
      vatId: 'IT04553650989',
    });
    expect(splitViesVat('XI123456789')).toEqual({
      countryCode: 'XI',
      vatNumber: '123456789',
      isoCountry: 'GB',
      vatId: 'XI123456789',
    });
    expect(splitViesVat('IT00000000000')).toBeNull();
    expect(VIES_PUBLIC_NAME_REDACTED_COUNTRIES.has('DE')).toBe(true);
  });

  it('extracts JSON-LD vatID, labeled EU VATs, and prefix-less Italian P.IVA with IT clue', () => {
    expect(
      extractEuVat('{"@type":"Organization","vatID":"IT05503370289"}'),
    ).toBe('IT05503370289');

    expect(
      extractEuVat('P.IVA IT02390660039 - AEG Market', { domain: 'aegmarket.com' }),
    ).toBe('IT02390660039');

    expect(
      extractEuVat('© 2026 Effe Energy S.r.l. - P.IVA e C.F. 04553650989', {
        domain: 'effeenergy.it',
      }),
    ).toBe('IT04553650989');

    expect(
      extractEuVat('P. Iva e C.F. 02053810517', { domain: 'italsolsrl.it' }),
    ).toBe('IT02053810517');

    expect(
      extractEuVat('Solarplace S.r.l. - P.IVA 03899910925', {
        domain: 'solarplace.net',
      }),
    ).toBe('IT03899910925');

    expect(
      extractEuVat('P.IVA/C.F. 02626290304', { countryHint: 'it' }),
    ).toBe('IT02626290304');

    expect(
      extractEuVat('Partita IVA: 00204910426', { domain: 'imac-srl.it' }),
    ).toBe('IT00204910426');

    expect(
      extractEuVat('TVA intracommunautaire : FR 44 732829320', { domain: 'example.fr' }),
    ).toBe('FR44732829320');

    expect(
      extractEuVat('VAT ID: GR 094014201', { domain: 'example.gr' }),
    ).toBe('EL094014201');
  });

  it('never guesses unlabeled 11-digit numbers or prefix-less P.IVA without Italian clue', () => {
    expect(
      extractEuVat('Order number 04553650989 shipped today', {
        domain: 'effeenergy.it',
        countryHint: 'IT',
      }),
    ).toBeUndefined();

    expect(
      extractEuVat('Tel: 04553650989', { domain: 'effeenergy.it', countryHint: 'IT' }),
    ).toBeUndefined();

    // No IT domain, no IT countryHint, no IT legal form/address
    expect(
      extractEuVat('P.IVA 04553650989', { domain: 'global-site.com' }),
    ).toBeUndefined();
  });
});
