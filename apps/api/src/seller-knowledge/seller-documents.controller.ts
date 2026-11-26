import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { ScopesGuard } from '../auth/scopes.guard';
import type { RequestContext } from '../auth/request-context';
import { ApiEnvelope, ApiPageEnvelope } from '../common/api-envelope.decorator';
import { envelope, pageEnvelope, type Enveloped, type PageEnveloped } from '../common/envelope';
import {
  CompleteSellerDocumentMultipartDto,
  InitSellerDocumentMultipartResponseDto,
  PresignSellerDocumentDto,
  PresignSellerDocumentResponseDto,
  SellerDocumentDto,
  UploadSellerDocumentPartResponseDto,
} from './dto/seller-document.dto';
import { formatContentDisposition, SellerDocumentsService } from './seller-documents.service';

@ApiTags('Seller Documents')
@ApiBearerAuth()
@Controller('companies/:companyId/seller-documents')
@UseGuards(AuthGuard, ScopesGuard)
export class SellerCompanyDocumentsController {
  constructor(private readonly documents: SellerDocumentsService) {}

  @Post('presign')
  @RequireScopes('acquisition:write')
  @HttpCode(201)
  @ApiOperation({ summary: '为卖家资料上传签发短时 presigned PUT（校验类型与配额）' })
  @ApiEnvelope(PresignSellerDocumentResponseDto, { status: 201 })
  async presign(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: PresignSellerDocumentDto,
  ): Promise<Enveloped<PresignSellerDocumentResponseDto>> {
    const result = await this.documents.presign(ctx, companyId, dto);
    return envelope(result);
  }

