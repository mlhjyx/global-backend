import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { pageEnvelope } from '../common/envelope';
import {
  COMPANY_SIGNALS_DEFAULT_LIMIT,
  COMPANY_SIGNALS_MAX_LIMIT,
  CompanySignalsService,
} from './company-signals.service';

const validationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: true,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', enum: ['VALIDATION_ERROR'] },
        message: { type: 'string' },
      },
    },
  },
};

/**
 * P1-18 读侧：公司「触发信号」只读 API。
 *
 * 信号来自免费信号栈（changedetection 页面变更 / RSSHub 条目，见 RUNBOOK §16），
 * 由运营 CLI 解析归因入 `company_signal`；本端点只读，按 observed_at 倒序 keyset 分页。
 * 未归因（company_id 为空）的行不在此端点出现。
 */
@ApiTags('Signals')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:read')
export class CompanySignalsController {
  constructor(private readonly signals: CompanySignalsService) {}

  @Get('companies/:companyId/signals')
  @ApiOperation({
    summary:
      '公司触发信号（社媒/网页变更信号，observed_at 倒序）：只读 company_signal 中已归因到该公司的行，keyset 分页',
  })
  @ApiParam({ name: 'companyId', format: 'uuid' })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `每页条数，默认 ${COMPANY_SIGNALS_DEFAULT_LIMIT}，最大 ${COMPANY_SIGNALS_MAX_LIMIT}`,
    schema: { type: 'integer', minimum: 1, maximum: COMPANY_SIGNALS_MAX_LIMIT, default: COMPANY_SIGNALS_DEFAULT_LIMIT },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: '上一页 page.next_cursor 原样回传',
    schema: { type: 'string' },
  })
  @ApiResponse({
    status: 200,
    description: '{ data: [...], page } — 该公司暂无信号时返回空数组（has_more=false）',
    schema: {
      type: 'object',
      required: ['data', 'page'],
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'providerKey', 'signalKind', 'sourceUrl', 'title', 'excerpt', 'observedAt'],
            properties: {
              id: { type: 'string' },
              providerKey: { type: 'string', enum: ['rss', 'changedetection'] },
              signalKind: { type: 'string', enum: ['rss_item', 'page_change'] },
              sourceUrl: { type: 'string' },
              title: { type: 'string' },
              excerpt: { type: 'string', nullable: true },
              observedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        page: {
          type: 'object',
          required: ['next_cursor', 'has_more'],
          properties: {
            next_cursor: { type: 'string', nullable: true },
            has_more: { type: 'boolean' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR — limit/cursor 形态非法', schema: validationSchema })
  async list(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const result = await this.signals.listForCompany(ctx, companyId, { limit, cursor });
    if (result === 'invalid') {
      throw new BadRequestException('limit or cursor is not valid');
    }
    return pageEnvelope(result.data, result.page);
  }
}
