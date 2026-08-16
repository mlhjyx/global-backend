import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import type { RequestContext } from '../auth/request-context';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { ScopesGuard } from '../auth/scopes.guard';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { envelope } from '../common/envelope';
import {
  PROVIDER_QUALITY_METRICS,
  ProviderQualityMetric,
  ProviderQualityService,
} from './provider-quality.service';
import { ProviderQualityRankingDto } from './provider-quality.dto';

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
};

function integerQuery(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new BadRequestException(`${name} must be an integer between ${min} and ${max}`);
  const parsed = Number(value);
  if (parsed < min || parsed > max) throw new BadRequestException(`${name} must be between ${min} and ${max}`);
  return parsed;
}

@ApiTags('Discovery')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:read')
export class ProviderQualityController {
  constructor(private readonly quality: ProviderQualityService) {}

  @Get('provider-quality-rankings')
  @ApiOperation({ summary: '渠道质量事实排名（只读；小样本与未知字段不授予名次）' })
  @ApiQuery({ name: 'windowDays', required: false, schema: { type: 'integer', default: 30, minimum: 1, maximum: 365 } })
  @ApiQuery({ name: 'minRuns', required: false, schema: { type: 'integer', default: 3, minimum: 1, maximum: 100 } })
  @ApiQuery({ name: 'metric', required: false, enum: PROVIDER_QUALITY_METRICS })
  @ApiEnvelope(ProviderQualityRankingDto)
  @ApiResponse({ status: 400, description: '时间窗、最小样本或排名指标无效', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 401, description: 'Bearer token 缺失或无效', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: '缺少 acquisition:read 权限', schema: ERROR_SCHEMA })
  async rank(
    @Ctx() ctx: RequestContext,
    @Query('windowDays') windowDays?: string,
    @Query('minRuns') minRuns?: string,
    @Query('metric') metric?: string,
  ) {
    const selectedMetric = metric ?? 'bound_rate';
    if (!PROVIDER_QUALITY_METRICS.includes(selectedMetric as ProviderQualityMetric)) {
      throw new BadRequestException(`metric must be one of ${PROVIDER_QUALITY_METRICS.join(', ')}`);
    }
    return envelope(await this.quality.rank(ctx, {
      windowDays: integerQuery(windowDays, 30, 1, 365, 'windowDays'),
      minRuns: integerQuery(minRuns, 3, 1, 100, 'minRuns'),
      metric: selectedMetric as ProviderQualityMetric,
    }));
  }
}
