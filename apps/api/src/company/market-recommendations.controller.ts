import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import type { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { envelope, type Enveloped } from '../common/envelope';
import {
  ComtradeMarketRecommendationService,
  type MarketRecommendationsResponse,
} from './comtrade-market-recommendation.service';

@ApiTags('Company')
@ApiBearerAuth()
@Controller('companies')
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:read')
export class MarketRecommendationsController {
  constructor(private readonly recommendations: ComtradeMarketRecommendationService) {}

  @Get(':companyId/market-recommendations')
  @ApiOperation({
    summary: 'UN Comtrade / HS 贸易流目标国推荐（只读，不消费 Grant，不自动写入确认市场）',
    description:
      '根据显式传入的 4-6 位 HS 码，或按卖家已勾选产品与行业确定性反推的 HS 码，返回基于 UN Comtrade 贸易流基线的目标出口国排序建议（进口规模、同比增速、全球份额与业务理由）。本接口纯只读、零预算消耗，固定返回 isRecommendationOnly=true，绝不自动写入公司确认目标市场。',
  })
  @ApiQuery({
    name: 'hsCodes',
    required: false,
    description: '逗号分隔的 4-6 位 HS 码（如 854143,850440）；缺省时按公司产品与行业确定性反推',
    schema: { type: 'string' },
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: '返回推荐国家上限（1..20，默认 8）',
    schema: { type: 'integer', default: 8, minimum: 1, maximum: 20 },
  })
  @ApiEnvelope({
    type: 'object',
    required: ['companyId', 'isRecommendationOnly', 'basis', 'recommendations', 'generatedAt'],
    properties: {
      companyId: { type: 'string', format: 'uuid' },
      isRecommendationOnly: { type: 'boolean' },
      basis: {
        type: 'object',
        required: ['hsCodes', 'inferredFrom', 'dataSource', 'referenceYear'],
        properties: {
          hsCodes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['code', 'label', 'labelZh', 'matchedFrom'],
              properties: {
                code: { type: 'string' },
                label: { type: 'string' },
                labelZh: { type: 'string' },
                matchedFrom: { type: 'string' },
              },
            },
          },
          inferredFrom: { type: 'string', enum: ['query_hs', 'offerings_and_industry', 'fallback_general'] },
          dataSource: { type: 'string', enum: ['un_comtrade_baseline_v1', 'un_comtrade_live'] },
          referenceYear: { type: 'integer' },
        },
      },
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'code', 'name', 'labelEn', 'rank', 'hsCodes',
            'importVolumeUsd', 'yoyGrowthPct', 'globalImportSharePct',
            'rationale', 'confidence', 'alreadySelected',
          ],
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            labelEn: { type: 'string' },
            rank: { type: 'integer' },
            hsCodes: { type: 'array', items: { type: 'string' } },
            importVolumeUsd: { type: 'number' },
            yoyGrowthPct: { type: 'number' },
            globalImportSharePct: { type: 'number' },
            rationale: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            alreadySelected: { type: 'boolean' },
          },
        },
      },
      generatedAt: { type: 'string', format: 'date-time' },
    },
  })
  async recommend(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Query('hsCodes') hsCodes?: string,
    @Query('limit') limit?: string,
  ): Promise<Enveloped<MarketRecommendationsResponse>> {
    const parsedLimit = limit ? Number(limit) : undefined;
    return envelope(
      await this.recommendations.recommendForCompany(ctx, companyId, {
        hsCodes,
        limit: parsedLimit,
      }),
    );
  }
}
