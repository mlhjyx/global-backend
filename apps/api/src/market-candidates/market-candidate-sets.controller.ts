import {
  Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe,
  Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import type { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { envelope } from '../common/envelope';
import {
  MarketCandidateFeedbackInputDto, MarketCandidateFeedbackResultDto,
  MarketCandidateLatestDto, MarketCandidateRevisionDto, MarketCandidateRevisionPageDto,
} from './dto/market-candidate-set.dto';
import { invalidCandidateInput, parseFeedback } from './market-candidate-set.document';
import { candidateHistoryPage, MarketCandidateSetsService } from './market-candidate-sets.service';

const errorSchema = { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code','message'],
  properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object', additionalProperties: true } } } } };
function revisionNumber(value: string): number {
  const revision = Number(value);
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(revision) || revision > 2_147_483_647) return invalidCandidateInput();
  return revision;
}
function pageQuery(value: unknown): { limit?: number; cursor?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidCandidateInput();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['limit','cursor'].includes(key))
    || (input.limit !== undefined && (typeof input.limit !== 'string' || !/^[1-9][0-9]*$/u.test(input.limit)))
    || (input.cursor !== undefined && typeof input.cursor !== 'string')) return invalidCandidateInput();
  const page = { ...(input.limit === undefined ? {} : { limit: Number(input.limit) }), ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }) };
  candidateHistoryPage(page);
  return page;
}

@ApiTags('Market Candidates')
@ApiBearerAuth()
@ApiResponse({ status: 400, description: 'VALIDATION_ERROR：参数或严格文档合同无效。', schema: errorSchema })
@ApiResponse({ status: 401, description: '需要有效的 SaaS 用户身份。', schema: errorSchema })
@ApiResponse({ status: 403, description: '缺少读取或人工反馈权限。', schema: errorSchema })
@ApiResponse({ status: 404, description: '公司、候选或文档不存在、已删除或不在当前租户。', schema: errorSchema })
@Controller()
@UseGuards(AuthGuard, ScopesGuard)
export class MarketCandidateSetsController {
  constructor(@Inject(MarketCandidateSetsService) private readonly sets: MarketCandidateSetsService) {}

  @Get('companies/:companyId/market-candidate-sets/latest')
  @RequireScopes('acquisition:read')
  @ApiOperation({ operationId: 'MarketCandidateSetsController_getLatest_v1', summary: '读取公司的最新市场候选文档',
    description: '仅从引擎持久层读取；NOT_ANALYZED 只表示本能力没有可读文档，不表示市场无机会、生成已完成或失败。不会自动创建候选或调用模型、搜索、执行。' })
  @ApiParam({ name: 'companyId', schema: { type: 'string', format: 'uuid' } })
  @ApiEnvelope(MarketCandidateLatestDto)
  async getLatest(@Ctx() ctx: RequestContext, @Param('companyId', ParseUUIDPipe) companyId: string) {
    return envelope(await this.sets.getLatest(ctx, companyId));
  }

  @Get('market-candidate-sets/:setId')
  @RequireScopes('acquisition:read')
  @ApiOperation({ operationId: 'MarketCandidateSetsController_getCurrent_v1', summary: '读取候选集合当前修订',
    description: '返回不可变文档、原依据版本/摘要及本次来源可用性。来源变化或删除不改写历史、不生成下载链接、不自动重评估。已被新集合取代的文档明确 historical。' })
  @ApiParam({ name: 'setId', schema: { type: 'string', format: 'uuid' } })
  @ApiEnvelope(MarketCandidateRevisionDto)
  async getCurrent(@Ctx() ctx: RequestContext, @Param('setId', ParseUUIDPipe) setId: string) {
    return envelope(await this.sets.getCurrent(ctx, setId));
  }

  @Get('market-candidate-sets/:setId/revisions')
  @RequireScopes('acquisition:read')
  @ApiOperation({ operationId: 'MarketCandidateSetsController_listRevisions_v1', summary: '分页读取候选修订历史摘要',
    description: '修订号降序，默认20、最大100；cursor 是上一页最后一个正整数修订号，读取严格小于该值的摘要。历史只读，不无界加载所有正文。' })
  @ApiParam({ name: 'setId', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string', pattern: '^[1-9][0-9]*$' } })
  @ApiEnvelope(MarketCandidateRevisionPageDto)
  async listRevisions(@Ctx() ctx: RequestContext, @Param('setId', ParseUUIDPipe) setId: string, @Query() query: unknown) {
    return envelope(await this.sets.listRevisions(ctx, setId, pageQuery(query)));
  }

  @Get('market-candidate-sets/:setId/revisions/:revision')
  @RequireScopes('acquisition:read')
  @ApiOperation({ operationId: 'MarketCandidateSetsController_getRevision_v1', summary: '读取指定不可变候选修订',
    description: '返回当时的 proposal、用户纠正、依据版本/hash、可信 actor/time，另计算当前来源可用性。旧来源失效时不回挂到现行正文，不修改旧修订。' })
  @ApiParam({ name: 'setId', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'revision', schema: { type: 'integer', minimum: 1, maximum: 2147483647 } })
  @ApiEnvelope(MarketCandidateRevisionDto)
  async getRevision(@Ctx() ctx: RequestContext, @Param('setId', ParseUUIDPipe) setId: string, @Param('revision') revision: string) {
    return envelope(await this.sets.getRevision(ctx, setId, revisionNumber(revision)));
  }

  @Post('market-candidate-sets/:setId/candidates/:candidateId/feedback')
  @HttpCode(200)
  @RequireScopes('acquisition:review')
  @ApiOperation({ operationId: 'MarketCandidateSetsController_recordFeedback_v1', summary: '追加市场候选人工反馈',
    description: 'CONFIRM/CORRECT/KEEP_PENDING/REJECT 仅记录用户意见，不提升事实核验等级、不改卖方 SoR、不授权找买家。CORRECT 必须提供有实质变更的白名单 correction，其它动作不得带 correction。先核权限及幂等重放，再校验集合级 expectedRevision；旧版本/旧集合返回 VERSION_CONFLICT，同 key 异意图返回 IDEMPOTENCY_CONFLICT。理由缺省/null/纯空白记为未提供，其余原文保留。响应丢失时沿用原 key 重试，返回原 recordedRevision；不启动模型、搜索、Grant、计划、run 或发送。' })
  @ApiParam({ name: 'setId', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'candidateId', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({ name: 'idempotency-key', required: true, schema: { type: 'string', format: 'uuid' }, description: '同一意图重试沿用原 UUID；不同意图使用新 key。' })
  @ApiBody({ type: MarketCandidateFeedbackInputDto })
  @ApiResponse({ status: 409, description: 'VERSION_CONFLICT 或 IDEMPOTENCY_CONFLICT；不写半条历史，不自动强制覆盖。', schema: errorSchema })
  @ApiEnvelope(MarketCandidateFeedbackResultDto)
  async recordFeedback(
    @Ctx() ctx: RequestContext, @Param('setId', ParseUUIDPipe) setId: string,
    @Param('candidateId', ParseUUIDPipe) candidateId: string,
    @Body() input: unknown, @Headers('idempotency-key') key: string | undefined,
  ) {
    if (typeof key !== 'string' || !isUUID(key)) return invalidCandidateInput();
    // An unknown body keeps the global whitelist from stripping fields before strict domain validation.
    return envelope(await this.sets.recordFeedback(ctx, setId, candidateId, parseFeedback(input), key));
  }
}
