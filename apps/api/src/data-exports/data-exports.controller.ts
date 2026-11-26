import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import type { RequestContext } from '../auth/request-context';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { ScopesGuard } from '../auth/scopes.guard';
import { ApiEnvelope, ApiPageEnvelope } from '../common/api-envelope.decorator';
import {
  envelope,
  pageEnvelope,
  type Enveloped,
  type PageEnveloped,
} from '../common/envelope';
import { formatContentDisposition } from '../seller-knowledge/seller-documents.service';
import { DataExportsService } from './data-exports.service';
import { DATA_EXPORT_STATUSES } from './data-exports.types';
import { CreateDataExportDto, DataExportJobDto } from './dto/data-exports.dto';

@ApiTags('DataExports')
@ApiBearerAuth()
@Controller('data-exports')
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:read', 'acquisition:export')
export class DataExportsController {
  constructor(private readonly exportsService: DataExportsService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: '提交异步租户数据导出任务（返回 202 + 任务 ID）' })
  @ApiEnvelope(DataExportJobDto, { status: 202 })
  @ApiResponse({ status: 409, description: '并发导出任务数达到上限（DATA_EXPORT_IN_PROGRESS）' })
  @ApiResponse({ status: 429, description: '24 小时导出配额超限（DATA_EXPORT_RATE_LIMITED）' })
  async create(
    @Ctx() ctx: RequestContext,
    @Body() dto: CreateDataExportDto,
  ): Promise<Enveloped<DataExportJobDto>> {
    const job = await this.exportsService.createExport(ctx, dto);
    return envelope(DataExportJobDto.from(job));
  }

  @Get()
  @ApiOperation({ summary: '游标分页列出当前工作空间的异步数据导出任务' })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [...DATA_EXPORT_STATUSES],
  })
  @ApiPageEnvelope(DataExportJobDto)
  async list(
    @Ctx() ctx: RequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ): Promise<PageEnveloped<DataExportJobDto>> {
    const parsedLimit = Math.min(Math.max(Math.floor(Number(limit) || 20), 1), 100);
    const result = await this.exportsService.listExports(ctx, {
      limit: parsedLimit,
      cursor: cursor || undefined,
      status: status || undefined,
    });
    return pageEnvelope(result.data.map(DataExportJobDto.from), result);
  }

  @Get(':exportId')
  @ApiOperation({ summary: '查询单个异步数据导出任务状态与元数据' })
  @ApiEnvelope(DataExportJobDto)
  @ApiResponse({ status: 404, description: '导出任务不存在或属其他 workspace' })
  async get(
    @Ctx() ctx: RequestContext,
    @Param('exportId', ParseUUIDPipe) exportId: string,
  ): Promise<Enveloped<DataExportJobDto>> {
    const job = await this.exportsService.getExport(ctx, exportId);
    return envelope(DataExportJobDto.from(job));
  }

  @Get(':exportId/download')
  @ApiOperation({ summary: '流式下载已就绪的数据导出文件（不暴露内网对象存储签名）' })
  @ApiProduces('application/octet-stream')
  @ApiResponse({
    status: 200,
    description: '导出文件字节流',
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    headers: {
      'Content-Type': { description: '导出文件 MIME 类型', schema: { type: 'string' } },
      'Content-Disposition': { description: '安全转义的附件文件名', schema: { type: 'string' } },
      'Content-Length': { description: '文件字节数', schema: { type: 'integer', minimum: 0 } },
    },
  })
  @ApiResponse({ status: 404, description: '导出任务不存在或对象缺失' })
  @ApiResponse({ status: 409, description: '导出任务尚未就绪（DATA_EXPORT_NOT_READY）' })
  @ApiResponse({ status: 410, description: '导出文件已过期（DATA_EXPORT_EXPIRED）' })
  @ApiResponse({ status: 503, description: '导出存储暂时不可用（DATA_EXPORT_STORAGE_UNAVAILABLE）' })
  async download(
    @Ctx() ctx: RequestContext,
    @Param('exportId', ParseUUIDPipe) exportId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const content = await this.exportsService.openDownloadStream(ctx, exportId);
    response.setHeader('Content-Type', content.contentType);
    response.setHeader('Content-Disposition', formatContentDisposition(content.filename));
    if (
      content.contentLength !== undefined &&
      Number.isSafeInteger(content.contentLength) &&
      content.contentLength >= 0
    ) {
      response.setHeader('Content-Length', String(content.contentLength));
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.on('close', () => {
      if (!response.writableEnded && !content.stream.destroyed) {
        content.stream.destroy();
      }
    });
    return new StreamableFile(content.stream)
      .setErrorHandler((err, res) => {
        if (!content.stream.destroyed) {
          content.stream.destroy();
        }
        const writable = res as unknown as {
          destroyed?: boolean;
          headersSent?: boolean;
          destroy?: (error?: Error) => void;
          end?: () => void;
        };
        if (!writable.destroyed) {
          if (writable.headersSent && typeof writable.destroy === 'function') {
            writable.destroy(err);
          } else {
            writable.end?.();
          }
        }
      })
      .setErrorLogger(() => undefined);
  }
}
