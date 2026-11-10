import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../auth/auth.guard';
import { Ctx } from '../../auth/ctx.decorator';
import { RequireScopes } from '../../auth/require-scopes.decorator';
import { RequestContext } from '../../auth/request-context';
import { ScopesGuard } from '../../auth/scopes.guard';
import { LEGAL_ENTITY_SCHEMES, LEGAL_ENTITY_STATUSES } from './entity-keys';
import { LegalLinksService } from './legal-links.service';

const legalEntitySchema = {
  type: 'object',
  required: ['id', 'scheme', 'value', 'country', 'name', 'address', 'status', 'sourceProvider'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    scheme: { type: 'string', enum: [...LEGAL_ENTITY_SCHEMES] },
    value: { type: 'string' },
    country: { type: 'string', minLength: 2, maxLength: 2 },
    name: { type: 'string' },
    address: { type: 'string', nullable: true },
    status: { type: 'string', enum: [...LEGAL_ENTITY_STATUSES] },
    sourceProvider: { type: 'string' },
  },
};

const linkSchema = {
  type: 'object',
  required: [
    'id',
    'companyId',
    'legalEntityId',
    'confidence',
    'matchMethod',
    'matchRule',
    'status',
    'evidence',
    'createdAt',
    'updatedAt',
    'legalEntity',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    companyId: { type: 'string', format: 'uuid' },
    legalEntityId: { type: 'string', format: 'uuid' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    matchMethod: { type: 'string', enum: ['deterministic', 'probabilistic'] },
    matchRule: { type: 'string' },
    status: { type: 'string', enum: ['auto', 'review', 'rejected'] },
    evidence: { type: 'object', nullable: true, additionalProperties: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    legalEntity: legalEntitySchema,
  },
};

const listSchema = {
  type: 'object',
  required: ['data'],
  properties: { data: { type: 'array', items: linkSchema } },
};

const validationErrorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: true,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', enum: ['VALIDATION_ERROR'] },
        message: { type: 'string' },
      },
    },
  },
};

const resolveBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    candidates: {
      type: 'array',
      maxItems: 20,
      description: '可选：先登记进本 workspace 的 legal_entity 再参与消歧的候选法人实体（≤20 条）',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scheme', 'value', 'country', 'name'],
        properties: {
          scheme: { type: 'string', enum: [...LEGAL_ENTITY_SCHEMES] },
          value: { type: 'string', description: '规范式由服务端归一（大写、去空格/分隔符）' },
          country: { type: 'string', minLength: 2, maxLength: 2 },
          name: { type: 'string' },
          address: { type: 'string', nullable: true },
          status: { type: 'string', enum: [...LEGAL_ENTITY_STATUSES] },
          sourceProvider: { type: 'string' },
          evidenceUrl: { type: 'string', nullable: true },
          evidenceHash: { type: 'string', nullable: true },
          evidenceJson: { type: 'object', nullable: true, additionalProperties: true },
        },
      },
    },
  },
};

/**
 * 获客挖掘 vNext W2（2026-11-10）：实体级消歧与公司图谱。
 *
 * - `POST /companies/{companyId}/legal-links/resolve`：触发一次消歧——把公司自带标识
 *   （GLEIF LEI / 官网 VAT）与可选 candidates 登记进 legal_entity，按确定性键优先 +
 *   Fellegi–Sunter 概率匹配（双阈值 auto/review）产出链接候选并落库；返回公司当前全部链接。
 *   绝不自动合并两个已存在的 canonical 公司（合并只进人工复核）。
 * - `GET /companies/{companyId}/legal-links`：只读列出公司 ↔ 法人实体链接与实体摘要。
 *
 * 租户隔离：全部走 withWorkspace（RLS）；跨 workspace 的公司一律 404（不泄露存在性）。
 */
@ApiTags('Companies')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard, ScopesGuard)
export class CompanyLegalLinksController {
  constructor(private readonly legalLinks: LegalLinksService) {}

  @Post('companies/:companyId/legal-links/resolve')
  @RequireScopes('acquisition:write')
  @ApiOperation({
    summary: '触发一次法人实体消歧（确定性键优先 + 概率匹配双阈值），返回公司当前全部链接候选',
  })
  @ApiParam({ name: 'companyId', format: 'uuid' })
  @ApiBody({ required: false, schema: resolveBodySchema })
  @ApiResponse({ status: 200, description: '公司当前全部链接（含本次新增），按置信度倒序', schema: listSchema })
  @ApiResponse({ status: 400, description: 'VALIDATION_ERROR — 请求体或候选实体形态非法', schema: validationErrorSchema })
  @ApiResponse({ status: 404, description: '公司不存在或属于其他 workspace' })
  async resolve(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() body: unknown,
  ) {
    const result = await this.legalLinks.resolve(ctx, companyId, body);
    if (result === 'invalid') {
      throw new BadRequestException('resolve body or candidate legal entities are not valid');
    }
    if (result === 'not_found') {
      throw new NotFoundException('company not found');
    }
    return { data: result.items };
  }

  @Get('companies/:companyId/legal-links')
  @RequireScopes('acquisition:read')
  @ApiOperation({ summary: '公司 ↔ 法人实体链接列表（含实体摘要，按置信度倒序）' })
  @ApiParam({ name: 'companyId', format: 'uuid' })
  @ApiResponse({ status: 200, description: '公司当前全部链接；无链接返回空数组', schema: listSchema })
  @ApiResponse({ status: 404, description: '公司不存在或属于其他 workspace' })
  async list(@Ctx() ctx: RequestContext, @Param('companyId', ParseUUIDPipe) companyId: string) {
    const result = await this.legalLinks.list(ctx, companyId);
    if (result === 'not_found') {
      throw new NotFoundException('company not found');
    }
    return { data: result.items };
  }
}
