import { Body, Controller, Get, HttpCode, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { envelope } from '../common/envelope';
import { WEEKLY_REPORT_MAX_LEADS, WeeklyReportService } from './weekly-report.service';

const errorSchema = (codes: readonly string[]) => ({
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: true,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', enum: [...codes] },
        message: { type: 'string' },
      },
    },
  },
});

const countHeader = (description: string) => ({ description, schema: { type: 'integer', minimum: 0 } });

/**
 * BI-22 lead delivery: the weekly report a customer opens in Excel. The data leaves the platform
 * as a file, so the controller requires the dedicated `acquisition:export` scope on top of
 * `acquisition:read`.
 */
@ApiTags('Reports')
@ApiBearerAuth()
@Controller('reports')
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:read', 'acquisition:export')
export class ReportController {
  constructor(private readonly reports: WeeklyReportService) {}

  @Get('weekly')
  @ApiOperation({
    summary:
      '周报 CSV：该 ICP 下最新一条裁决是该 ISO 周（UTC，周一起）accept 的线索；每行都写一条 EXPORT 判定到 policy_decision_log，被拒或被拦的行不导出',
  })
  @ApiQuery({ name: 'icpId', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'week',
    required: false,
    description: 'ISO 周，如 2026-W42；缺省为本周（UTC）',
    schema: { type: 'string', pattern: '^\\d{4}-W\\d{2}$' },
  })
  @ApiResponse({
    status: 200,
    description: 'UTF-8（带 BOM）CSV，中文表头；以 = + - @ 开头的单元格前加单引号防公式注入',
    content: { 'text/csv': { schema: { type: 'string' } } },
    headers: {
      'Content-Disposition': { description: '附件文件名', schema: { type: 'string' } },
      'X-Report-Id': {
        description: '本次导出的 policy_decision_log correlation_id',
        schema: { type: 'string', format: 'uuid' },
      },
      'X-Report-Week': { description: '实际导出的 ISO 周', schema: { type: 'string' } },
      'X-Report-Rows': countHeader('导出的行数'),
      'X-Report-Withheld-Rights': countHeader('DataRights EXPORT 拒绝而未导出的行数（每行已写 policy_decision_log）'),
      'X-Report-Withheld-Sanctions': countHeader('制裁命中未经人工清除而未导出的行数（每行写一条 EXPORT DENY，reason sanctions_hold）'),
      'X-Report-Withheld-Quarantined': countHeader('历史合成来源被隔离而未导出的行数（每行写一条 EXPORT DENY，reason synthetic_quarantined）'),
    },
  })
  @ApiResponse({ status: 400, description: 'icpId 或 week 不合法', schema: errorSchema(['VALIDATION_ERROR']) })
  @ApiResponse({ status: 404, description: '当前 workspace 不可见该 ICP', schema: errorSchema(['NOT_FOUND']) })
  @ApiResponse({
    status: 422,
    description: `该周 accept 的线索超过 ${WEEKLY_REPORT_MAX_LEADS} 条，拒绝而不截断`,
    schema: errorSchema(['WEEKLY_REPORT_TOO_LARGE']),
  })
  async weekly(
    @Ctx() ctx: RequestContext,
    @Query('icpId') icpId: string | undefined,
    @Query('week') week: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const report = await this.reports.weekly(ctx, { icpId, week });
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="weekly-report-${report.week}-${report.icpId}.csv"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Report-Id', report.reportId);
    response.setHeader('X-Report-Week', report.week);
    response.setHeader('X-Report-Rows', String(report.rows));
    response.setHeader('X-Report-Withheld-Rights', String(report.withheld.rights));
    response.setHeader('X-Report-Withheld-Sanctions', String(report.withheld.sanctions));
    response.setHeader('X-Report-Withheld-Quarantined', String(report.withheld.quarantined));
    return report.csv;
  }

  @Post('weekly/feedback')
  @RequireScopes('acquisition:review')
  @HttpCode(200)
  @ApiConsumes('text/csv')
  @ApiBody({ schema: { type: 'string' }, description: '导出的周报 CSV 原样上传（客户填写五列）' })
  @ApiOperation({
    summary: '周报反馈上传（BI-23）：按线索 ID 匹配，逐行校验，只追加写 lead_outcome；返回接受/拒绝/跳过计数',
  })
  @ApiResponse({
    status: 200,
    description: '接受与拒绝计数（拒绝行带文件内行号与稳定原因）',
    schema: {
      type: 'object',
      required: ['data'],
      properties: {
        data: {
          type: 'object',
          required: ['accepted', 'rejected', 'skipped'],
          properties: {
            accepted: { type: 'integer', minimum: 0 },
            skipped: { type: 'integer', minimum: 0 },
            rejected: {
              type: 'array',
              items: {
                type: 'object',
                required: ['line', 'reason'],
                properties: { line: { type: 'integer' }, reason: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: '缺「线索 ID」列或请求体不是 CSV 文本',
    schema: errorSchema(['FEEDBACK_HEADER_MISSING', 'VALIDATION_ERROR']),
  })
  @ApiResponse({
    status: 422,
    description: '上传文件的行数超过一次导出可能包含的上限，整份拒绝而不截断',
    schema: errorSchema(['FEEDBACK_TOO_LARGE']),
  })
  async feedback(@Ctx() ctx: RequestContext, @Body() csv: string) {
    return envelope(await this.reports.recordFeedback(ctx, { csv }));
  }
}
