/**
 * 人工复核队列 API（P3 J17；设计 §4.3.8.1）。
 *
 * 权限：队列读写 `acquisition:review`；单条判定明细 `acquisition:read`。
 * BFF（gain-saas 运营台）按各自角色映射这两个 scope，本控制器只认 scope。
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { AuthGuard } from '../../auth/auth.guard';
import { Ctx } from '../../auth/ctx.decorator';
import { RequireScopes } from '../../auth/require-scopes.decorator';
import { RequestContext } from '../../auth/request-context';
import { ScopesGuard } from '../../auth/scopes.guard';
import { Enveloped, envelope } from '../../common/envelope';
import { ApiEnvelope } from '../../common/api-envelope.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CRITERION_IDS,
  CRITERION_LABELS,
  type CriterionId,
} from './fit-rubric';
import {
  REVIEW_PRIORITIES,
  REVIEW_REASONS,
  REVIEW_STATUSES,
  REVIEW_VERDICTS,
  ReviewOverrideError,
  ReviewTaskNotFoundError,
  ReviewTaskStateError,
  claimReviewTask,
  getJudgment,
  judgmentReviewStats,
  listReviewTasks,
  resolveReviewTask,
  type ReviewPriority,
  type ReviewStatus,
} from './review-queue';

class CriterionOverrideDto {
  @ApiProperty({ enum: [...CRITERION_IDS] })
  @IsIn([...CRITERION_IDS])
  id!: CriterionId;

  @ApiPropertyOptional({ description: '0–10 或 null（null=仅改 label）', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  score?: null | number;

  @ApiPropertyOptional({ enum: [...CRITERION_LABELS] })
  @IsOptional()
  @IsIn([...CRITERION_LABELS])
  label?: (typeof CRITERION_LABELS)[number];
}

class ResolveReviewTaskDto {
  @ApiProperty({ enum: [...REVIEW_VERDICTS] })
  @IsIn([...REVIEW_VERDICTS])
  verdict!: (typeof REVIEW_VERDICTS)[number];

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({ type: [CriterionOverrideDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CriterionOverrideDto)
  criterionOverrides?: CriterionOverrideDto[];
}

const REVIEW_TASK_SCHEMA = {
  type: 'object',
  required: [
    'id',
    'judgmentRecordId',
    'reason',
    'priority',
    'status',
    'dueAt',
    'verdictAtJudge',
    'companyName',
  ],
  properties: {
    id: { type: 'string' },
    judgmentRecordId: { type: 'string' },
    reason: { type: 'string', enum: [...REVIEW_REASONS] },
    priority: { type: 'number', enum: [...REVIEW_PRIORITIES] },
    status: { type: 'string', enum: [...REVIEW_STATUSES] },
    dueAt: { type: 'string', nullable: true },
    verdictAtJudge: { type: 'string', enum: [...REVIEW_VERDICTS] },
    companyName: { type: 'string', nullable: true },
  },
  additionalProperties: false,
} as const;

const REVIEW_TASK_LIST_SCHEMA = {
  type: 'object',
  required: ['items', 'nextCursor'],
  properties: {
    items: { type: 'array', items: REVIEW_TASK_SCHEMA },
    nextCursor: { type: 'string', nullable: true },
  },
  additionalProperties: false,
} as const;

const RESOLVE_RESULT_SCHEMA = {
  type: 'object',
  required: ['recordId', 'goldenLabelId'],
  properties: {
    recordId: { type: 'string' },
    goldenLabelId: { type: 'string' },
  },
  additionalProperties: false,
} as const;

function mapServiceError(error: unknown): never {
  if (error instanceof ReviewTaskNotFoundError) {
    throw new NotFoundException(error.message);
  }
  if (error instanceof ReviewTaskStateError) {
    throw new ConflictException(error.message);
  }
  if (error instanceof ReviewOverrideError) {
    throw new BadRequestException(error.message);
  }
  throw error;
}

@ApiTags('JudgmentReview')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard, ScopesGuard)
export class JudgmentReviewController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('judgment-reviews')
  @RequireScopes('acquisition:review')
  @ApiOperation({ summary: '人工复核队列（按优先级/SLA 排序，keyset 分页）' })
  @ApiQuery({ name: 'status', required: false, enum: [...REVIEW_STATUSES] })
  @ApiQuery({ name: 'priority', required: false, enum: [...REVIEW_PRIORITIES] })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiEnvelope(REVIEW_TASK_LIST_SCHEMA)
  async list(
    @Ctx() ctx: RequestContext,
    @Query('status') status?: string,
    @Query('priority') priority?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<Enveloped<unknown>> {
    if (status !== undefined && !(REVIEW_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(`unknown status ${status}`);
    }
    let parsedPriority: ReviewPriority | undefined;
    if (priority !== undefined) {
      const value = Number(priority);
      if (!(REVIEW_PRIORITIES as readonly number[]).includes(value)) {
        throw new BadRequestException(`unknown priority ${priority}`);
      }
      parsedPriority = value as ReviewPriority;
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException('limit must be a positive integer');
    }
    try {
      return envelope(
        await listReviewTasks(this.prisma, ctx.workspaceId, {
          status: status as ReviewStatus | undefined,
          priority: parsedPriority,
          limit: parsedLimit,
          cursor,
        }),
      );
    } catch (error) {
      mapServiceError(error);
    }
  }

  @Post('judgment-reviews/:id/claim')
  @RequireScopes('acquisition:review')
  @HttpCode(200)
  @ApiOperation({ summary: '认领复核任务（queued → in_review，同人幂等）' })
  @ApiEnvelope({
    type: 'object',
    required: ['status'],
    properties: { status: { type: 'string' } },
    additionalProperties: false,
  })
  async claim(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Enveloped<unknown>> {
    try {
      return envelope(await claimReviewTask(this.prisma, ctx.workspaceId, id, ctx.userId));
    } catch (error) {
      mapServiceError(error);
    }
  }

  @Post('judgment-reviews/:id/resolve')
  @RequireScopes('acquisition:review')
  @HttpCode(200)
  @ApiOperation({
    summary: '提交复核结论（写新 human judgment_record + golden label candidate，任务 resolved）',
  })
  @ApiEnvelope(RESOLVE_RESULT_SCHEMA)
  async resolve(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveReviewTaskDto,
  ): Promise<Enveloped<unknown>> {
    try {
      return envelope(
        await resolveReviewTask(
          this.prisma,
          ctx.workspaceId,
          id,
          {
            verdict: dto.verdict,
            note: dto.note ?? null,
            criterionOverrides: dto.criterionOverrides ?? [],
          },
          ctx.userId,
        ),
      );
    } catch (error) {
      mapServiceError(error);
    }
  }

  @Get('judgments/stats')
  @RequireScopes('acquisition:review')
  @ApiOperation({ summary: '复核队列统计（分布 + overturn rate）' })
  @ApiQuery({ name: 'window', required: false, description: '窗口天数，默认 7' })
  @ApiEnvelope({
    type: 'object',
    required: ['windowDays', 'byStatus', 'byReason', 'byPriority', 'overturn'],
    properties: {
      windowDays: { type: 'number' },
      byStatus: { type: 'object', additionalProperties: { type: 'number' } },
      byReason: { type: 'object', additionalProperties: { type: 'number' } },
      byPriority: { type: 'object', additionalProperties: { type: 'number' } },
      overturn: {
        type: 'object',
        required: ['resolved', 'overturned', 'rate'],
        properties: {
          resolved: { type: 'number' },
          overturned: { type: 'number' },
          rate: { type: 'number', nullable: true },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  })
  async stats(
    @Ctx() ctx: RequestContext,
    @Query('window') window?: string,
  ): Promise<Enveloped<unknown>> {
    const parsed = window === undefined ? 7 : Number(window);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 90) {
      throw new BadRequestException('window must be an integer number of days (1..90)');
    }
    return envelope(
      await judgmentReviewStats(this.prisma, ctx.workspaceId, parsed),
    );
  }

  @Get('judgments/:id')
  @RequireScopes('acquisition:read')
  @ApiOperation({ summary: '单条判定明细（含 criteria 与失败码）' })
  @ApiEnvelope({
    type: 'object',
    description: 'judgment_record 明细（criteria/verdict/model/failureCode）',
    additionalProperties: true,
  })
  async detail(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Enveloped<unknown>> {
    const detail = await getJudgment(this.prisma, ctx.workspaceId, id);
    if (!detail) throw new NotFoundException(`judgment ${id} not found`);
    return envelope(detail);
  }
}
