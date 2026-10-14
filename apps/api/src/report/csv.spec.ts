import { describe, expect, it } from 'vitest';
import { encodeCsv, encodeCsvCell, UTF8_BOM } from './csv';

describe('CSV encoding for the weekly report', () => {
  it('starts with a UTF-8 byte order mark and ends every record with CRLF', () => {
    const csv = encodeCsv(['公司名', '域名'], [['Pumpen GmbH', 'pumpen.example']]);
    expect(Buffer.from(csv, 'utf8').subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(csv).toBe(`${UTF8_BOM}公司名,域名\r\nPumpen GmbH,pumpen.example\r\n`);
  });

  it('quotes cells that carry a separator, a quote or a line break', () => {
    expect(encodeCsvCell('a,b')).toBe('"a,b"');
    expect(encodeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(encodeCsvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(encodeCsvCell('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('writes empty cells for null and undefined and plain text for numbers', () => {
    expect(encodeCsvCell(null)).toBe('');
    expect(encodeCsvCell(undefined)).toBe('');
    expect(encodeCsvCell(0.75)).toBe('0.75');
    expect(encodeCsvCell('')).toBe('');
  });

  it('prefixes a quote to any cell a spreadsheet would read as a formula', () => {
    for (const [input, expected] of [
      ['=HYPERLINK("https://evil.example","x")', `"'=HYPERLINK(""https://evil.example"",""x"")"`],
      ['+1-2', "'+1-2"],
      ['-2+3', "'-2+3"],
      ['@SUM(A1:A2)', "'@SUM(A1:A2)"],
      ['\t=1', "'\t=1"],
      ['\r=1', `"'\r=1"`],
      ['  =1', "'  =1"],
      ['＝1', "'＝1"],
      ['＋1', "'＋1"],
      ['－1', "'－1"],
      ['＠1', "'＠1"],
    ] as const) {
      expect(encodeCsvCell(input), JSON.stringify(input)).toBe(expected);
    }
  });

  it('leaves ordinary text, URLs and inner operators untouched', () => {
    expect(encodeCsvCell('https://pumpen.example/kontakt')).toBe('https://pumpen.example/kontakt');
    expect(encodeCsvCell('a=b')).toBe('a=b');
    expect(encodeCsvCell('de-hrb:siegburg:1525')).toBe('de-hrb:siegburg:1525');
  });
});
