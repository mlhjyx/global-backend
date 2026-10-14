import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_SCOPES_METADATA } from '../auth/require-scopes.decorator';
import { ReportController } from './report.controller';

const ICP = '22222222-2222-4222-8222-222222222222';
const ctx = { workspaceId: 'ws-1', userId: 'user-1', roles: [], scopes: [] } as never;

describe('ReportController (BI-22)', () => {
  it('serves GET /reports/weekly and needs both acquisition:read and acquisition:export', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ReportController)).toBe('reports');
    const handler = ReportController.prototype.weekly;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('weekly');
    expect(Reflect.getMetadata(REQUIRED_SCOPES_METADATA, ReportController)).toEqual([
      'acquisition:read',
      'acquisition:export',
    ]);
  });

  it('returns the CSV with download, no-store and count headers', async () => {
    const weekly = vi.fn(async () => ({
      reportId: '99999999-9999-4999-8999-999999999999',
      week: '2026-W42',
      icpId: ICP,
      csv: '﻿公司名\r\n',
      rows: 4,
      withheld: { rights: 2, sanctions: 1, quarantined: 0 },
    }));
    const controller = new ReportController({ weekly } as never);
    const headers = new Map<string, string>();
    const response = { setHeader: vi.fn((name: string, value: string) => headers.set(name, value)) };

    const body = await controller.weekly(ctx, ICP, '2026-W42', response as never);

    expect(weekly).toHaveBeenCalledWith(ctx, { icpId: ICP, week: '2026-W42' });
    expect(body).toBe('﻿公司名\r\n');
    expect(Object.fromEntries(headers)).toEqual({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="weekly-report-2026-W42-${ICP}.csv"`,
      'Cache-Control': 'no-store',
      'X-Report-Id': '99999999-9999-4999-8999-999999999999',
      'X-Report-Week': '2026-W42',
      'X-Report-Rows': '4',
      'X-Report-Withheld-Rights': '2',
      'X-Report-Withheld-Sanctions': '1',
      'X-Report-Withheld-Quarantined': '0',
    });
  });

  it('sets no headers when the service refuses the request', async () => {
    const failure = new Error('refused');
    const controller = new ReportController({ weekly: vi.fn(async () => Promise.reject(failure)) } as never);
    const response = { setHeader: vi.fn() };
    await expect(controller.weekly(ctx, 'bad', undefined, response as never)).rejects.toBe(failure);
    expect(response.setHeader).not.toHaveBeenCalled();
  });
});
