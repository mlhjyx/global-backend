import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { Enveloped, envelope } from '../common/envelope';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { DeletionRequestView, DeletionService } from './deletion.service';
import { DELETION_REASONS, DELETION_STATUSES, DELETION_SUBJECT_TYPES, DeletionSubjectType } from './deletion.types';

class CreateDeletionRequestDto {
  @ApiProperty({ enum: DELETION_SUBJECT_TYPES, description: '删除主体类型' })
  @IsIn(DELETION_SUBJECT_TYPES as unknown as string[])
  subjectType!: DeletionSubjectType;

  @ApiProperty({ format: 'uuid', description: '主体行 id（canonical_contact.id 或 canonical_company.id）' })
  @IsUUID()
  subjectId!: string;

  @ApiPropertyOptional({ enum: DELETION_REASONS, description: '删除依据（默认 erasure）' })
  @IsOptional()
  @IsIn(DELETION_REASONS as unknown as string[])
  reason?: string;

  @ApiPropertyOptional({ description: '工单/LIA/请求来源引用（审计用，🔴 非明文 PII）' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  requestRef?: string;
}

/** DeletionRequestView 的 OpenAPI schema（code-first 单一真值，与 deletion.service.ts 的返回形状同源）。 */
const DELETION_REQUEST_SCHEMA = {
  type: 'object',
  required: ['id', 'status', 'subjectType', 'subjectId', 'createdAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: [...DELETION_STATUSES] },
    subjectType: { type: 'string', enum: [...DELETION_SUBJECT_TYPES] },
    subjectId: { type: 'string', format: 'uuid' },
    reason: { type: 'string', nullable: true },
    requestRef: { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    completedAt: { type: 'string', format: 'date-time', nullable: true },
    receipt: {
      type: 'object',
      nullable: true,
      description: '擦除回执（COMPLETED 后有值）——🔴 只计数，无 PII',
      properties: {
        contactsErased: { type: 'integer' },
        contactPointsErased: { type: 'integer' },
        fieldEvidenceErased: { type: 'integer' },
        signalsRevoked: { type: 'integer' },
        companiesSuppressed: { type: 'integer' },
        leadsRescoreRequested: { type: 'integer' },
        ruleVersion: { type: 'string' },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  },
};

/**
 * 收口⑥ PR-B 删除请求端点（GDPR Art.17 擦除编排）。
 * 🔐 授权模型：仅 AuthGuard（authN）+ RLS 工作区隔离——token 只能删本 workspace 内主体。本后端不做身份系统
 *（CLAUDE.md §1），「谁可发起 DSR 删除」的授权由 SaaS 签发 token 时控制；细粒度 RolesGuard 归 R1 加固。
 */
@ApiTags('Compliance')
@ApiBearerAuth()
@Controller('deletion-requests')
@UseGuards(AuthGuard)
export class DeletionController {
  constructor(private readonly deletion: DeletionService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: '受理数据主体删除请求（GDPR Art.17）——异步编排，返回 202 + 请求 id' })
  @ApiEnvelope(DELETION_REQUEST_SCHEMA, { status: 202 })
  async create(
    @Ctx() ctx: RequestContext,
    @Body() dto: CreateDeletionRequestDto,
  ): Promise<Enveloped<DeletionRequestView>> {
    return envelope(await this.deletion.createRequest(ctx.workspaceId, ctx.userId, dto));
  }

  @Get(':id')
  @ApiOperation({ summary: '查询删除请求状态与擦除回执' })
  @ApiEnvelope(DELETION_REQUEST_SCHEMA)
  async get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<Enveloped<DeletionRequestView>> {
    return envelope(await this.deletion.getRequest(ctx.workspaceId, id));
  }
}
