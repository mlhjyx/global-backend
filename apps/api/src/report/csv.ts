/**
 * Minimal RFC 4180 CSV writer for the BI-22 weekly report. Hand-written on purpose: the report
 * needs only quoting and formula neutralization, and a new dependency would re-bind the lockfile
 * and the vulnerability baseline.
 */

export type CsvValue = string | number | null | undefined;

/** Excel opens a UTF-8 CSV correctly only when it starts with a byte order mark. */
export const UTF8_BOM = '﻿';

/**
 * Cells a spreadsheet may evaluate as a formula (OWASP CSV injection): a leading `=`, `+`, `-`
 * or `@` (also after leading spaces, and in their full-width forms), or a leading tab or
 * carriage return.
 */
const FORMULA_START = /^(?:[\t\r]|\s*[=+\-@＝＋－＠])/u;
const NEEDS_QUOTES = /[",\r\n]/u;

/** One encoded cell: formula-neutralized with a leading `'`, then quoted when needed. */
export function encodeCsvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  const raw = String(value);
  const text = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** A whole document: BOM, header, rows, CRLF after every record. */
export function encodeCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const lines = [header, ...rows].map((row) => row.map(encodeCsvCell).join(','));
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}
