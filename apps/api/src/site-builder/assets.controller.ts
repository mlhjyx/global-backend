import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Logger,
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
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Length, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { ApiEnvelope, ApiListEnvelope } from '../common/api-envelope.decorator';
import { Enveloped, envelope } from '../common/envelope';
import { ASSET_KINDS } from './object-key';
import { AssetsService } from './assets.service';
import { KB_INGEST_LAUNCHER, KbIngestLauncher } from './refurbish-launcher';

class PresignDto {
  @ApiProperty({ enum: [...ASSET_KINDS] })
  @IsIn([...ASSET_KINDS])
  kind!: string;

  @ApiProperty()
  @IsString()
  @Length(1, 255)
  filename!: string;

  @ApiProperty({ description: '字节数' })
  @IsInt()
  @Min(1)
  size!: number;

  @ApiProperty({ example: 'image/jpeg' })
  @IsString()
  @Length(1, 120)
  mime!: string;
}

class PresignAssetResponseDto {
  @ApiProperty({ format: 'uuid' })
  assetId!: string;

  @ApiProperty({ format: 'uri' })
  uploadUrl!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: Date;
}

class CommitAssetResponseDto {
  @ApiProperty({ format: 'uuid' })
  assetId!: string;

  @ApiProperty({ enum: ['queued', 'ready'] })
  processingStatus!: string;
}

class AssetListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: [...ASSET_KINDS] })
  kind!: string;

  @ApiProperty()
  filename!: string;

  @ApiProperty()
  mime!: string;

  @ApiProperty()
  sizeBytes!: number;

  @ApiProperty()
  processingStatus!: string;

  @ApiProperty({ nullable: true, required: false })
  contentHash!: string | null;

  @ApiProperty({ nullable: true, required: false })
  processingErrorCode!: string | null;

  @ApiProperty({ nullable: true, required: false, description: '泛化错误；不含内部依赖诊断' })
  error!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

const ASSET_ERROR_CODES = [
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'ASSET_VALIDATION_FAILED',
  'ASSET_UPLOAD_INCOMPLETE',
  'ASSET_DUPLICATE',
  'ASSET_STATE_CONFLICT',
  'ASSET_BUSY',
  'ASSET_STORAGE_UNAVAILABLE',
  'ASSET_COMMIT_UNAVAILABLE',
] as const;

const ASSET_ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', enum: [...ASSET_ERROR_CODES] },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
    },
  },
};

function publicAssetErrorCode(status: string, storedCode: string | null): string | null {
  if (storedCode) return storedCode;
  if (status === 'duplicate') return 'ASSET_DUPLICATE';
  if (status === 'rejected') return 'ASSET_VALIDATION_FAILED';
  if (status === 'failed_retryable') return 'ASSET_COMMIT_UNAVAILABLE';
  return null;
}

function publicAssetErrorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === 'ASSET_DUPLICATE') return 'Asset duplicates existing content.';
  if (code === 'ASSET_VALIDATION_FAILED') return 'Asset validation failed.';
  return 'Asset processing is temporarily unavailable.';
}

@ApiTags('SiteBuilder')
@ApiBearerAuth()
@Controller('site-builder')
@UseGuards(AuthGuard)
export class AssetsController {
  private readonly log = new Logger(AssetsController.name);

  constructor(
    private readonly assets: AssetsService,
    @Inject(KB_INGEST_LAUNCHER) private readonly kbLauncher: KbIngestLauncher,
  ) {}

  @Post('sites/:id/assets/presign')
  @HttpCode(201)
  @ApiOperation({ summary: '素材上传第 1 步：校验并签发直传 URL（15 分钟有效）' })
  @ApiEnvelope(PresignAssetResponseDto, { status: 201 })
  @ApiResponse({ status: 400, description: 'UUID 或请求体格式错误', schema: ASSET_ERROR_SCHEMA })
  @ApiResponse({ status: 404, description: '当前 workspace 不可见该 Site', schema: ASSET_ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: '素材类型、MIME 或大小不合格', schema: ASSET_ERROR_SCHEMA })
  @ApiResponse({ status: 502, description: '对象存储暂不可用', schema: ASSET_ERROR_SCHEMA })
  async presign(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Body() dto: PresignDto,
  ): Promise<Enveloped<{ assetId: string; uploadUrl: string; expiresAt: Date }>> {
    return envelope(await this.assets.presign(ctx, siteId, dto));
  }

