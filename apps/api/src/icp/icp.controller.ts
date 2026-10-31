import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { Enveloped, envelope } from '../common/envelope';
import { ApiEnvelope, ApiListEnvelope } from '../common/api-envelope.decorator';
import { IcpService } from './icp.service';
import { IcpDto } from './dto/icp.dto';
import {
  BacktestDto,
  CreateRuleDto,
  QueryPlanDto,
  RuleDto,
  RunBacktestDto,
  UpdateIcpDto,
  UpdateRuleDto,
} from './dto/qualification.dto';
import {
  ApiExecutionBudgetGrant,
  asExecutionBudgetHttpBoundary,
  ExecutionBudgetGrant,
} from '../execution-budget/execution-budget-grant.decorator';
import {
  ApiModelUpstreamUnusable,
  asModelUpstreamHttpBoundary,
} from '../model-gateway/model-upstream-http-boundary';

@ApiTags('ICP')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:read')
export class IcpController {
  constructor(private readonly icps: IcpService) {}

  @Post('companies/:companyId/icps')
  @RequireScopes('acquisition:write')
  @HttpCode(201)
  @ApiOperation({
    summary: '基于企业已确认事实，AI 生成理想客户画像(ICP) + 买家委员会（状态 HYPOTHESIS）',
    description:
      '模型网关结算了调用却没有可用答案（内容被过滤、输出截断、非 JSON、流被截断等）时返回 502 MODEL_UPSTREAM_UNUSABLE，details.reasonCode 为网关原因码；此时预算授权已消耗，重试需要新的授权。',
  })
  @ApiExecutionBudgetGrant()
  @ApiModelUpstreamUnusable()
  @ApiEnvelope(IcpDto, { status: 201 })
  async generate(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @ExecutionBudgetGrant() compactJws?: string,
  ): Promise<Enveloped<IcpDto>> {
    return envelope(
      IcpDto.from(
        await asExecutionBudgetHttpBoundary(() =>
          asModelUpstreamHttpBoundary(() =>
            this.icps.generateFromCompany(ctx, companyId, compactJws),
          ),
        ),
      ),
    );
  }

  @Get('icps')
  @ApiOperation({ summary: '列出 ICP（可用 ?companyId= 过滤）' })
  @ApiQuery({ name: 'companyId', required: false })
  @ApiListEnvelope(IcpDto)
  async list(
    @Ctx() ctx: RequestContext,
    @Query('companyId') companyId?: string,
  ): Promise<Enveloped<IcpDto[]>> {
    const rows = await this.icps.list(ctx, companyId);
    return envelope(rows.map(IcpDto.from));
  }

  @Get('icps/:icpId')
  @ApiOperation({ summary: '获取 ICP 详情（含 Persona + 买家委员会）' })
  @ApiEnvelope(IcpDto)
  async get(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
  ): Promise<Enveloped<IcpDto>> {
    return envelope(IcpDto.from(await this.icps.get(ctx, icpId)));
  }

  @Post('icps/:icpId/activate')
  @RequireScopes('acquisition:review')
  @HttpCode(200)
  @ApiOperation({ summary: '激活 ICP（→ ACTIVE，同企业旧 ACTIVE → SUPERSEDED），发 ICPActivated 事件' })
  @ApiEnvelope(IcpDto)
  async activate(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
  ): Promise<Enveloped<IcpDto>> {
    return envelope(IcpDto.from(await this.icps.activate(ctx, icpId)));
  }

  @Patch('icps/:icpId')
  @RequireScopes('acquisition:write')
  @ApiOperation({ summary: '人工修订 ICP（AI 产出是假设，可编辑；乐观锁）' })
  @ApiEnvelope(IcpDto)
  async update(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
    @Body() dto: UpdateIcpDto,
  ): Promise<Enveloped<IcpDto>> {
    const { expectedVersion, ...patch } = dto;
    return envelope(IcpDto.from(await this.icps.update(ctx, icpId, patch, expectedVersion)));
  }

  // ── 验证规则（LED-003）──────────────────────────────────────────────────

  @Post('icps/:icpId/rules')
  @RequireScopes('acquisition:write')
  @HttpCode(201)
  @ApiOperation({ summary: '新增验证规则（must_have / nice_to_have / exclusion，机器可评估）' })
  @ApiEnvelope(RuleDto, { status: 201 })
  async addRule(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
    @Body() dto: CreateRuleDto,
  ): Promise<Enveloped<RuleDto>> {
    return envelope(RuleDto.from(await this.icps.addRule(ctx, icpId, dto)));
  }

