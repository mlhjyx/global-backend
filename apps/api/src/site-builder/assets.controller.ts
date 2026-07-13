import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Length, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { Enveloped, envelope } from '../common/envelope';
import { ASSET_KINDS } from './object-key';
import { AssetsService } from './assets.service';
import { KbService } from './kb.service';

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

@ApiTags('SiteBuilder')
@ApiBearerAuth()
@Controller('site-builder')
@UseGuards(AuthGuard)
export class AssetsController {
  private readonly log = new Logger(AssetsController.name);

  constructor(
    private readonly assets: AssetsService,
    private readonly kb: KbService,
  ) {}

  @Post('sites/:id/assets/presign')
  @HttpCode(201)
  @ApiOperation({ summary: '素材上传第 1 步：校验并签发直传 URL（15 分钟有效）' })
  async presign(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Body() dto: PresignDto,
  ): Promise<Enveloped<{ assetId: string; uploadUrl: string; expiresAt: Date }>> {
    return envelope(await this.assets.presign(ctx, siteId, dto));
  }

  @Post('assets/:id/commit')
  @ApiOperation({ summary: '素材上传第 3 步：魔数/大小/去重校验 → 归位；doc 类进 KB 队列' })
  async commit(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) assetId: string,
  ): Promise<Enveloped<{ assetId: string; processingStatus: string }>> {
    const row = await this.assets.commit(ctx, assetId);
    if (row.processingStatus === 'queued') {
      // Codex P2：queued 必须有消费者。M0=同进程异步摄入（失败留 queued，可重触发）；
      // M1 换 Temporal activity（含 Docling 长解析）。不 await——commit 响应保持秒回。
      void this.kb.processQueued(ctx, row.siteId).catch((err) => {
        this.log.warn(`async kb ingest failed for site ${row.siteId}: ${String(err)}`);
      });
    }
    return envelope({ assetId: row.id, processingStatus: row.processingStatus });
  }

  @Get('sites/:id/assets')
  @ApiOperation({ summary: '站点素材列表' })
  @ApiQuery({ name: 'kind', required: false })
  async list(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) siteId: string,
    @Query('kind') kind?: string,
  ): Promise<Enveloped<unknown[]>> {
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
        error: a.error,
        createdAt: a.createdAt,
      })),
    );
  }

  @Delete('assets/:id')
  @HttpCode(204)
  @ApiOperation({ summary: '删除素材（spec 引用检查随 M1 spec 物化补齐）' })
  async remove(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) assetId: string,
  ): Promise<void> {
    await this.assets.remove(ctx, assetId);
  }
}
