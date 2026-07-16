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
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsUUID } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { Enveloped, envelope } from '../common/envelope';
import { BuildsService } from './builds.service';
import type { BuildOptionsInput } from './refurbish-launcher';

class CreateBuildDto {
  @ApiProperty({ enum: ['site', 'page', 'section'] })
  @IsIn(['site', 'page', 'section'])
  scope!: 'site' | 'page' | 'section';

  @ApiProperty({ required: false, description: 'scope=page/section 时的目标 id' })
  @IsOptional()
  @IsUUID()
  targetId?: string;

  @ApiProperty({ required: false, description: '{ stylePreset?, pages?, locales? }' })
  @IsOptional()
  @IsObject()
  options?: BuildOptionsInput;
}

@ApiTags('SiteBuilder')
@ApiBearerAuth()
@Controller('site-builder')
@UseGuards(AuthGuard)
export class BuildsController {
  constructor(private readonly builds: BuildsService) {}

  @Post('sites/:id/builds')
  @HttpCode(201)
  @ApiOperation({ summary: '触发精装修构建（07 §5；409=进行中，429=当日配额）' })
  @ApiResponse({ status: 409, description: 'BUILD_IN_PROGRESS' })
  @ApiResponse({ status: 429, description: 'QUOTA_EXCEEDED；details.remaining 为剩余额度' })
  @ApiResponse({ status: 502, description: 'BUILD_LAUNCH_UNAVAILABLE；可安全重试' })
  // name 必须与 @Headers('idempotency-key') 推断名精确一致（含大小写）才会合并成单个 required:false 参数；
  // 大小写不一致会生成两个仅大小写不同的 header 参数，令 oasdiff 把契约与自身误判为破坏性变更（见 company.controller 同款约定）
  @ApiHeader({ name: 'idempotency-key', required: false, description: '幂等键（客户端生成，如 uuid）' })
  async create(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Body() dto: CreateBuildDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Enveloped<{ buildId: string; status: string }>> {
    return envelope(
      await this.builds.create(ctx, siteId, { ...dto, idempotencyKey: idempotencyKey ?? null }),
    );
  }

  @Get('builds/:id')
  @ApiOperation({ summary: '构建进度（轮询；SSE 事件流按 07 §5 后置）' })
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
  @ApiResponse({
    status: 409,
    description: 'BUILD_NOT_CANCELLABLE 或 BUILD_ALREADY_TERMINAL',
  })
  async cancel(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) buildId: string,
  ): Promise<Enveloped<{ buildId: string; status: string }>> {
    return envelope(await this.builds.cancel(ctx, buildId));
  }
}
