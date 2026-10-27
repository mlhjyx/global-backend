import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { envelope, pageEnvelope } from '../common/envelope';
import { ApiEnvelope, ApiPageEnvelope } from '../common/api-envelope.decorator';
import { LeadService } from './lead.service';
import { LEAD_QUEUE_BASES } from './lead-queue-basis';
import { OUTCOME_REASON_CODES, REJECT_REASON_CODES } from './reason-codes';

const LEAD_QUEUE_BASIS_SCHEMA = {
  type: 'string',
  enum: [...LEAD_QUEUE_BASES],
  description:
    '队列依据：fit_gate_preset = fit 门按 verdict 预置、评分从未跑过；score = 评分阶段算出；human_accept / human_reject = 人工裁决',
};

/** Lead 行（六维分+队列）；完整字段结构化 DTO 待收口⑤ 一等 Signal 后定型。 */
const LEAD_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: 'Lead（六维分+队列+裁决状态）',
  required: ['scored', 'queueBasis'],
  properties: {
    scored: { type: 'boolean', description: 'total_score 非空：队列已由评分决定；false = 仍是 fit 门预置' },
    queueBasis: LEAD_QUEUE_BASIS_SCHEMA,
  },
};

const leadDecisionErrorSchema = (codes: readonly string[]) => ({
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

class RejectLeadDto {
  // Kept optional in the published contract (making it required is a breaking change needing a
  // major bump): the service owns presence (422 REASON_CODE_REQUIRED, the design's status for a
  // missing code) and membership (422 INVALID_REASON_CODE); the DTO only checks string-ness, so
  // both documented service errors stay reachable over HTTP.
  @ApiPropertyOptional({
    enum: [...REJECT_REASON_CODES],
    description: 'BI-20 拒绝原因码（reject 必填，缺失返回 422 REASON_CODE_REQUIRED；自由文本放 reason）',
  })
  @ValidateIf((dto: RejectLeadDto) => dto.reasonCode !== undefined)
  @IsString()
  reasonCode?: string;

  @ApiPropertyOptional({ description: '拒绝原因备注（自由文本，回流做评分质量反馈）' })
  @IsOptional()
  @IsString()
  reason?: string;
}

class AcceptLeadDto {
  @ApiPropertyOptional({ enum: [...OUTCOME_REASON_CODES], description: '接受原因码（可选，如 GOOD_FIT）' })
  @IsOptional()
  @IsString()
  reasonCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reason?: string;
}

class LeadOutcomeDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: '客户判断：相关性 1–5' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  relevance?: number;

  @ApiPropertyOptional({ description: '客户判断：是否愿意联系' })
  @IsOptional()
  @IsBoolean()
  willingToContact?: boolean;

  @ApiPropertyOptional({ enum: [...OUTCOME_REASON_CODES], description: '失败/未达成或正向结果原因码' })
  @IsOptional()
  @IsIn(OUTCOME_REASON_CODES)
  reasonCode?: string;

  @ApiPropertyOptional({ maxLength: 2000, description: '客户备注（自由文本）' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({ description: '客户判断：是否已联系' })
  @IsOptional()
  @IsBoolean()
  contacted?: boolean;

  @ApiPropertyOptional({ enum: ['customer', 'operator'], description: '反馈来源；默认 operator' })
  @IsOptional()
  @IsIn(['customer', 'operator'])
  source?: 'customer' | 'operator';
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
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:read')
export class LeadController {
  constructor(private readonly leads: LeadService) {}

  @Post('icps/:icpId/qualify')
  @RequireScopes('acquisition:write')
  @HttpCode(202)
  @ApiOperation({ summary: '对 ACTIVE ICP 的全部候选公司做六维评分 → Lead + 四队列（异步）',
  })
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
  @ApiOperation({ summary: 'Lead 列表（?icpId=&queue=recommended|needs_review|rejected|suppressed，按分数排序）',
  })
  // swagger 对裸 @Query 推断 required:true（无 CLI 插件），可选参数必须显式声明（同 events.controller）
  @ApiQuery({ name: 'icpId', required: false })
  @ApiQuery({ name: 'queue', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', default: 20, maximum: 100 },
  })
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
    const r = await this.leads.list(ctx, { icpId, queue, status, limit: n, cursor,
    });
    return pageEnvelope(r.data, r);
  }

  @Get('icps/:icpId/lead-queues')
  @ApiOperation({ summary: '五队列计数（推荐/待确认/拒绝/禁联/制裁隔离）+ 队列依据（预置 / 评分 / 人工）' })
  @ApiEnvelope({
    type: 'object',
    required: ['recommended', 'needs_review', 'rejected', 'suppressed', 'sanctions_hold', 'scored', 'queueBasis'],
    properties: {
      recommended: { type: 'integer' },
      needs_review: { type: 'integer' },
      rejected: { type: 'integer' },
      suppressed: { type: 'integer' },
      sanctions_hold: { type: 'integer' },
      scored: {
        type: 'boolean',
        description: '每条 lead 都有 total_score（计数全部出自评分或人工裁决）；false = 至少一条仍是 fit 门预置，或 ICP 无 lead',
      },
      queueBasis: {
        type: 'object',
        description: '按队列依据计数，四项之和 = lead 总数',
        required: [...LEAD_QUEUE_BASES],
        properties: Object.fromEntries(LEAD_QUEUE_BASES.map((basis) => [basis, { type: 'integer' }])),
      },
    },
  })
  async queues(@Ctx() ctx: RequestContext, @Param('icpId', ParseUUIDPipe) icpId: string) {
    return envelope(await this.leads.queueSummary(ctx, icpId));
  }

  @Get('leads/:leadId')
  @RequireScopes('acquisition:read', 'personal-data:read')
  @ApiOperation({ summary: 'Lead 详情：六维分 + 规则逐条评估依据 + 公司/联系人 + 裁决历史',
  })
  @ApiEnvelope(LEAD_SCHEMA)
  async get(@Ctx() ctx: RequestContext, @Param('leadId', ParseUUIDPipe) leadId: string) {
    return envelope(await this.leads.get(ctx, leadId));
  }

  @Get('leads/:leadId/package')
  @RequireScopes('acquisition:read')
  @ApiOperation({
    summary: '交付读模型 LeadPackage：公司事实、建议联系路径、信号、证据 URL、原因码（不含具名联系人）',
  })
  @ApiEnvelope({ type: 'object', additionalProperties: true, description: 'LeadPackage（设计 §2）' })
  async leadPackage(@Ctx() ctx: RequestContext, @Param('leadId', ParseUUIDPipe) leadId: string) {
    return envelope(await this.leads.leadPackage(ctx, leadId));
  }

  @Post('leads/:leadId/outcomes')
  @RequireScopes('acquisition:review')
  @HttpCode(201)
  @ApiOperation({ summary: '回写线索结果（BI-23）：只追加，客户或运营填写相关性/意愿/原因码/备注/是否已联系' })
  @ApiResponse({
    status: 400,
    description: '字段类型或取值不合法（相关性不在 1–5、原因码不在枚举、备注超长）',
    schema: leadDecisionErrorSchema(['VALIDATION_ERROR']),
  })
  @ApiResponse({
    status: 422,
    description: '整条反馈没有任何已填字段',
    schema: leadDecisionErrorSchema(['OUTCOME_EMPTY']),
  })
  @ApiEnvelope({ type: 'object', additionalProperties: true, description: '新建的 lead_outcome 行' }, { status: 201 })
  async recordOutcome(
    @Ctx() ctx: RequestContext,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body() dto: LeadOutcomeDto,
  ) {
    return envelope(await this.leads.recordOutcome(ctx, leadId, dto));
  }

  @Post('leads/:leadId/accept')
  @RequireScopes('acquisition:review')
  @HttpCode(200)
  @ApiOperation({ summary: '接受 Lead（→ QUALIFIED，发 LeadQualified —— 交给 Campaign 的出口）',
  })
  @ApiResponse({
    status: 400,
    description: '路径或请求体验证失败',
    schema: leadDecisionErrorSchema(['VALIDATION_ERROR']),
  })
  @ApiResponse({
    status: 404,
    description: 'Lead 或其公司不存在',
    schema: leadDecisionErrorSchema(['NOT_FOUND']),
  })
  @ApiResponse({
    status: 422,
    description: 'accept 带的原因码不在枚举（可选字段，缺省不校验）',
    schema: leadDecisionErrorSchema(['INVALID_REASON_CODE']),
  })
  @ApiResponse({
    status: 409,
    description: '当前 suppression/合规/制裁状态阻断交付',
    schema: leadDecisionErrorSchema([
      'SUPPRESSED',
      'INVALID_STATE',
      'SUPPRESSED_CONTACT_UNREACHABLE',
      'STORAGE_RIGHTS_NOT_GRANTED',
      'SANCTIONS_HOLD_UNRESOLVED',
      'CONFLICT',
    ]),
  })
  @ApiEnvelope(LEAD_SCHEMA)
  async accept(
    @Ctx() ctx: RequestContext,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body() dto: AcceptLeadDto) {
    return envelope(await this.leads.decide(ctx, leadId, 'accept', dto.reason, dto.reasonCode));
  }

  @Post('leads/:leadId/reject')
  @RequireScopes('acquisition:review')
  @HttpCode(200)
  @ApiOperation({ summary: '拒绝 Lead（→ REJECTED，原因留痕做质量反馈）' })
  @ApiResponse({
    status: 400,
    description: '路径或请求体验证失败',
    schema: leadDecisionErrorSchema(['VALIDATION_ERROR']),
  })
  @ApiResponse({
    status: 422,
    description: 'reject 缺少原因码或原因码不在枚举（BI-20）',
    schema: leadDecisionErrorSchema(['REASON_CODE_REQUIRED', 'INVALID_REASON_CODE']),
  })
  @ApiResponse({
    status: 404,
    description: 'Lead 不存在',
    schema: leadDecisionErrorSchema(['NOT_FOUND']),
  })
  @ApiResponse({
    status: 409,
    description: '当前状态阻断拒绝裁决',
    schema: leadDecisionErrorSchema(['SUPPRESSED', 'INVALID_STATE', 'CONFLICT']),
  })
  @ApiEnvelope(LEAD_SCHEMA)
  async reject(
    @Ctx() ctx: RequestContext,
    @Param('leadId', ParseUUIDPipe) leadId: string,
    @Body() dto: RejectLeadDto) {
    return envelope(await this.leads.decide(ctx, leadId, 'reject', dto.reason, dto.reasonCode));
  }

  @Post('leads/:leadId/sanctions-review')
  @RequireScopes(
    'acquisition:review',
    'compliance:manage')
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
