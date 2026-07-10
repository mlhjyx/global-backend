import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { Enveloped, envelope, PageEnveloped, pageEnvelope } from '../common/envelope';
import { ApiEnvelope, ApiListEnvelope, ApiPageEnvelope } from '../common/api-envelope.decorator';
import { CompanyService } from './company.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { CompanyDto, OfferingDto } from './dto/company.dto';

@ApiTags('Companies')
@ApiBearerAuth()
@Controller('companies')
@UseGuards(AuthGuard)
export class CompanyController {
  constructor(private readonly companies: CompanyService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({
    summary: '提交官网，创建企业画像并触发理解（异步）',
    description: '支持 Idempotency-Key 头：同 key 重放返回首次结果，不重复创建（PRD 11.16）。',
  })
  // name 必须与 @Headers('idempotency-key') 推断名精确一致（含大小写）才会合并成单个 required:false 参数
  @ApiHeader({ name: 'idempotency-key', required: false, description: '幂等键（客户端生成，如 uuid）' })
  @ApiEnvelope(CompanyDto, { status: 202 })
  async create(
    @Ctx() ctx: RequestContext,
    @Body() dto: CreateCompanyDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Enveloped<CompanyDto>> {
    const { company } = await this.companies.create(ctx, dto, idempotencyKey?.trim() || undefined);
    return envelope(CompanyDto.from(company));
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
  @HttpCode(200)
  @ApiOperation({ summary: '人工确认企业可用（REVIEW → ACTIVE，显式 Gate 出口）' })
  @ApiEnvelope(CompanyDto)
  async confirm(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ): Promise<Enveloped<CompanyDto>> {
    return envelope(CompanyDto.from(await this.companies.confirm(ctx, companyId)));
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
