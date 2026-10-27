/**
 * BI-23（交付闭环设计 §6）：客户把导出的周报 CSV 填好末尾五列后原样上传。
 * 这里只做确定的解析与逐行校验：按「线索 ID」匹配，空行跳过，坏行带行号拒绝。
 * 不信任文件里的任何其他列（公司名只是陪衬，永远不用于匹配）。
 */

import { isOutcomeReasonCode } from '../lead/reason-codes';
import { WEEKLY_REPORT_COLUMNS } from './weekly-report-row';

/** The columns come from the export's own header list, so a rename cannot desynchronise them. */
function reportColumn(name: string): string {
  const found = WEEKLY_REPORT_COLUMNS.find((column) => column === name);
  if (!found) throw new Error(`WEEKLY_FEEDBACK_COLUMN_MISSING: ${name}`);
  return found;
}

export const FEEDBACK_COLUMNS = Object.freeze({
  leadId: reportColumn('线索 ID'),
  relevance: reportColumn('客户填写：相关性（1-5）'),
  willingToContact: reportColumn('客户填写：愿意联系（是/否）'),
  reasonCode: reportColumn('客户填写：原因码'),
  note: reportColumn('客户填写：备注'),
  contacted: reportColumn('客户填写：是否已联系（是/否）'),
});

export const FEEDBACK_MAX_NOTE_CHARS = 2_000;

export type FeedbackRejectionReason =
  | 'INVALID_LEAD_ID'
  | 'INVALID_RELEVANCE'
  | 'INVALID_WILLING_TO_CONTACT'
  | 'INVALID_REASON_CODE'
  | 'INVALID_CONTACTED'
  | 'NOTE_TOO_LONG';

export interface WeeklyFeedbackRow {
  readonly line: number;
  readonly leadId: string;
  readonly relevance: number | null;
  readonly willingToContact: boolean | null;
  readonly reasonCode: string | null;
  readonly note: string | null;
  readonly contacted: boolean | null;
}

export interface WeeklyFeedbackRejection {
  readonly line: number;
  readonly reason: FeedbackRejectionReason;
}

export interface WeeklyFeedbackParseResult {
  /**
   * A whole-file refusal; null means rows were read: 'FEEDBACK_HEADER_MISSING' (no lead id
   * column) or 'FEEDBACK_TOO_LARGE' (more records than one export can carry).
   */
  readonly fatal: 'FEEDBACK_HEADER_MISSING' | 'FEEDBACK_TOO_LARGE' | null;
  readonly rows: readonly WeeklyFeedbackRow[];
  readonly rejected: readonly WeeklyFeedbackRejection[];
  readonly skipped: number;
}

/** The feedback file comes back from one export; anything far larger is refused while parsing. */
export const WEEKLY_FEEDBACK_MAX_RECORDS = 20_000;

interface CsvRecord {
  readonly cells: readonly string[];
  readonly line: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The field separator: the exported file uses commas, but a German-locale Excel saves the
 * filled sheet with semicolons. The header decides (it always carries 线索 ID).
 */
function delimiterOf(input: string): ',' | ';' {
  const firstLine = input.split('\n', 1)[0] ?? '';
  return firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
}

/**
 * RFC 4180 records: quoted fields, doubled quotes, the file's separator and line breaks
 * inside quotes. A quote only opens a quoted field at the start of a field (a stray `"`
 * inside an unquoted value stays literal instead of swallowing the rest of the file);
 * a bare CR or a CRLF ends a record. At most {@link WEEKLY_FEEDBACK_MAX_RECORDS} records
 * are kept; a longer file reports itself and is not parsed further.
 */
function csvRecords(text: string, maxRecords: number): { records: readonly CsvRecord[]; tooLarge: boolean } {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = delimiterOf(input);
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === delimiter) {
      cells.push(field);
      field = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      cells.push(field);
      records.push({ cells, line: recordLine });
      if (records.length > maxRecords) return { records: [], tooLarge: true };
      cells = [];
      field = '';
      line += 1;
      recordLine = line;
    } else {
      field += char;
    }
  }
  if (field.length > 0 || cells.length > 0) {
    cells.push(field);
    records.push({ cells, line: recordLine });
    if (records.length > maxRecords) return { records: [], tooLarge: true };
  }
  return { records, tooLarge: false };
}

