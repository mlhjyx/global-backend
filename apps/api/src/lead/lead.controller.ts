import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { envelope, pageEnvelope } from '../common/envelope';
import { ApiEnvelope, ApiPageEnvelope } from '../common/api-envelope.decorator';
import { LeadService } from './lead.service';

/** Lead 行（六维分+队列）；完整字段结构化 DTO 待收口⑤ 一等 Signal 后定型。 */
const LEAD_SCHEMA = { type: 'object', description: 'Lead（六维分+队列+裁决状态）' };

class RejectLeadDto {
  @ApiPropertyOptional({ description: '拒绝原因（回流做评分质量反馈）' })
  @IsOptional()
  @IsString()
  reason?: string;
}

class AcceptLeadDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

@ApiTags('Leads')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class LeadController {
  constructor(private readonly leads: LeadService) {}

  @Post('icps/:icpId/qualify')
  @HttpCode(202)
  @ApiOperation({ summary: '对 ACTIVE ICP 的全部候选公司做六维评分 → Lead + 四队列（异步）' })
  @ApiEnvelope(
    {
      type: 'object',
      properties: {
        accepted: { type: 'boolean' },
        eventId: { type: 'string', format: 'uuid' },
      },
    },
    { status: 202 },
  )
  async qualify(@Ctx() ctx: RequestContext, @Param('icpId', ParseUUIDPipe) icpId: string) {
    return envelope(await this.leads.qualify(ctx, icpId));
  }

  @Get('leads')
  @ApiOperation({ summary: 'Lead 列表（?icpId=&queue=recommended|needs_review|rejected|suppressed，按分数排序）' })
  @ApiPageEnvelope(LEAD_SCHEMA)
  async list(
    @Ctx() ctx: RequestContext,
    @Query('icpId') icpId?: string,
    @Query('queue') queue?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const r = await this.leads.list(ctx, { icpId, queue, status, limit: n, cursor });
    return pageEnvelope(r.data, r);
  }

  @Get('icps/:icpId/lead-queues')
  @ApiOperation({ summary: '四队列计数（推荐/待确认/拒绝/禁联）' })
  @ApiEnvelope({
    type: 'object',
    properties: {
      recommended: { type: 'integer' },
      needs_review: { type: 'integer' },
      rejected: { type: 'integer' },
      suppressed: { type: 'integer' },
    },
  })
  async queues(@Ctx() ctx: RequestContext, @Param('icpId', ParseUUIDPipe) icpId: string) {
    return envelope(await this.leads.queueSummary(ctx, icpId));
  }

  @Get('leads/:leadId')
  @ApiOperation({ summary: 'Lead 详情：六维分 + 规则逐条评估依据 + 公司/联系人 + 裁决历史' })
  @ApiEnvelope(LEAD_SCHEMA)
  async get(@Ctx() ctx: RequestContext, @Param('leadId', ParseUUIDPipe) leadId: string) {
    return envelope(await this.leads.get(ctx, leadId));
  }

  @Post('leads/:leadId/accept')
  @HttpCode(200)
  @ApiOperation({ summary: '接受 Lead（→ QUALIFIED，发 LeadQualified —— 交给 Campaign 的出口）' })
  @ApiEnvelope(LEAD_SCHEMA)
  async accept(
    @Ctx() ctx: RequestContext,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body() dto: AcceptLeadDto,
  ) {
    return envelope(await this.leads.decide(ctx, leadId, 'accept', dto.reason));
  }

  @Post('leads/:leadId/reject')
  @HttpCode(200)
  @ApiOperation({ summary: '拒绝 Lead（→ REJECTED，原因留痕做质量反馈）' })
  @ApiEnvelope(LEAD_SCHEMA)
  async reject(
    @Ctx() ctx: RequestContext,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body() dto: RejectLeadDto,
  ) {
    return envelope(await this.leads.decide(ctx, leadId, 'reject', dto.reason));
  }
}
