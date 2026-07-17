import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { Enveloped, envelope } from '../common/envelope';
import { BuildsService } from './builds.service';
import { CreateBuildDto } from './dto/build.dto';
import { IDEMPOTENCY_KEY_PATTERN_SOURCE } from './idempotency-key';

class BuildActionResponseDto {
  @ApiProperty({ format: 'uuid' })
  buildId!: string;

  @ApiProperty()
  status!: string;
}

class BuildStatusResponseDto {
  @ApiProperty({ format: 'uuid' })
  buildId!: string;

  @ApiProperty()
  kind!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  phase!: string | null;

  @ApiProperty()
  progress!: number;

  @ApiProperty({
    type: 'array',
    nullable: true,
    items: {
      type: 'object',
      required: ['key', 'status'],
      properties: {
        key: { type: 'string' },
        status: { type: 'string' },
        attempt: { type: 'integer', minimum: 1 },
        startedAt: { type: 'string', format: 'date-time', nullable: true },
        finishedAt: { type: 'string', format: 'date-time', nullable: true },
        error: { type: 'string', nullable: true },
      },
      // R3-5 会把各阶段的有界观测字段（processed/failed/gaps 等）逐步升格；
      // R2 先准确声明数组基形，避免把运行时数组错误生成为单个 object。
      additionalProperties: true,
    },
  })
  steps!: Array<Record<string, unknown>> | null;

  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true })
  costSummary!: Record<string, unknown> | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '泛化错误；不含 worker/provider 诊断',
  })
  error!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  finishedAt!: Date | null;
}

const BUILD_ERROR_CODES = [
  'VALIDATION_ERROR',
  'INVALID_IDEMPOTENCY_KEY',
  'IDEMPOTENCY_KEY_REUSED',
  'NOT_FOUND',
  'BUILD_IN_PROGRESS',
  'BUILD_SCOPE_UNAVAILABLE',
  'BUILD_OPTION_UNAVAILABLE',
  'BUILD_NOT_CANCELLABLE',
  'BUILD_ALREADY_TERMINAL',
  'BUILD_LAUNCH_UNAVAILABLE',
  'BUILD_CANCEL_UNAVAILABLE',
  'QUOTA_EXCEEDED',
] as const;

const BUILD_ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', enum: [...BUILD_ERROR_CODES] },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
    },
  },
};

@ApiTags('SiteBuilder')
@ApiBearerAuth()
@Controller('site-builder')
@UseGuards(AuthGuard)
export class BuildsController {
  constructor(private readonly builds: BuildsService) {}

  @Post('sites/:id/builds')
  @HttpCode(201)
  @ApiOperation({
    summary: '触发精装修构建（07 §5；409=进行中，429=当日配额）',
  })
  @ApiEnvelope(BuildActionResponseDto, { status: 201 })
  @ApiBody({
    description:
      'R3-B1 当前可执行面：整站构建；page/section/pages/非 en 在实现前 fail-closed',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['scope'],
      properties: {
        scope: { type: 'string', enum: ['site'] },
        options: {
          type: 'object',
          additionalProperties: false,
          properties: {
            stylePreset: {
              type: 'string',
              enum: ['modern-industrial', 'precision-light'],
            },
            locales: {
              type: 'array',
              minItems: 1,
              maxItems: 1,
              uniqueItems: true,
              items: { type: 'string', enum: ['en'] },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'UUID 或 build scope 校验失败',
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: '当前 workspace 不可见该 Site',
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'BUILD_IN_PROGRESS 或 IDEMPOTENCY_KEY_REUSED',
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 422,
    description:
      'BUILD_SCOPE_UNAVAILABLE 或 BUILD_OPTION_UNAVAILABLE；未实现能力 fail-closed',
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 429,
    description: 'QUOTA_EXCEEDED；details.remaining 为剩余额度',
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 502,
    description:
      'BUILD_LAUNCH_UNAVAILABLE；仅同一合法 Idempotency-Key 可安全重放',
    schema: BUILD_ERROR_SCHEMA,
  })
  // name 必须与 @Headers('idempotency-key') 推断名精确一致（含大小写）才会合并成单个 required:false 参数；
  // 大小写不一致会生成两个仅大小写不同的 header 参数，令 oasdiff 把契约与自身误判为破坏性变更（见 company.controller 同款约定）
  @ApiHeader({
    name: 'idempotency-key',
    required: false,
    schema: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: `^${IDEMPOTENCY_KEY_PATTERN_SOURCE}$`,
    },
    description: '幂等键；同 key 异请求返回 409',
  })
  async create(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Body() dto: CreateBuildDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Enveloped<{ buildId: string; status: string }>> {
    return envelope(
      await this.builds.create(ctx, siteId, {
        ...dto,
        idempotencyKey: idempotencyKey ?? null,
      }),
    );
  }

  @Get('builds/:id')
  @ApiOperation({ summary: '构建进度（轮询；SSE 事件流按 07 §5 后置）' })
  @ApiEnvelope(BuildStatusResponseDto)
  @ApiResponse({
    status: 400,
    description: 'Build UUID 格式错误',
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: '当前 workspace 不可见该 Build',
    schema: BUILD_ERROR_SCHEMA,
  })
  async get(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) buildId: string,
  ): Promise<Enveloped<Record<string, unknown>>> {
    const run = await this.builds.get(ctx, buildId);
    return envelope({
      buildId: run.id,
      kind: run.kind,
      status: run.status,
      phase: run.phase,
      progress: run.progress,
      steps: run.steps,
      costSummary: run.costSummary,
      // DB error 供内部诊断，可能含 provider/网络细节；公共 API 只返回稳定泛化文本。
      error: run.error ? 'build failed' : null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    });
  }

  @Post('builds/:id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: '取消构建（终态 409）' })
  @ApiEnvelope(BuildActionResponseDto)
  @ApiResponse({
    status: 400,
    description: 'Build UUID 格式错误',
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: '当前 workspace 不可见该 Build',
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'BUILD_NOT_CANCELLABLE 或 BUILD_ALREADY_TERMINAL',
    schema: BUILD_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 502,
    description:
      'BUILD_CANCEL_UNAVAILABLE；Temporal 未确认取消，run 保持 active，可按同 buildId 重试',
    schema: BUILD_ERROR_SCHEMA,
  })
  async cancel(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) buildId: string,
  ): Promise<Enveloped<{ buildId: string; status: string }>> {
    return envelope(await this.builds.cancel(ctx, buildId));
  }
}