  @Patch('icp-rules/:ruleId')
  @RequireScopes('acquisition:write')
  @ApiOperation({ summary: '修改验证规则' })
  @ApiEnvelope(RuleDto)
  async updateRule(
    @Ctx() ctx: RequestContext,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() dto: UpdateRuleDto,
  ): Promise<Enveloped<RuleDto>> {
    return envelope(RuleDto.from(await this.icps.updateRule(ctx, ruleId, dto)));
  }

  @Delete('icp-rules/:ruleId')
  @RequireScopes('acquisition:write')
  @ApiOperation({ summary: '删除验证规则' })
  @ApiEnvelope({ type: 'object', required: ['deleted'], properties: { deleted: { type: 'boolean' } } })
  async deleteRule(
    @Ctx() ctx: RequestContext,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
  ): Promise<Enveloped<{ deleted: boolean }>> {
    return envelope(await this.icps.deleteRule(ctx, ruleId));
  }

  // ── 样例回测（LED-004）──────────────────────────────────────────────────

  @Post('icps/:icpId/backtests')
  @RequireScopes('acquisition:write')
  @HttpCode(201)
  @ApiOperation({
    summary: '用已知客户/非客户样例回测 ICP 规则（确定性评估）；HYPOTHESIS → VALIDATING',
  })
  @ApiEnvelope(BacktestDto, { status: 201 })
  async runBacktest(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
    @Body() dto: RunBacktestDto,
  ): Promise<Enveloped<BacktestDto>> {
    return envelope(BacktestDto.from(await this.icps.runBacktest(ctx, icpId, dto.samples)));
  }

  @Get('icps/:icpId/backtests')
  @ApiOperation({ summary: '回测历史' })
  @ApiListEnvelope(BacktestDto)
  async listBacktests(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
  ): Promise<Enveloped<BacktestDto[]>> {
    return envelope((await this.icps.listBacktests(ctx, icpId)).map(BacktestDto.from));
  }

  // ── 查询计划（LED-005）──────────────────────────────────────────────────

  @Post('icps/:icpId/query-plans')
  @RequireScopes('acquisition:write')
  @HttpCode(201)
  @ApiOperation({
    summary: '从 ACTIVE ICP 生成多源查询计划（AI，DRAFT 状态，需人工确认）',
    description:
      '只为当前已启用的数据源出查询，每条查询的 filters.source_hint 写明它执行的源；estimatedVolume 只计会执行的查询。没有可用的已启用数据源时返回 409 NO_ENABLED_DISCOVERY_SOURCE（不调用模型）；模型给出的查询全落在不可用的数据源上时返回 409 NO_RUNNABLE_QUERIES，不保存计划。模型网关结算了调用却没有可用答案（内容被过滤、输出截断、非 JSON、流被截断等）时返回 502 MODEL_UPSTREAM_UNUSABLE，details.reasonCode 为网关原因码，不保存计划；此时预算授权已消耗，重试需要新的授权。',
  })
  @ApiExecutionBudgetGrant({
    // BI-30: the planner only plans for ENABLED discovery sources.
    additionalConflictCodes: ['INVALID_STATE', 'NO_ENABLED_DISCOVERY_SOURCE', 'NO_RUNNABLE_QUERIES'],
  })
  @ApiModelUpstreamUnusable()
  @ApiEnvelope(QueryPlanDto, { status: 201 })
  async generateQueryPlan(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
    @ExecutionBudgetGrant() compactJws?: string,
  ): Promise<Enveloped<QueryPlanDto>> {
    return envelope(
      QueryPlanDto.from(
        await asExecutionBudgetHttpBoundary(() =>
          asModelUpstreamHttpBoundary(() =>
            this.icps.generateQueryPlan(ctx, icpId, compactJws),
          ),
        ),
      ),
    );
  }

  @Get('icps/:icpId/query-plans')
  @ApiOperation({ summary: '查询计划列表' })
  @ApiListEnvelope(QueryPlanDto)
  async listQueryPlans(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
  ): Promise<Enveloped<QueryPlanDto[]>> {
    return envelope((await this.icps.listQueryPlans(ctx, icpId)).map(QueryPlanDto.from));
  }

  @Post('query-plans/:planId/confirm')
  @RequireScopes('acquisition:review')
  @HttpCode(200)
  @ApiOperation({ summary: '人工确认查询计划（DRAFT → READY，Discover 可执行）' })
  @ApiEnvelope(QueryPlanDto)
  async confirmQueryPlan(
    @Ctx() ctx: RequestContext,
    @Param('planId', ParseUUIDPipe) planId: string,
  ): Promise<Enveloped<QueryPlanDto>> {
    return envelope(QueryPlanDto.from(await this.icps.confirmQueryPlan(ctx, planId)));
  }
}