  @Post('assets/:id/commit')
  @ApiOperation({ summary: '素材上传第 3 步：魔数/大小/去重校验 → 归位；doc 类进 KB 队列' })
  @ApiEnvelope(CommitAssetResponseDto, { status: 201 })
  @ApiResponse({ status: 400, description: 'Asset UUID 格式错误', schema: ASSET_ERROR_SCHEMA })
  @ApiResponse({ status: 404, description: '当前 workspace 不可见该 Asset', schema: ASSET_ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: '未上传、重复、忙或状态冲突', schema: ASSET_ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: '素材内容校验失败', schema: ASSET_ERROR_SCHEMA })
  @ApiResponse({ status: 502, description: '对象存储暂不可用', schema: ASSET_ERROR_SCHEMA })
  @ApiResponse({ status: 503, description: '提交持久化暂不可用', schema: ASSET_ERROR_SCHEMA })
  async commit(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) assetId: string,
  ): Promise<Enveloped<{ assetId: string; processingStatus: string }>> {
    const row = await this.assets.commit(ctx, assetId);
    if (row.processingStatus === 'queued') {
      // M1-a：消费者上 Temporal（kbIngestWorkflow，workflowId 按 assetId 幂等，持久重试）。
      // 触发失败=文档留 queued（refurbish P1 / 下次 commit 再扫），不影响 commit 秒回。
      void this.kbLauncher
        .launchKbIngest({ workspaceId: ctx.workspaceId, siteId: row.siteId, assetId: row.id })
        .catch((err) => {
          this.log.warn(`kb ingest launch failed for site ${row.siteId}: ${String(err)}`);
        });
    }
    return envelope({ assetId: row.id, processingStatus: row.processingStatus });
  }

  @Get('sites/:id/assets')
  @ApiOperation({ summary: '站点素材列表' })
  @ApiQuery({ name: 'kind', required: false, enum: [...ASSET_KINDS] })
  @ApiListEnvelope(AssetListItemDto)
  @ApiResponse({ status: 400, description: 'Site UUID 格式错误', schema: ASSET_ERROR_SCHEMA })
  @ApiResponse({ status: 404, description: '当前 workspace 不可见该 Site', schema: ASSET_ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: '未知素材 kind', schema: ASSET_ERROR_SCHEMA })
  async list(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Query('kind') kind?: string,
  ): Promise<Enveloped<AssetListItemDto[]>> {
    const rows = await this.assets.list(ctx, siteId, kind);
    return envelope(
      rows.map((a) => ({
        id: a.id,
        kind: a.kind,
        filename: a.filename,
        mime: a.mime,
        sizeBytes: a.sizeBytes,
        processingStatus: a.processingStatus,
        contentHash: a.contentHash,
        processingErrorCode: publicAssetErrorCode(a.processingStatus, a.processingErrorCode),
        error: publicAssetErrorMessage(
          publicAssetErrorCode(a.processingStatus, a.processingErrorCode),
        ),
        createdAt: a.createdAt,
      })),
    );
  }

  @Delete('assets/:id')
  @HttpCode(204)
  @ApiOperation({ summary: '软删除素材；canonical 清理等待 MF-0 引用扫描器' })
  @ApiResponse({ status: 204, description: 'Asset 已 tombstone' })
  @ApiResponse({ status: 400, description: 'Asset UUID 格式错误', schema: ASSET_ERROR_SCHEMA })
  @ApiResponse({ status: 404, description: '当前 workspace 不可见该 Asset', schema: ASSET_ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'Asset 正由 commit/KB worker 持有', schema: ASSET_ERROR_SCHEMA })
  async remove(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) assetId: string,
  ): Promise<void> {
    await this.assets.remove(ctx, assetId);
  }
}
