import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { ScopesGuard } from '../auth/scopes.guard';
import type { RequestContext } from '../auth/request-context';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { envelope, type Enveloped } from '../common/envelope';
import {
  CreateDocumentClaimDraftDto,
  DocumentChunkViewDto,
  DocumentClaimDraftDto,
  DocumentClaimPreviewDto,
  PreviewDocumentClaimDto,
} from './dto/seller-document-claim.dto';
import { SellerDocumentClaimsService } from './seller-document-claims.service';

/** S1a typed 原句接缝：读取端口只读；preview 纯检查；draft 首次必为 NEEDS_REVIEW。 */
@ApiTags('Seller Documents')
@ApiBearerAuth()
@Controller('companies/:companyId/seller-documents/:documentId')
@UseGuards(AuthGuard, ScopesGuard)
export class SellerDocumentClaimsController {
  constructor(private readonly claims: SellerDocumentClaimsService) {}

  @Get('chunks/:seq')
  @RequireScopes('acquisition:read')
  @ApiOperation({
    summary: '读取当前发布版本的单个分块（有界本地 DB，不调用 search/embedding）',
  })
  @ApiParam({ name: 'companyId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'documentId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'seq', schema: { type: 'integer', minimum: 0 } })
  @ApiEnvelope(DocumentChunkViewDto)
  async readChunk(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Param('seq', ParseIntPipe) seq: number,
  ): Promise<Enveloped<DocumentChunkViewDto>> {
    return envelope(await this.claims.readChunk(ctx, companyId, documentId, seq));
  }

  @Post('claim-previews')
  @RequireScopes('acquisition:write')
  @HttpCode(200)
  @ApiOperation({
    summary: '校验 typed 引用并返回服务端重建的原句、bindingHash 与 requestDigest（纯检查，不写 Claim）',
  })
  @ApiParam({ name: 'companyId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'documentId', type: 'string', format: 'uuid' })
  @ApiEnvelope(DocumentClaimPreviewDto)
  async preview(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: PreviewDocumentClaimDto,
  ): Promise<Enveloped<DocumentClaimPreviewDto>> {
    return envelope(await this.claims.preview(ctx, companyId, documentId, dto));
  }

  @Post('claim-drafts')
  @RequireScopes('acquisition:write')
  @HttpCode(201)
  @ApiOperation({
    summary: '事务重读引用并写入 NEEDS_REVIEW 草稿；同 key 同体返原件，异体 409',
  })
  @ApiParam({ name: 'companyId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'documentId', type: 'string', format: 'uuid' })
  @ApiEnvelope(DocumentClaimDraftDto, { status: 201 })
  async createDraft(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: CreateDocumentClaimDraftDto,
  ): Promise<Enveloped<DocumentClaimDraftDto>> {
    return envelope(await this.claims.createDraft(ctx, companyId, documentId, dto));
  }
}
