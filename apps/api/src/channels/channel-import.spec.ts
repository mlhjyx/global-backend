import { describe, expect, it } from 'vitest';
import {
  IMPORT_MAX_ROWS,
  IMPORT_SAMPLE_CSV,
  ImportCsvError,
  buildImportRows,
  parseCsv,
  suggestImportMapping,
  validateImportMapping,
} from './channel-import';

describe('M1 导入通道：CSV 解析与列映射', () => {
  it('parses quoted cells, escaped quotes and semicolon files with BOM', () => {
    const parsed = parseCsv('﻿company;website\n"Acme, Pumpen GmbH";https://acme.example\n"Say ""hi""";x\n');
    expect(parsed.headers).toEqual(['company', 'website']);
    expect(parsed.rows).toEqual([
      ['Acme, Pumpen GmbH', 'https://acme.example'],
      ['Say "hi"', 'x'],
    ]);
  });

  it('rejects empty, headerless, duplicate-column and oversized inputs', () => {
    expect(() => parseCsv('')).toThrow(ImportCsvError);
    expect(() => parseCsv('a,a\n1,2')).toThrow(/duplicate/);
    expect(() => parseCsv('__proto__,x\n1,2')).toThrow(/reserved/);
    const tooMany = ['company', ...Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, index) => `Row ${index}`)].join('\n');
    expect(() => parseCsv(tooMany)).toThrow(/more than/);
  });

  it('validates the mapping against real headers and requires a name column', () => {
    expect(validateImportMapping(['company', 'site'], { name: 'Company', website: 'site' })).toEqual({
      name: 'company',
      website: 'site',
    });
    expect(() => validateImportMapping(['company'], {})).toThrow(/mapping.name/);
    expect(() => validateImportMapping(['company'], { name: 'nope' })).toThrow(/unknown column/);
  });

  it('suggests a column mapping from header aliases (P3 import contract)', () => {
    expect(suggestImportMapping(['Company', 'Website', 'Country', 'Industry'])).toEqual({
      name: 'Company',
      website: 'Website',
      country: 'Country',
      industry: 'Industry',
    });
    expect(suggestImportMapping(['公司名称', '官网', '国家', '行业'])).toEqual({
      name: '公司名称',
      website: '官网',
      country: '国家',
      industry: '行业',
    });
    expect(suggestImportMapping(['company', 'domain'])).toEqual({ name: 'company', domain: 'domain' });
    expect(suggestImportMapping(['weird'])).toEqual({});
  });

  it('names the available columns and an example when the mapping is missing or wrong', () => {
    expect(() => validateImportMapping(['company', 'site'], {})).toThrow(/available columns: company, site/);
    expect(() => validateImportMapping(['company', 'site'], {})).toThrow(/"name":"company"/);
    expect(() => validateImportMapping(['company'], { name: 'nope' })).toThrow(/available columns: company/);
    expect(() => validateImportMapping(['company'], 'not-an-object')).toThrow(/available columns: company/);
  });

  it('builds rows with normalized https hostnames and collects invalid rows', () => {
    const parsed = parseCsv('company,website,country\nAcme,http://WWW.Acme.de/path,DE\nXY,not-a-domain,DE\n,empty,DE');
    const mapping = validateImportMapping(parsed.headers, { name: 'company', website: 'website', country: 'country' });
    const built = buildImportRows(parsed.headers, parsed.rows, mapping);
    expect(built.rows).toEqual([
      { rowNumber: 1, name: 'Acme', domain: 'www.acme.de', country: 'DE', raw: { company: 'Acme', website: 'http://WWW.Acme.de/path', country: 'DE' } },
      { rowNumber: 2, name: 'XY', country: 'DE', raw: { company: 'XY', website: 'not-a-domain', country: 'DE' } },
    ]);
    expect(built.invalid).toEqual([{ rowNumber: 3, reason: 'COMPANY_NAME_INVALID' }]);
  });

  it('ships a parseable 10-row sample CSV for the operator acceptance run', () => {
    const parsed = parseCsv(IMPORT_SAMPLE_CSV);
    expect(parsed.headers).toEqual(['company', 'website', 'country', 'industry']);
    expect(parsed.rows).toHaveLength(10);
    const built = buildImportRows(parsed.headers, parsed.rows, {
      name: 'company',
      website: 'website',
      country: 'country',
      industry: 'industry',
    });
    expect(built.rows).toHaveLength(10);
    expect(built.rows.every((row) => Boolean(row.domain))).toBe(true);
  });
});
