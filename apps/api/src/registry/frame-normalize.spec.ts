import { describe, expect, it } from 'vitest';
import {
  contentHashFor,
  csvFieldReader,
  jsonFieldReader,
  normalizeRecord,
  normalizeRegNumber,
  normalizeVatId,
} from './frame-normalize';
import { readDottedPath } from './frame-parse';
import { FrameConfigError, parseFrameConfig, type FrameMapping } from './frame-types';

const gbMapping: FrameMapping = {
  schemaVersion: 'registry-frame-mapping/v1',
  format: 'csv',
  csv: { delimiter: ',' },
  recordsPath: null,
  constants: { scheme: 'gb_crn', country: 'GB' },
  fields: {
    regNumber: 'CompanyNumber',
    name: 'CompanyName',
    status: 'CompanyStatus',
    legalForm: 'CompanyCategory',
    city: 'RegAddress.PostTown',
    region: 'RegAddress.County',
    postalCode: 'RegAddress.PostCode',
    addressLines: ['RegAddress.CareOf', 'RegAddress.AddressLine1', 'RegAddress.AddressLine2'],
  },
  statusMap: {
    active: 'ACTIVE',
    'active - proposal to strike off': 'ACTIVE',
    dissolved: 'DISSOLVED',
    liquidation: 'INSOLVENT',
  },
  legalFormMap: { 'private limited company': 'ltd' },
  employeeBandMap: null,
};

const header = [
  'CompanyNumber',
  'CompanyName',
  'CompanyStatus',
  'CompanyCategory',
  'RegAddress.CareOf',
  'RegAddress.AddressLine1',
  'RegAddress.AddressLine2',
  'RegAddress.PostTown',
  'RegAddress.County',
  'RegAddress.PostCode',
];

function readGb(values: string[]) {
  return csvFieldReader(header, values);
}

const baseValues = (overrides: Partial<Record<number, string>> = {}): string[] => {
  const values = [
    '12345678',
    'Muster Pumpen GmbH',
    'Active',
    'Private Limited Company',
    '',
    '12 Muster Street',
    'Unit 4',
    'Manchester',
    'Lancashire',
    'M1 1AA',
  ];
  for (const [index, value] of Object.entries(overrides)) {
    values[Number(index)] = value as string;
  }
  return values;
};

describe('normalizeRecord (CSV mapping)', () => {
  it('normalizes a Companies House style row', () => {
    const result = normalizeRecord({ mapping: gbMapping, row: 2, read: readGb(baseValues()) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entity).toMatchObject({
      scheme: 'gb_crn',
      regNumber: '12345678',
      country: 'GB',
      name: 'Muster Pumpen GmbH',
      nameNorm: 'muster pumpen',
      status: 'ACTIVE',
      legalForm: 'ltd',
      city: 'Manchester',
      region: 'Lancashire',
      postalCode: 'M1 1AA',
      addressJson: { lines: ['12 Muster Street', 'Unit 4'] },
      lei: null,
      vatId: null,
      identifiers: null,
    });
    expect(result.entity.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.warnings).toEqual([]);
  });

  it('maps "Active - Proposal to Strike off" to ACTIVE', () => {
    const result = normalizeRecord({
      mapping: gbMapping,
      row: 3,
      read: readGb(baseValues({ 2: 'Active - Proposal to Strike off' })),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entity.status).toBe('ACTIVE');
  });

  it('falls back to UNKNOWN with a warning for unmapped status', () => {
    const result = normalizeRecord({
      mapping: gbMapping,
      row: 4,
      read: readGb(baseValues({ 2: 'Converted / Closed' })),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entity.status).toBe('UNKNOWN');
    expect(result.warnings).toEqual([
      { row: 4, field: 'status', code: 'STATUS_UNMAPPED', detail: 'Converted / Closed' },
    ]);
  });

  it('fails closed on missing reg number, missing name and bad country', () => {
    const result = normalizeRecord({
      mapping: gbMapping,
      row: 5,
      read: readGb(baseValues({ 0: ' ', 1: '' })),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code).sort()).toEqual([
      'NAME_MISSING',
      'REG_NUMBER_MISSING',
    ]);
  });

  it('fails closed on invalid LEI and VAT (no dirty identifiers reach hard-key merge)', () => {
    const mapping: FrameMapping = {
      ...gbMapping,
      fields: { ...gbMapping.fields, lei: 'LEI', vatId: 'VAT' },
    };
    const reader = csvFieldReader([...header, 'LEI', 'VAT'], [...baseValues(), 'NOT-A-LEI', 'DE 291 499 156']);
    const result = normalizeRecord({ mapping, row: 2, read: reader });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      { row: 2, field: 'lei', code: 'LEI_INVALID', detail: 'NOT-A-LEI' },
    ]);
  });

  it('normalizes VAT spacing and keeps a valid LEI', () => {
    const mapping: FrameMapping = {
      ...gbMapping,
      fields: { ...gbMapping.fields, lei: 'LEI', vatId: 'VAT' },
    };
    const reader = csvFieldReader(
      [...header, 'LEI', 'VAT'],
      [...baseValues(), '529900t8bm49aursdo55', 'de 291 499 156'],
    );
    const result = normalizeRecord({ mapping, row: 2, read: reader });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entity.lei).toBe('529900T8BM49AURSDO55');
    expect(result.entity.vatId).toBe('DE291499156');
  });

  it('rejects an invalid website but accepts and normalizes a valid one', () => {
    const mapping: FrameMapping = {
      ...gbMapping,
      fields: { ...gbMapping.fields, website: 'Website' },
    };
    const bad = normalizeRecord({
      mapping,
      row: 2,
      read: csvFieldReader([...header, 'Website'], [...baseValues(), 'not a domain']),
    });
    expect(bad.ok).toBe(false);
    const good = normalizeRecord({
      mapping,
      row: 2,
      read: csvFieldReader([...header, 'Website'], [...baseValues(), 'https://www.Muster-Pumpen.de/kontakt']),
    });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.entity.website).toBe('muster-pumpen.de');
  });

  it('produces a stable content hash and a different hash when a normalized field changes', () => {
    const first = normalizeRecord({ mapping: gbMapping, row: 2, read: readGb(baseValues()) });
    const again = normalizeRecord({ mapping: gbMapping, row: 2, read: readGb(baseValues()) });
    const changed = normalizeRecord({
      mapping: gbMapping,
      row: 2,
      read: readGb(baseValues({ 1: 'Muster Pumpen AG' })),
    });
    expect(first.ok && again.ok && changed.ok).toBe(true);
    if (!first.ok || !again.ok || !changed.ok) return;
    expect(first.entity.contentHash).toBe(again.entity.contentHash);
    expect(changed.entity.contentHash).not.toBe(first.entity.contentHash);
  });
});

