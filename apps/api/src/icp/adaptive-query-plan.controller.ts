import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import type { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { envelope, type Enveloped } from '../common/envelope';
import { ApiAdaptiveQueryPlanErrors } from './adaptive-query-plan.openapi';
import { AdaptiveQueryPlanService } from './adaptive-query-plan.service';
import {
  AdaptiveQueryPlanSuggestionDto,
  CreateAdaptiveQueryPlanSuggestionDto,
} from './dto/adaptive-query-plan.dto';

@ApiTags('ICP')
@ApiBearerAuth()
@Controller('discovery-runs')
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:write')
export class AdaptiveQueryPlanController {
  constructor(private readonly adaptivePlans: AdaptiveQueryPlanService) {}

  @Post(':runId/adaptive-query-plan-suggestions')
  @HttpCode(200)
  @ApiOperation({
    summary: '根据已完成采集轮次生成下一轮 DRAFT 查询建议（不会自动确认或执行）',
  })
  @ApiEnvelope(AdaptiveQueryPlanSuggestionDto)
  @ApiAdaptiveQueryPlanErrors()
  async suggest(
    @Ctx() ctx: RequestContext,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() dto: CreateAdaptiveQueryPlanSuggestionDto,
  ): Promise<Enveloped<AdaptiveQueryPlanSuggestionDto>> {
    const result = await this.adaptivePlans.suggestForCompletedRun(ctx, runId, {
      currentRound: dto.currentRound,
      maxRounds: dto.maxRounds,
    });
    return envelope(AdaptiveQueryPlanSuggestionDto.from(result));
  }
}
