import { describe, expect, it } from 'vitest';
import { parseWeeklyFeedbackCsv } from './weekly-feedback';

/**
 * BI-23（交付闭环设计 §6）：客户在导出的周报 CSV 里填好末尾五列，原样上传回来。
 * 按线索 ID 匹配，逐行校验；空行跳过，坏行计数拒绝，绝不半信半疑地入库。
 */
const HEADER = [
  '公司名',
  '线索 ID',
  '客户填写：相关性（1-5）',
  '客户填写：愿意联系（是/否）',
  '客户填写：原因码',
  '客户填写：备注',
  '客户填写：是否已联系（是/否）',
].join(',');

const LEAD = '11111111-1111-4111-8111-111111111111';

function csv(...rows: string[]): string {
  return `\uFEFF${[HEADER, ...rows].join('\r\n')}\r\n`;
}

function row(company: string, cells: string): string {
  return `${company},${LEAD},${cells}`;
}

describe('parseWeeklyFeedbackCsv', () => {
  it('reads the five filled customer columns keyed by lead id', () => {
    const result = parseWeeklyFeedbackCsv(csv(row('Muster GmbH', '4,是,GOOD_FIT,"guter Kontakt, gern mehr",否')));
    expect(result.fatal).toBeNull();
    expect(result.rejected).toEqual([]);
    expect(result.skipped).toBe(0);
    expect(result.rows).toEqual([
      {
        line: 2,
        leadId: LEAD,
        relevance: 4,
        willingToContact: true,
        reasonCode: 'GOOD_FIT',
        note: 'guter Kontakt, gern mehr',
        contacted: false,
      },
    ]);
  });

  it('skips rows whose customer columns are all empty, even when the lead id is present', () => {
    const result = parseWeeklyFeedbackCsv(csv(row('Muster GmbH', ',,,,'), ', ,,,,'));
    expect(result.rows).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.skipped).toBe(2);
  });

  it('rejects bad rows with their line number and a stable reason', () => {
    const result = parseWeeklyFeedbackCsv(
      csv(
        `Muster GmbH,not-a-uuid,4,是,GOOD_FIT,,`,
        row('Muster GmbH', '9,是,GOOD_FIT,,'),
        row('Muster GmbH', '4,vielleicht,GOOD_FIT,,'),
        row('Muster GmbH', '4,是,NOT_A_CODE,,'),
        row('Muster GmbH', '4,是,GOOD_FIT,,ja'),
        row('Muster GmbH', `3,否,,${'x'.repeat(2001)},`),
      ),
    );
    expect(result.rows).toEqual([]);
    expect(result.rejected.map((entry) => [entry.line, entry.reason])).toEqual([
      [2, 'INVALID_LEAD_ID'],
      [3, 'INVALID_RELEVANCE'],
      [4, 'INVALID_WILLING_TO_CONTACT'],
      [5, 'INVALID_REASON_CODE'],
      [6, 'INVALID_CONTACTED'],
      [7, 'NOTE_TOO_LONG'],
    ]);
  });

  it('accepts quoted notes with commas, quotes and line breaks', () => {
    const result = parseWeeklyFeedbackCsv(
      `\uFEFF${HEADER}\r\nMuster GmbH,${LEAD},5,否,WILL_FOLLOW_UP,"Er sagte: ""später"", dann\r\nnochmal melden",是\r\n`,
    );
    expect(result.rows[0]).toMatchObject({
      note: 'Er sagte: "später", dann\r\nnochmal melden',
      contacted: true,
    });
  });

  it('refuses a file without the 线索 ID column', () => {
    const result = parseWeeklyFeedbackCsv('\uFEFF公司名,备注\r\nMuster GmbH,x\r\n');
    expect(result.fatal).toBe('FEEDBACK_HEADER_MISSING');
    expect(result.rows).toEqual([]);
  });

  it('treats absent optional columns as empty instead of failing the file', () => {
    const result = parseWeeklyFeedbackCsv(`\uFEFF线索 ID,客户填写：备注\r\n${LEAD},interessant\r\n`);
    expect(result.fatal).toBeNull();
    expect(result.rows).toEqual([
      {
        line: 2,
        leadId: LEAD,
        relevance: null,
        willingToContact: null,
        reasonCode: null,
        note: 'interessant',
        contacted: null,
      },
    ]);
  });
});
