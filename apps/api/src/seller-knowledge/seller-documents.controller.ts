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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { ScopesGuard } from '../auth/scopes.guard';
import type { RequestContext } from '../auth/request-context';
import { ApiEnvelope, ApiPageEnvelope } from '../common/api-envelope.decorator';
import { envelope, pageEnvelope, type Enveloped, type PageEnveloped } from '../common/envelope';
import {
  PresignSellerDocumentDto,
  PresignSellerDocumentResponseDto,
  SellerDocumentDto,
} from './dto/seller-document.dto';
import { SellerDocumentsService } from './seller-documents.service';

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