function columnIndex(header: readonly string[], name: string): number {
  return header.findIndex((cell) => cell.trim() === name);
}

function yesNo(value: string): boolean | null | undefined {
  if (value === '') return null;
  if (value === '是') return true;
  if (value === '否') return false;
  return undefined;
}

/** Parse and validate the filled weekly CSV; never writes anything. */
export function parseWeeklyFeedbackCsv(
  text: string,
  maxRecords: number = WEEKLY_FEEDBACK_MAX_RECORDS,
): WeeklyFeedbackParseResult {
  const { records, tooLarge } = csvRecords(text, maxRecords);
  if (tooLarge) {
    return { fatal: 'FEEDBACK_TOO_LARGE', rows: [], rejected: [], skipped: 0 };
  }
  const headerIndex = records.findIndex((record) => record.cells.some((cell) => cell.trim() === FEEDBACK_COLUMNS.leadId));
  if (headerIndex < 0) {
    return { fatal: 'FEEDBACK_HEADER_MISSING', rows: [], rejected: [], skipped: 0 };
  }
  const header = records[headerIndex]!.cells;
  const index = {
    leadId: columnIndex(header, FEEDBACK_COLUMNS.leadId),
    relevance: columnIndex(header, FEEDBACK_COLUMNS.relevance),
    willingToContact: columnIndex(header, FEEDBACK_COLUMNS.willingToContact),
    reasonCode: columnIndex(header, FEEDBACK_COLUMNS.reasonCode),
    note: columnIndex(header, FEEDBACK_COLUMNS.note),
    contacted: columnIndex(header, FEEDBACK_COLUMNS.contacted),
  };
  const at = (record: CsvRecord, column: number): string =>
    column >= 0 ? (record.cells[column] ?? '').trim() : '';

  const rows: WeeklyFeedbackRow[] = [];
  const rejected: WeeklyFeedbackRejection[] = [];
  let skipped = 0;
  for (const record of records.slice(headerIndex + 1)) {
    const leadId = at(record, index.leadId);
    const relevanceText = at(record, index.relevance);
    const willingText = at(record, index.willingToContact);
    const reasonCodeText = at(record, index.reasonCode);
    const noteText = at(record, index.note);
    const contactedText = at(record, index.contacted);
    if (![relevanceText, willingText, reasonCodeText, noteText, contactedText].some((value) => value !== '')) {
      skipped += 1;
      continue;
    }
    if (!UUID.test(leadId)) {
      rejected.push({ line: record.line, reason: 'INVALID_LEAD_ID' });
      continue;
    }
    let relevance: number | null = null;
    if (relevanceText !== '') {
      if (!/^[1-5]$/u.test(relevanceText)) {
        rejected.push({ line: record.line, reason: 'INVALID_RELEVANCE' });
        continue;
      }
      relevance = Number(relevanceText);
    }
    const willingToContact = yesNo(willingText);
    if (willingToContact === undefined) {
      rejected.push({ line: record.line, reason: 'INVALID_WILLING_TO_CONTACT' });
      continue;
    }
    let reasonCode: string | null = null;
    if (reasonCodeText !== '') {
      if (!isOutcomeReasonCode(reasonCodeText)) {
        rejected.push({ line: record.line, reason: 'INVALID_REASON_CODE' });
        continue;
      }
      reasonCode = reasonCodeText;
    }
    if (noteText.length > FEEDBACK_MAX_NOTE_CHARS) {
      rejected.push({ line: record.line, reason: 'NOTE_TOO_LONG' });
      continue;
    }
    const contacted = yesNo(contactedText);
    if (contacted === undefined) {
      rejected.push({ line: record.line, reason: 'INVALID_CONTACTED' });
      continue;
    }
    rows.push({
      line: record.line,
      leadId,
      relevance,
      willingToContact,
      reasonCode,
      note: noteText === '' ? null : noteText,
      contacted,
    });
  }
  return { fatal: null, rows, rejected, skipped };
}