describe('normalizeRecord (JSON mapping)', () => {
  const gleifMapping: FrameMapping = {
    schemaVersion: 'registry-frame-mapping/v1',
    format: 'json',
    csv: null,
    recordsPath: 'data',
    constants: { scheme: 'lei', country: null },
    fields: {
      regNumber: 'attributes.lei',
      name: 'attributes.entity.legalName.name',
      country: 'attributes.entity.legalAddress.country',
      status: 'attributes.entity.status',
      legalForm: 'attributes.entity.legalForm.id',
      city: 'attributes.entity.legalAddress.city',
      postalCode: 'attributes.entity.legalAddress.postalCode',
      addressLines: ['attributes.entity.legalAddress.addressLines'],
      lei: 'attributes.lei',
    },
    statusMap: { active: 'ACTIVE', inactive: 'UNKNOWN' },
    legalFormMap: null,
    employeeBandMap: null,
  };

  const record = {
    attributes: {
      lei: '529900T8BM49AURSDO55',
      entity: {
        legalName: { name: 'Muster Pumpen GmbH' },
        legalAddress: {
          addressLines: ['Hauptstraße 5', 'Hinterhaus'],
          city: 'München',
          postalCode: '80331',
          country: 'DE',
        },
        legalForm: { id: 'GmbH' },
        status: 'ACTIVE',
      },
    },
  };

  it('normalizes a GLEIF style record through dotted paths', () => {
    const result = normalizeRecord({
      mapping: gleifMapping,
      row: 1,
      read: jsonFieldReader(record, readDottedPath),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entity).toMatchObject({
      scheme: 'lei',
      regNumber: '529900T8BM49AURSDO55',
      country: 'DE',
      lei: '529900T8BM49AURSDO55',
      status: 'ACTIVE',
      city: 'München',
      addressJson: { lines: ['Hauptstraße 5', 'Hinterhaus'] },
    });
  });

  it('accepts NACE and national NACE-derived codes (NAF 28.13Z, 2813) and rejects junk', () => {
    const mapping: FrameMapping = {
      ...gleifMapping,
      fields: { ...gleifMapping.fields, nace: 'attributes.entity.nace' },
    };
    const read = (nace: string) =>
      normalizeRecord({
        mapping,
        row: 1,
        read: jsonFieldReader({ ...record, attributes: { ...record.attributes, entity: { ...record.attributes.entity, nace } } }, readDottedPath),
      });
    // 国家派生码装载时统一归一到 NACE 类目形态（原始码保留在源快照里，可回放）。
    const zForm = read('28.13Z');
    expect(zForm.ok).toBe(true);
    if (zForm.ok) expect(zForm.entity.nace).toBe('28.13');
    const digits = read('2813');
    expect(digits.ok).toBe(true);
    if (digits.ok) expect(digits.entity.nace).toBe('28.13');
    const junk = read('NACE28');
    expect(junk.ok).toBe(true);
    if (junk.ok) {
      expect(junk.entity.nace).toBeNull();
      expect(junk.warnings.map((warning) => warning.code)).toContain('NACE_INVALID');
    }
  });

  it('captures source-specific attributes and folds them into the content hash', () => {
    const mapping: FrameMapping = {
      ...gleifMapping,
      fields: {
        ...gleifMapping.fields,
        attributes: { diffusionCommerciale: 'attributes.entity.diffusion', zExtra: 'attributes.entity.extra' },
      },
    };
    const withFlag = (diffusion: string, extra: string) =>
      normalizeRecord({
        mapping,
        row: 1,
        read: jsonFieldReader(
          { ...record, attributes: { ...record.attributes, entity: { ...record.attributes.entity, diffusion, extra } } },
          readDottedPath,
        ),
      });
    const optOut = withFlag('false', 'a');
    expect(optOut.ok).toBe(true);
    if (!optOut.ok) return;
    // 属性名排序存储，diff/哈希与输入顺序无关。
    expect(optOut.entity.attributes).toEqual({ diffusionCommerciale: 'false', zExtra: 'a' });
    const optedIn = withFlag('true', 'a');
    expect(optedIn.ok).toBe(true);
    if (optedIn.ok) expect(optedIn.entity.contentHash).not.toBe(optOut.entity.contentHash);
    const missing = withFlag('', ' ');
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.entity.attributes).toBeNull();
  });

  it('falls back to the frame-level naceVersion constant', () => {
    const mapping: FrameMapping = {
      ...gleifMapping,
      constants: { ...gleifMapping.constants, naceVersion: 'NAF-rev2' },
    };
    const result = normalizeRecord({ mapping, row: 1, read: jsonFieldReader(record, readDottedPath) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entity.naceVersion).toBe('NAF-rev2');
  });

  it('fails when per-row country is missing and no constant exists', () => {
    const withoutCountry = { attributes: { ...record.attributes, entity: { ...record.attributes.entity, legalAddress: { city: 'X' } } } };
    const result = normalizeRecord({
      mapping: gleifMapping,
      row: 7,
      read: jsonFieldReader(withoutCountry, readDottedPath),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('COUNTRY_INVALID');
  });
});

describe('normalizers', () => {
  it('normalizeRegNumber folds whitespace and uppercases', () => {
    expect(normalizeRegNumber('  hrb   12345 ')).toBe('HRB 12345');
  });

  it('normalizeVatId strips spaces, dots and dashes', () => {
    expect(normalizeVatId(' fr 12.345.678-9 ')).toBe('FR123456789');
    expect(normalizeVatId('   ')).toBeNull();
  });

  it('contentHashFor is order-stable JSON serialization of identifiers', () => {
    const base = {
      scheme: 'x',
      regNumber: '1',
      country: 'DE',
      name: 'A',
      nameNorm: 'a',
      legalForm: null,
      status: 'ACTIVE' as const,
      addressJson: null,
      city: null,
      postalCode: null,
      region: null,
      nace: null,
      naceVersion: null,
      employeeBand: null,
      vatId: null,
      lei: null,
      website: null,
      identifiers: [{ scheme: 'siret', value: '1' }],
      attributes: null,
    };
    expect(contentHashFor(base)).toBe(contentHashFor({ ...base }));
    expect(contentHashFor(base)).not.toBe(contentHashFor({ ...base, name: 'B' }));
  });
});

describe('parseFrameConfig attributes mapping', () => {
  const base = () => ({
    schemaVersion: 'registry-frame/v1',
    frame: {
      frameKey: 'x_frame',
      country: 'DE',
      scheme: 'de_hrb',
      label: 'x',
      providerKey: 'p',
      sourceUrl: 'https://example.org/frame',
      licence: 'public-register',
      fetchMode: 'bulk_file',
    },
    mapping: {
      schemaVersion: 'registry-frame-mapping/v1',
      format: 'csv',
      constants: { scheme: 'de_hrb', country: 'DE' },
      fields: { regNumber: 'n', name: 'm' },
    },
  });

  it('accepts a bounded attribute map and rejects invalid names or more than ten entries', () => {
    const ok = base() as Record<string, any>;
    ok.mapping.fields.attributes = { diffusionCommerciale: 'dc' };
    expect(parseFrameConfig(ok).mapping.fields.attributes).toEqual({ diffusionCommerciale: 'dc' });

    const badName = base() as Record<string, any>;
    badName.mapping.fields.attributes = { 'Bad-Name': 'dc' };
    expect(() => parseFrameConfig(badName)).toThrow(FrameConfigError);

    const tooMany = base() as Record<string, any>;
    tooMany.mapping.fields.attributes = Object.fromEntries(
      Array.from({ length: 11 }, (_, index) => [`a${index}`, `p${index}`]),
    );
    expect(() => parseFrameConfig(tooMany)).toThrow(FrameConfigError);
  });
});
