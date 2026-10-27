/**
 * BI-23（交付闭环设计 §6）：客户把导出的周报 CSV 填好末尾五列后原样上传。
 * 这里只做确定的解析与逐行校验：按「线索 ID」匹配，空行跳过，坏行带行号拒绝。
 * 不信任文件里的任何其他列（公司名只是陪衬，永远不用于匹配）。
 */

import { isOutcomeReasonCode } from '../lead/reason-codes';

export const FEEDBACK_COLUMNS = Object.freeze({
  leadId: '线索 ID',
  relevance: '客户填写：相关性（1-5）',
  willingToContact: '客户填写：愿意联系（是/否）',
  reasonCode: '客户填写：原因码',
  note: '客户填写：备注',
  contacted: '客户填写：是否已联系（是/否）',
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
  /** 'FEEDBACK_HEADER_MISSING' refuses the whole file; null means rows were read. */
  readonly fatal: 'FEEDBACK_HEADER_MISSING' | null;
  readonly rows: readonly WeeklyFeedbackRow[];
  readonly rejected: readonly WeeklyFeedbackRejection[];
  readonly skipped: number;
}

interface CsvRecord {
  readonly cells: readonly string[];
  readonly line: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** RFC 4180 records: quoted fields, doubled quotes, commas and line breaks inside quotes. */
function csvRecords(text: string): readonly CsvRecord[] {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(field);
      field = '';
    } else if (char === '\r') {
      // CRLF: the \n ends the record.
    } else if (char === '\n') {
      cells.push(field);
      records.push({ cells, line: recordLine });
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
  }
  return records;
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
export function parseWeeklyFeedbackCsv(text: string): WeeklyFeedbackParseResult {
  const records = csvRecords(text);
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
