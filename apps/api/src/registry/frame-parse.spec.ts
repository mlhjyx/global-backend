import { describe, expect, it } from 'vitest';
import {
  FrameParseError,
  parseCsv,
  parseJsonRecords,
  readDottedPath,
} from './frame-parse';

describe('parseCsv', () => {
  it('parses a simple table with CRLF and trailing newline', () => {
    const { header, records } = parseCsv('a,b\r\n1,2\r\n3,4\r\n');
    expect(header).toEqual(['a', 'b']);
    expect(records).toEqual([
      { line: 2, values: ['1', '2'] },
      { line: 3, values: ['3', '4'] },
    ]);
  });

  it('strips a UTF-8 BOM', () => {
    const { header } = parseCsv('﻿CompanyNumber,CompanyName\n1,Acme\n');
    expect(header).toEqual(['CompanyNumber', 'CompanyName']);
  });

  it('handles quoted fields with commas, escaped quotes and newlines', () => {
    const text = 'name,address\n"Acme, Inc.","Line 1\nLine 2"\n"Quote ""Q"" Ltd",Berlin\n';
    const { records } = parseCsv(text);
    expect(records).toEqual([
      { line: 2, values: ['Acme, Inc.', 'Line 1\nLine 2'] },
      { line: 4, values: ['Quote "Q" Ltd', 'Berlin'] },
    ]);
  });

  it('supports custom delimiters', () => {
    const { header, records } = parseCsv('a;b\n1;2\n', { delimiter: ';' });
    expect(header).toEqual(['a', 'b']);
    expect(records).toEqual([{ line: 2, values: ['1', '2'] }]);
  });

  it('skips blank lines', () => {
    const { records } = parseCsv('a,b\n\n1,2\n\n');
    expect(records).toEqual([{ line: 3, values: ['1', '2'] }]);
  });

  it('fails on duplicate or empty header names', () => {
    expect(() => parseCsv('a,a\n1,2\n')).toThrow(FrameParseError);
    expect(() => parseCsv('a,\n1,2\n')).toThrow(FrameParseError);
  });

  it('fails on unterminated quotes with the record line', () => {
    try {
      parseCsv('a,b\n"unterminated,2\n');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FrameParseError);
      const issues = (error as FrameParseError).issues;
      expect(issues[0]?.code).toBe('CSV_UNTERMINATED_QUOTE');
      expect(issues[0]?.row).toBe(2);
    }
  });

  it('fails on empty input', () => {
    expect(() => parseCsv('')).toThrow(FrameParseError);
  });
});

describe('parseJsonRecords / readDottedPath', () => {
  const gleifLike = {
    data: [
      { id: 'A', attributes: { entity: { legalName: { name: 'Acme' } } } },
      { id: 'B', attributes: { entity: { legalName: { name: 'Beta' } } } },
    ],
  };

  it('reads nested records by dotted path', () => {
    const records = parseJsonRecords(JSON.stringify(gleifLike), 'data');
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ rowNumber: 1, value: gleifLike.data[0] });
    expect(readDottedPath(records[0]!.value, 'attributes.entity.legalName.name')).toBe('Acme');
  });

  it('fails when recordsPath is not an array', () => {
    expect(() => parseJsonRecords(JSON.stringify(gleifLike), 'missing')).toThrow(FrameParseError);
  });

  it('fails on invalid JSON', () => {
    expect(() => parseJsonRecords('{oops', 'data')).toThrow(FrameParseError);
  });

  it('returns undefined for missing or out-of-range paths', () => {
    expect(readDottedPath(gleifLike, 'data.9.name')).toBeUndefined();
    expect(readDottedPath(gleifLike, 'nope.nope')).toBeUndefined();
  });
});
