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
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { envelope, pageEnvelope } from '../common/envelope';
import { ApiEnvelope, ApiPageEnvelope } from '../common/api-envelope.decorator';
import { LeadService } from './lead.service';

/** Lead 行（六维分+队列）；完整字段结构化 DTO 待收口⑤ 一等 Signal 后定型。 */
const LEAD_SCHEMA = { type: 'object', additionalProperties: true, description: 'Lead（六维分+队列+裁决状态）' };

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

class SanctionsReviewDto {
  @ApiProperty({
    enum: ['cleared_false_positive', 'confirmed_true_hit'],
    description: '复核裁决：误报清白（回落队列，抑制复发）/ 真命中确认（留隔离，永不交付）',
  })
  @IsIn(['cleared_false_positive', 'confirmed_true_hit'])
  decision!: 'cleared_false_positive' | 'confirmed_true_hit';

  @ApiPropertyOptional({ description: '复核备注（留痕）' })
  @IsOptional()
  @IsString()
  note?: string;
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
      required: ['accepted', 'eventId'],
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
  // swagger 对裸 @Query 推断 required:true（无 CLI 插件），可选参数必须显式声明（同 events.controller）
  @ApiQuery({ name: 'icpId', required: false })
  @ApiQuery({ name: 'queue', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', default: 20, maximum: 100 } })
  @ApiQuery({ name: 'cursor', required: false })
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
    required: ['recommended', 'needs_review', 'rejected', 'suppressed'],
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

  @Post('leads/:leadId/sanctions-review')
  @HttpCode(200)
  @ApiOperation({
    summary: '制裁筛查复核裁决（第五门人审）：误报清白 → 回落队列；真命中确认 → 留隔离，永不交付',
  })
  @ApiEnvelope({
    type: 'object',
    properties: { leadId: { type: 'string' }, reviewState: { type: 'string' } },
  })
  async sanctionsReview(
    @Ctx() ctx: RequestContext,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body() dto: SanctionsReviewDto,
  ) {
    return envelope(await this.leads.reviewSanctions(ctx, leadId, dto.decision, dto.note));
  }
}
