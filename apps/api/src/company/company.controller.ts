import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { Enveloped, envelope, PageEnveloped, pageEnvelope } from '../common/envelope';
import { ApiEnvelope, ApiListEnvelope, ApiPageEnvelope } from '../common/api-envelope.decorator';
import { CompanyService } from './company.service';
import { WebsiteCandidatesService } from './website-candidates';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyDto } from './dto/update-company.dto';
import { RetryUnderstandingDto } from './dto/retry-understanding.dto';
import { CompanyDto, OfferingDto } from './dto/company.dto';
import {
  ApiExecutionBudgetGrant,
  asExecutionBudgetHttpBoundary,
  ExecutionBudgetGrant,
} from '../execution-budget/execution-budget-grant.decorator';

@ApiTags('Companies')
@ApiBearerAuth()
@Controller('companies')
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:read')
export class CompanyController {
  constructor(
    private readonly companies: CompanyService,
    private readonly websiteCandidates: WebsiteCandidatesService,
  ) {}

  @Post()
  @RequireScopes('acquisition:write')
  @HttpCode(202)
  @ApiOperation({
    summary: '提交官网，创建企业画像并触发理解（异步）',
    description: '支持 Idempotency-Key 头：同 key 重放返回首次结果，不重复创建（PRD 11.16）。',
  })
  // name 必须与 @Headers('idempotency-key') 推断名精确一致（含大小写）才会合并成单个 required:false 参数
  @ApiHeader({ name: 'idempotency-key', required: false, description: '幂等键（客户端生成，如 uuid）' })
  @ApiExecutionBudgetGrant()
  @ApiEnvelope(CompanyDto, { status: 202 })
  async create(
    @Ctx() ctx: RequestContext,
    @Body() dto: CreateCompanyDto,
    @Headers('idempotency-key') idempotencyKey?: string,
    @ExecutionBudgetGrant() compactJws?: string,
  ): Promise<Enveloped<CompanyDto>> {
    const { company, understanding } = await asExecutionBudgetHttpBoundary(() =>
      this.companies.create(
        ctx,
        dto,
        idempotencyKey?.trim() || undefined,
        compactJws,
      ),
    );
    return envelope(CompanyDto.from({ ...company, understanding }));
  }

  @Get()
  @ApiOperation({ summary: '列出当前 workspace 的企业画像（游标分页）' })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', default: 20, maximum: 100 } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiPageEnvelope(CompanyDto)
  async list(
    @Ctx() ctx: RequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<PageEnveloped<CompanyDto>> {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const r = await this.companies.list(ctx, n, cursor);
    return pageEnvelope(r.data.map(CompanyDto.from), r);
  }

  @Post(':companyId/understanding/retry')
  @RequireScopes('acquisition:write')
  @HttpCode(202)
  @ApiOperation({
    summary: '重试最近一次失败的企业官网理解（需要新的 Execution Budget Grant）',
    description:
      '只允许对最近一次理解失败、仍为 DRAFT 的档案重试；成功时重新入队理解工作流。' +
      '原创建请求的 Grant 已消费，调用方必须先为 `POST /companies/:companyId/understanding/retry` 取新 quote 并签发 Grant。',
  })
  @ApiExecutionBudgetGrant()
  @ApiEnvelope(CompanyDto, { status: 202 })
  async retryUnderstanding(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: RetryUnderstandingDto,
    @ExecutionBudgetGrant() compactJws?: string,
  ): Promise<Enveloped<CompanyDto>> {
    const { company } = await asExecutionBudgetHttpBoundary(() =>
      this.companies.retryUnderstanding(ctx, companyId, dto.attemptId, compactJws),
    );
    return envelope(CompanyDto.from(company));
  }

  @Get(':companyId')
  @ApiOperation({ summary: '按 id 获取企业画像（跨租户返回 404）' })
  @ApiEnvelope(CompanyDto)
  async get(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ): Promise<Enveloped<CompanyDto>> {
    return envelope(CompanyDto.from(await this.companies.get(ctx, companyId)));
  }

  @Get(':companyId/completeness')
  @ApiOperation({ summary: '企业完整度（5.2.7）：审批数/待审数/产品数/未决冲突 + 当前状态' })
  @ApiEnvelope({
    type: 'object',
    required: ['status', 'approvedClaims', 'pendingClaims', 'offerings', 'conflictsOpen'],
    properties: {
      status: { type: 'string' },
      approvedClaims: { type: 'integer' },
      pendingClaims: { type: 'integer' },
      offerings: { type: 'integer' },
      conflictsOpen: { type: 'integer' },
    },
  })
  async completeness(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ) {
    return envelope(await this.companies.completeness(ctx, companyId));
  }

  @Post(':companyId/confirm')
  @RequireScopes('acquisition:review')
  @HttpCode(200)
  @ApiOperation({ summary: '人工确认企业可用（REVIEW → ACTIVE，显式 Gate 出口）' })
  @ApiEnvelope(CompanyDto)
  async confirm(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ): Promise<Enveloped<CompanyDto>> {
    return envelope(CompanyDto.from(await this.companies.confirm(ctx, companyId)));
  }

  @Patch(':companyId')
  @RequireScopes('acquisition:write')
  @ApiOperation({
    summary: '编辑公司档案（DRAFT 内可改：名称/官网/行业/目标市场/业务邮箱）',
    description:
      '补填官网后，调用方需为 `POST /companies/:companyId/understanding/retry` 另取 quote 与 Grant 来启动理解；本接口不消费 Grant。',
  })
  @ApiEnvelope(CompanyDto)
  async update(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: UpdateCompanyDto,
  ): Promise<Enveloped<CompanyDto>> {
    return envelope(CompanyDto.from(await this.companies.update(ctx, companyId, dto)));
  }

  @Delete(':companyId')
  @RequireScopes('acquisition:write')
  @HttpCode(200)
  @ApiOperation({
    summary: '软删除 DRAFT 档案（行保留、列表与详情不再可见；物理删除归 owner/DSR）',
  })
  @ApiEnvelope({
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  })
  async remove(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ): Promise<Enveloped<{ id: string }>> {
    return envelope(await this.companies.remove(ctx, companyId));
  }

  @Post(':companyId/website-candidates')
  @RequireScopes('acquisition:write')
  @HttpCode(200)
  @ApiOperation({
    summary: '按公司名搜索官网候选（SearXNG，人工确认后自行采用；不抓页面）',
  })
  @ApiListEnvelope({
    type: 'object',
    required: ['url', 'title', 'score'],
    properties: {
      url: { type: 'string' },
      title: { type: 'string' },
      score: { type: 'number' },
    },
  })
  async listWebsiteCandidates(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ): Promise<Enveloped<Array<{ url: string; title: string; score: number }>>> {
    return envelope(await this.websiteCandidates.find(ctx, companyId));
  }

  @Get(':companyId/offerings')
  @ApiOperation({ summary: '企业的结构化产品/服务（理解工作流抽取，逐条带来源页与原文片段）' })
  @ApiListEnvelope(OfferingDto)
  async listOfferings(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ): Promise<Enveloped<OfferingDto[]>> {
    const rows = await this.companies.listOfferings(ctx, companyId);
    return envelope(rows.map(OfferingDto.from));
  }
}