  @Post(':documentId/commit')
  @RequireScopes('acquisition:write')
  @HttpCode(202)
  @ApiOperation({ summary: '确认上传：HEAD/魔数/sha256 校验、转存 canonical 并入队解析' })
  @ApiEnvelope(SellerDocumentDto, { status: 202 })
  async commit(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<Enveloped<SellerDocumentDto>> {
    const row = await this.documents.commit(ctx, companyId, documentId);
    return envelope(SellerDocumentDto.from(row));
  }

  @Put(':documentId/content')
  @RequireScopes('acquisition:write')
  @HttpCode(200)
  @ApiOperation({
    summary: '浏览器直传：把文件字节经引擎写入暂存对象（presign 主机对浏览器不可达时的中转）',
    description:
      '仅 pending_upload 状态可用；Content-Type 必须与 presign 申报一致，字节数必须等于申报大小。写入后照常调用 commit 校验并入队。',
  })
  @ApiEnvelope(SellerDocumentDto)
  async uploadContent(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Req() req: { body?: unknown },
    @Headers('content-type') contentType?: string,
  ): Promise<Enveloped<SellerDocumentDto>> {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const row = await this.documents.uploadContent(ctx, companyId, documentId, body, (contentType ?? '').split(';', 1)[0]!.trim());
    return envelope(SellerDocumentDto.from(row));
  }

  @Post(':documentId/multipart/init')
  @RequireScopes('acquisition:write')
  @HttpCode(201)
  @ApiOperation({ summary: '初始化资料分片上传（S3 Multipart，推荐 >5 MiB 文件走分片断点续传）' })
  @ApiEnvelope(InitSellerDocumentMultipartResponseDto, { status: 201 })
  async initMultipart(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<Enveloped<InitSellerDocumentMultipartResponseDto>> {
    return envelope(await this.documents.initMultipartUpload(ctx, companyId, documentId));
  }

  @Put(':documentId/parts/:partNumber')
  @RequireScopes('acquisition:write')
  @HttpCode(200)
  @ApiOperation({
    summary: '上传资料单个分片（单片上限 6 MiB，失败仅重传该分片）',
    description: '需在查询参数传入 multipart/init 返回的 uploadId；返回 partNumber 与 etag 供后续合并。',
  })
  @ApiQuery({ name: 'uploadId', required: true, schema: { type: 'string', minLength: 1, maxLength: 512 } })
  @ApiEnvelope(UploadSellerDocumentPartResponseDto)
  async uploadPart(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Param('partNumber') rawPartNumber: string,
    @Query('uploadId') uploadId: string,
    @Req() req: { body?: unknown },
  ): Promise<Enveloped<UploadSellerDocumentPartResponseDto>> {
    const partNumber = /^\d{1,3}$/u.test(rawPartNumber) ? Number(rawPartNumber) : Number.NaN;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    return envelope(
      await this.documents.uploadMultipartPart(ctx, companyId, documentId, uploadId ?? '', partNumber, body),
    );
  }

  @Post(':documentId/multipart/complete')
  @RequireScopes('acquisition:write')
  @HttpCode(200)
  @ApiOperation({ summary: '合并资料全部分片至暂存对象（随后调用 commit 完成校验与入队解析）' })
  @ApiEnvelope(SellerDocumentDto)
  async completeMultipart(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: CompleteSellerDocumentMultipartDto,
  ): Promise<Enveloped<SellerDocumentDto>> {
    const row = await this.documents.completeMultipartUpload(ctx, companyId, documentId, dto);
    return envelope(SellerDocumentDto.from(row));
  }

  @Get('search')
  @RequireScopes('acquisition:read')
  @ApiOperation({ summary: '资料库混合检索（向量 + 全文），限定公司与可检索状态' })
  @ApiQuery({ name: 'q', required: true, schema: { type: 'string', minLength: 2, maxLength: 500 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', default: 10, maximum: 50 } })
  @ApiEnvelope({
    type: 'array',
    items: {
      type: 'object',
      required: ['documentId', 'filename', 'seq', 'text', 'score'],
      properties: {
        documentId: { type: 'string', format: 'uuid' },
        filename: { type: 'string' },
        seq: { type: 'integer' },
        text: { type: 'string' },
        score: { type: 'number' },
      },
    },
  })
  async search(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Query('q') q: string,
    @Query('limit') limit?: string,
  ): Promise<Enveloped<Array<Record<string, unknown>>>> {
    const n = Math.min(Math.max(Number(limit) || 10, 1), 50);
    return envelope(await this.documents.search(ctx, companyId, q ?? '', n));
  }

  @Get()
  @RequireScopes('acquisition:read')
  @ApiOperation({ summary: '列出公司资料库（游标分页，软删不可见）' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', default: 20, maximum: 100 } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiPageEnvelope(SellerDocumentDto)
  async list(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<PageEnveloped<SellerDocumentDto>> {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const result = await this.documents.list(ctx, companyId, n, cursor);
    return pageEnvelope(result.data.map(SellerDocumentDto.from), result);
  }
}

@ApiTags('Seller Documents')
@ApiBearerAuth()
@Controller('seller-documents')
@UseGuards(AuthGuard, ScopesGuard)
export class SellerDocumentsController {
  constructor(private readonly documents: SellerDocumentsService) {}

  @Get(':documentId')
  @RequireScopes('acquisition:read')
  @ApiOperation({ summary: '资料详情（跨租户 404）' })
  @ApiEnvelope(SellerDocumentDto)
  async get(
    @Ctx() ctx: RequestContext,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<Enveloped<SellerDocumentDto>> {
    return envelope(SellerDocumentDto.from(await this.documents.get(ctx, documentId)));
  }

  @Get(':documentId/download-url')
  @RequireScopes('acquisition:read')
  @ApiOperation({ summary: '短时 presigned GET 下载地址' })
  @ApiEnvelope(
    {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string', format: 'uri' }, expiresInSeconds: { type: 'integer' } },
    },
  )
  async downloadUrl(
    @Ctx() ctx: RequestContext,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<Enveloped<{ url: string; expiresInSeconds: number }>> {
    return envelope({ url: await this.documents.downloadUrl(ctx, documentId), expiresInSeconds: 600 });
  }

  @Get(':documentId/content')
  @RequireScopes('acquisition:read')
  @ApiOperation({ summary: '流式下载资料原文件（经服务端鉴权代理，不暴露内网对象存储签名）' })
  @ApiProduces('application/octet-stream')
  @ApiResponse({
    status: 200,
    description: '资料原文件二进制字节流',
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    headers: {
      'Content-Type': { description: '文件 MIME 类型', schema: { type: 'string' } },
      'Content-Disposition': { description: '安全转义的附件文件名', schema: { type: 'string' } },
      'Content-Length': { description: '文件字节数', schema: { type: 'integer', minimum: 0 } },
    },
  })
  @ApiResponse({ status: 404, description: '资料不存在、已软删、属其他 workspace 或对象缺失' })
  @ApiResponse({ status: 409, description: '资料尚未上传完成或已被拒绝（SELLER_DOCUMENT_NOT_READY）' })
  @ApiResponse({ status: 503, description: '对象存储暂时不可用（SELLER_DOCUMENTS_STORAGE_UNAVAILABLE）' })
  async downloadContent(
    @Ctx() ctx: RequestContext,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const content = await this.documents.openContentStream(ctx, documentId);
    response.setHeader('Content-Type', content.mime);
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

  @Post(':documentId/retry')
  @RequireScopes('acquisition:write')
  @HttpCode(202)
  @ApiOperation({ summary: '重试失败或排队中的资料解析' })
  @ApiEnvelope(SellerDocumentDto, { status: 202 })
  async retry(
    @Ctx() ctx: RequestContext,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<Enveloped<SellerDocumentDto>> {
    return envelope(SellerDocumentDto.from(await this.documents.retry(ctx, documentId)));
  }

  @Delete(':documentId')
  @RequireScopes('acquisition:review')
  @ApiOperation({ summary: '软删资料（恢复窗口内可由运营恢复；物理清理见 DSR/清理管线）' })
  @ApiEnvelope(SellerDocumentDto)
  async remove(
    @Ctx() ctx: RequestContext,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<Enveloped<SellerDocumentDto>> {
    return envelope(SellerDocumentDto.from(await this.documents.softDelete(ctx, documentId)));
  }
}
