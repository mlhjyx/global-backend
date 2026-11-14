import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { envelope } from '../common/envelope';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { buildRunResultView } from './run-result-view';

/**
 * PR-06a：run 级结果视图（只读）。独立 controller 而不是塞进 DiscoveryController，
 * 避免继续膨胀既有文件（G9 文件预算），也让读模型边界清晰。
 */
@ApiTags('Discovery')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:read')
export class RunResultViewController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('discovery-runs/:runId/result-view')
  @ApiOperation({
    summary: 'run 级结果视图：本 run 候选、本轮评分留痕与最新评分分列（只读；最新分不一定是本 run）',
    description:
      '候选集来自本 run 物化的公司（discovery_company_job）；本轮评分来自 run_event 的 qualification_batch_scored 批次留痕（没有留痕时标 not_scored_in_run，绝不回填）；最新评分来自 lead 的 ICP 级投影，单独一列并标注不一定是本 run。两种评分口径不可互相替代。',
  })
  @ApiEnvelope({
    type: 'object',
    required: ['runId', 'icpId', 'status', 'candidates', 'scoring'],
    properties: {
      runId: { type: 'string', format: 'uuid' },
      icpId: { type: 'string', format: 'uuid' },
      status: { type: 'string' },
      completedAt: { type: 'string', format: 'date-time', nullable: true },
      candidates: {
        type: 'object',
        required: ['total', 'truncated', 'items'],
        properties: {
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
          items: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      scoring: {
        type: 'object',
        required: ['thisRun', 'latest'],
        properties: {
          thisRun: {
            type: 'object',
            required: ['available', 'label', 'batches', 'items'],
            properties: {
              available: { type: 'boolean' },
              label: { type: 'string', enum: ['this_run', 'not_scored_in_run'] },
              batches: { type: 'integer' },
              scoredCompanies: { type: 'integer' },
              truncated: { type: 'boolean' },
              scoredAt: { type: 'string', format: 'date-time', nullable: true },
              items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
          latest: {
            type: 'object',
            required: ['label', 'items'],
            properties: {
              label: { type: 'string', enum: ['latest_not_necessarily_this_run'] },
              items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
        },
      },
    },
  })
  async getRunResultView(
    @Ctx() ctx: RequestContext,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    const view = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      buildRunResultView(tx, { runId }),
    );
    if (!view) {
      throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'run not found' } });
    }
    return envelope(view);
  }
}
