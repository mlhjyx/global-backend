import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../auth/auth.guard';
import { Ctx } from '../../auth/ctx.decorator';
import { RequireScopes } from '../../auth/require-scopes.decorator';
import type { RequestContext } from '../../auth/request-context';
import { ScopesGuard } from '../../auth/scopes.guard';
import { ApiEnvelope } from '../../common/api-envelope.decorator';
import { envelope, type Enveloped } from '../../common/envelope';
import { DiscoveryService } from '../discovery.service';
import {
  readStreamingRunProgress,
  type StreamingRunProgressSnapshot,
} from './streaming-progress';

const STAGE_STATUS_ENUM = ['pending', 'running', 'done', 'skipped', 'failed', 'cancelled'];

@ApiTags('Discovery')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:read')
export class StreamingProgressController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Get('discovery-runs/:runId/streaming-progress')
  @ApiOperation({
    summary: '方案 B 流式三段进度（L0 召回 / L1 单活动抽取+fit-v3 / L2 Top-K 富集）；兼容历史非流式 run',
    description:
      '只读投影一次发现任务的流式三段漏斗进度（L0 召回入池、L1 Raw HTTP 优先单活动抓取与 fit-v3 买家判定、L2 Top-K 联系人补全与监控注册）以及最新处理的候选企业卡片；对历史非流式 discoveryWorkflow 任务自动返回 pipelineMode=legacy，零预算消耗。',
  })
  @ApiEnvelope({
    type: 'object',
    required: ['runId', 'pipelineMode', 'runStatus', 'currentStage', 'updatedAt', 'stages', 'recentCandidates'],
    properties: {
      runId: { type: 'string', format: 'uuid' },
      pipelineMode: { type: 'string', enum: ['streaming', 'legacy'] },
      runStatus: { type: 'string' },
      currentStage: {
        type: 'string',
        enum: ['l0_recall', 'l1_extract_fit', 'l2_topk_enrich', 'finalizing', 'done', 'cancelled', 'failed'],
      },
      updatedAt: { type: 'string', format: 'date-time' },
      stages: {
        type: 'object',
        required: ['l0Recall', 'l1ExtractFit', 'l2TopKEnrich'],
        properties: {
          l0Recall: {
            type: 'object',
            required: ['status', 'queriesTotal', 'queriesCompleted', 'candidatesRecalled', 'canonicalUpserted', 'startedAt', 'completedAt'],
            properties: {
              status: { type: 'string', enum: STAGE_STATUS_ENUM },
              queriesTotal: { type: 'integer' },
              queriesCompleted: { type: 'integer' },
              candidatesRecalled: { type: 'integer' },
              canonicalUpserted: { type: 'integer' },
              startedAt: { type: 'string', format: 'date-time', nullable: true },
              completedAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
          l1ExtractFit: {
            type: 'object',
            required: [
              'status', 'total', 'processed', 'rawHttpHits', 'crawl4aiFallbacks',
              'pdfSkipped', 'wwwRetries', 'fitMatch', 'fitWeak', 'fitMismatch', 'failed',
              'startedAt', 'completedAt',
            ],
            properties: {
              status: { type: 'string', enum: STAGE_STATUS_ENUM },
              total: { type: 'integer' },
              processed: { type: 'integer' },
              rawHttpHits: { type: 'integer' },
              crawl4aiFallbacks: { type: 'integer' },
              pdfSkipped: { type: 'integer' },
              wwwRetries: { type: 'integer' },
              fitMatch: { type: 'integer' },
              fitWeak: { type: 'integer' },
              fitMismatch: { type: 'integer' },
              failed: { type: 'integer' },
              startedAt: { type: 'string', format: 'date-time', nullable: true },
              completedAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
          l2TopKEnrich: {
            type: 'object',
            required: [
              'status', 'topKCap', 'selected', 'enriched',
              'contactsFound', 'watchesRegistered', 'failed', 'startedAt', 'completedAt',
            ],
            properties: {
              status: { type: 'string', enum: STAGE_STATUS_ENUM },
              topKCap: { type: 'integer' },
              selected: { type: 'integer' },
              enriched: { type: 'integer' },
              contactsFound: { type: 'integer' },
              watchesRegistered: { type: 'integer' },
              failed: { type: 'integer' },
              startedAt: { type: 'string', format: 'date-time', nullable: true },
              completedAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
        },
      },
      recentCandidates: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'companyId', 'name', 'domain', 'country', 'stage',
            'fitVerdict', 'fitScore', 'fetchMethod', 'channelsFound', 'reasonSummary', 'updatedAt',
          ],
          properties: {
            companyId: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            domain: { type: 'string', nullable: true },
            country: { type: 'string', nullable: true },
            stage: {
              type: 'string',
              enum: ['l0_recalled', 'l1_extracting', 'l1_scored', 'l2_enriching', 'done', 'failed', 'skipped'],
            },
            fitVerdict: { type: 'string', enum: ['match', 'weak', 'mismatch'], nullable: true },
            fitScore: { type: 'number', nullable: true },
            fetchMethod: { type: 'string', enum: ['raw_http', 'crawl4ai', 'skipped'], nullable: true },
            channelsFound: {
              type: 'object',
              required: ['emails', 'phones', 'forms', 'socials'],
              properties: {
                emails: { type: 'integer' },
                phones: { type: 'integer' },
                forms: { type: 'integer' },
                socials: { type: 'integer' },
              },
            },
            reasonSummary: { type: 'string', nullable: true },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  })
  async getStreamingProgress(
    @Ctx() ctx: RequestContext,
    @Param('runId', ParseUUIDPipe) runId: string,
  ): Promise<Enveloped<StreamingRunProgressSnapshot>> {
    const run = await this.discovery.getRun(ctx, runId);
    return envelope(readStreamingRunProgress(run));
  }
}
