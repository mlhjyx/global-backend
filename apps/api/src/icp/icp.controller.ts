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
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
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

@ApiTags('ICP')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class IcpController {
  constructor(private readonly icps: IcpService) {}

  @Post('companies/:companyId/icps')
  @HttpCode(201)
  @ApiOperation({ summary: '基于企业已确认事实，AI 生成理想客户画像(ICP) + 买家委员会（状态 HYPOTHESIS）' })
  @ApiOkResponse({ type: IcpDto })
  async generate(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ): Promise<IcpDto> {
    return IcpDto.from(await this.icps.generateFromCompany(ctx, companyId));
  }

  @Get('icps')
  @ApiOperation({ summary: '列出 ICP（可用 ?companyId= 过滤）' })
  @ApiOkResponse({ type: [IcpDto] })
  async list(
    @Ctx() ctx: RequestContext,
    @Query('companyId') companyId?: string,
  ): Promise<{ data: IcpDto[] }> {
    const rows = await this.icps.list(ctx, companyId);
    return { data: rows.map(IcpDto.from) };
  }

  @Get('icps/:icpId')
  @ApiOperation({ summary: '获取 ICP 详情（含 Persona + 买家委员会）' })
  @ApiOkResponse({ type: IcpDto })
  async get(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
  ): Promise<IcpDto> {
    return IcpDto.from(await this.icps.get(ctx, icpId));
  }

  @Post('icps/:icpId/activate')
  @HttpCode(200)
  @ApiOperation({ summary: '激活 ICP（→ ACTIVE，同企业旧 ACTIVE → SUPERSEDED），发 ICPActivated 事件' })
  @ApiOkResponse({ type: IcpDto })
  async activate(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
  ): Promise<IcpDto> {
    return IcpDto.from(await this.icps.activate(ctx, icpId));
  }

  @Patch('icps/:icpId')
  @ApiOperation({ summary: '人工修订 ICP（AI 产出是假设，可编辑；乐观锁）' })
  @ApiOkResponse({ type: IcpDto })
  async update(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
    @Body() dto: UpdateIcpDto,
  ): Promise<IcpDto> {
    const { expectedVersion, ...patch } = dto;
    return IcpDto.from(await this.icps.update(ctx, icpId, patch, expectedVersion));
  }

  // ── 验证规则（LED-003）──────────────────────────────────────────────────

  @Post('icps/:icpId/rules')
  @HttpCode(201)
  @ApiOperation({ summary: '新增验证规则（must_have / nice_to_have / exclusion，机器可评估）' })
  @ApiOkResponse({ type: RuleDto })
  async addRule(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
    @Body() dto: CreateRuleDto,
  ): Promise<RuleDto> {
    return RuleDto.from(await this.icps.addRule(ctx, icpId, dto));
  }

  @Patch('icp-rules/:ruleId')
  @ApiOperation({ summary: '修改验证规则' })
  @ApiOkResponse({ type: RuleDto })
  async updateRule(
    @Ctx() ctx: RequestContext,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() dto: UpdateRuleDto,
  ): Promise<RuleDto> {
    return RuleDto.from(await this.icps.updateRule(ctx, ruleId, dto));
  }

  @Delete('icp-rules/:ruleId')
  @ApiOperation({ summary: '删除验证规则' })
  async deleteRule(
    @Ctx() ctx: RequestContext,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
  ): Promise<{ deleted: boolean }> {
    return this.icps.deleteRule(ctx, ruleId);
  }

  // ── 样例回测（LED-004）──────────────────────────────────────────────────

  @Post('icps/:icpId/backtests')
  @HttpCode(201)
  @ApiOperation({
    summary: '用已知客户/非客户样例回测 ICP 规则（确定性评估）；HYPOTHESIS → VALIDATING',
  })
  @ApiOkResponse({ type: BacktestDto })
  async runBacktest(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
    @Body() dto: RunBacktestDto,
  ): Promise<BacktestDto> {
    return BacktestDto.from(await this.icps.runBacktest(ctx, icpId, dto.samples));
  }

  @Get('icps/:icpId/backtests')
  @ApiOperation({ summary: '回测历史' })
  @ApiOkResponse({ type: [BacktestDto] })
  async listBacktests(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
  ): Promise<BacktestDto[]> {
    return (await this.icps.listBacktests(ctx, icpId)).map(BacktestDto.from);
  }

  // ── 查询计划（LED-005）──────────────────────────────────────────────────

  @Post('icps/:icpId/query-plans')
  @HttpCode(201)
  @ApiOperation({ summary: '从 ACTIVE ICP 生成多源查询计划（AI，DRAFT 状态，需人工确认）' })
  @ApiOkResponse({ type: QueryPlanDto })
  async generateQueryPlan(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
  ): Promise<QueryPlanDto> {
    return QueryPlanDto.from(await this.icps.generateQueryPlan(ctx, icpId));
  }

  @Get('icps/:icpId/query-plans')
  @ApiOperation({ summary: '查询计划列表' })
  @ApiOkResponse({ type: [QueryPlanDto] })
  async listQueryPlans(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
  ): Promise<QueryPlanDto[]> {
    return (await this.icps.listQueryPlans(ctx, icpId)).map(QueryPlanDto.from);
  }

  @Post('query-plans/:planId/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: '人工确认查询计划（DRAFT → READY，Discover 可执行）' })
  @ApiOkResponse({ type: QueryPlanDto })
  async confirmQueryPlan(
    @Ctx() ctx: RequestContext,
    @Param('planId', ParseUUIDPipe) planId: string,
  ): Promise<QueryPlanDto> {
    return QueryPlanDto.from(await this.icps.confirmQueryPlan(ctx, planId));
  }
}
