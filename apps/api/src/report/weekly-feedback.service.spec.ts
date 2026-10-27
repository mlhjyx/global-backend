import { describe, expect, it, vi } from 'vitest';
import { WeeklyReportService } from './weekly-report.service';
import { WEEKLY_REPORT_COLUMNS } from './weekly-report-row';

/**
 * BI-23（交付闭环设计 §6）：POST /reports/weekly/feedback —— 客户填好的周报 CSV 原样上传，
 * 按线索 ID 匹配本工作区的线索，逐行校验并只追加写 lead_outcome。
 */
const ctx = { workspaceId: 'ws-1', userId: 'user-1', roles: [], scopes: [] } as never;
const LEAD = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function header(): string {
  // The real export carries many more columns; the feedback reader keys by header name.
  return ['公司名', '线索 ID', ...WEEKLY_REPORT_COLUMNS.filter((name) => name.startsWith('客户填写：'))].join(',');
}

function csv(...rows: string[]): string {
  return `\uFEFF${[header(), ...rows].join('\r\n')}\r\n`;
}

function serviceWithTx(tx: unknown): WeeklyReportService {
  return new WeeklyReportService(
    { withWorkspace: async <T>(_workspaceId: string, callback: (client: unknown) => Promise<T>) => callback(tx) } as never,
    {} as never,
    {} as never,
  );
}

describe('WeeklyReportService.recordFeedback', () => {
  it('writes only rows whose lead exists in the workspace and counts the rest', async () => {
    const tx = {
      lead: { findMany: vi.fn(async () => [{ id: LEAD }]) },
      leadOutcome: { createMany: vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length })) },
    };
    const result = await serviceWithTx(tx).recordFeedback(ctx, {
      csv: csv(
        `Muster GmbH,${LEAD},4,是,GOOD_FIT,"guter Kontakt",否`,
        `Fremd GmbH,${OTHER},5,否,WILL_FOLLOW_UP,,是`,
        `Muster GmbH,${LEAD},9,是,GOOD_FIT,,`,
        `Muster GmbH,${LEAD},,,,,`,
      ),
    });

    expect(result).toEqual({
      accepted: 1,
      rejected: [
        { line: 3, reason: 'UNKNOWN_LEAD' },
        { line: 4, reason: 'INVALID_RELEVANCE' },
      ],
      skipped: 1,
    });
    expect(tx.lead.findMany).toHaveBeenCalledWith({
      where: { id: { in: [LEAD, OTHER] } },
      select: { id: true },
    });
    expect(tx.leadOutcome.createMany).toHaveBeenCalledWith({
      data: [
        {
          workspaceId: 'ws-1',
          leadId: LEAD,
          relevance: 4,
          willingToContact: true,
          reasonCode: 'GOOD_FIT',
          note: 'guter Kontakt',
          contacted: false,
          source: 'customer',
        },
      ],
    });
  });

  it('never writes when every row is invalid, and refuses a file without the lead id column', async () => {
    const tx = {
      lead: { findMany: vi.fn(async () => []) },
      leadOutcome: { createMany: vi.fn(async () => ({ count: 0 })) },
    };
    const service = serviceWithTx(tx);
    await service.recordFeedback(ctx, { csv: csv(`Muster GmbH,not-a-uuid,4,是,GOOD_FIT,,`) });
    expect(tx.leadOutcome.createMany).not.toHaveBeenCalled();

    await expect(service.recordFeedback(ctx, { csv: '公司名,备注\r\nMuster GmbH,x\r\n' })).rejects.toMatchObject({
      response: { error: { code: 'FEEDBACK_HEADER_MISSING' } },
    });
  });

  it('refuses a body that is not a string', async () => {
    const service = serviceWithTx({});
    await expect(service.recordFeedback(ctx, { csv: 42 })).rejects.toMatchObject({
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
  });

  it('refuses an upload with more rows than the weekly report could contain', async () => {
    const rows = Array.from({ length: 5_001 }, () => `Muster GmbH,${LEAD},4,是,GOOD_FIT,,`);
    await expect(serviceWithTx({}).recordFeedback(ctx, { csv: csv(...rows) })).rejects.toMatchObject({
      response: { error: { code: 'FEEDBACK_TOO_LARGE' } },
    });
  });
});
