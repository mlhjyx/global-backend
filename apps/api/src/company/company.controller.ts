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
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { CompanyService } from './company.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { CompanyDto, CompanyListDto, OfferingDto } from './dto/company.dto';

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
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: '幂等键（客户端生成，如 uuid）' })
  @ApiCreatedResponse({ type: CompanyDto })
  async create(
    @Ctx() ctx: RequestContext,
    @Body() dto: CreateCompanyDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CompanyDto> {
    const { company } = await this.companies.create(ctx, dto, idempotencyKey?.trim() || undefined);
    return CompanyDto.from(company);
  }

  @Get()
  @ApiOperation({ summary: '列出当前 workspace 的企业画像（游标分页）' })
  @ApiOkResponse({ type: CompanyListDto })
  async list(
    @Ctx() ctx: RequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<CompanyListDto> {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const r = await this.companies.list(ctx, n, cursor);
    return {
      data: r.data.map(CompanyDto.from),
      page: { nextCursor: r.nextCursor, hasMore: r.hasMore },
    };
  }

  @Get(':companyId')
  @ApiOperation({ summary: '按 id 获取企业画像（跨租户返回 404）' })
  @ApiOkResponse({ type: CompanyDto })
  async get(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ): Promise<CompanyDto> {
    return CompanyDto.from(await this.companies.get(ctx, companyId));
  }

  @Get(':companyId/completeness')
  @ApiOperation({ summary: '企业完整度（5.2.7）：审批数/待审数/产品数/未决冲突 + 当前状态' })
  async completeness(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ) {
    return this.companies.completeness(ctx, companyId);
  }

  @Post(':companyId/confirm')
  @HttpCode(200)
  @ApiOperation({ summary: '人工确认企业可用（REVIEW → ACTIVE，显式 Gate 出口）' })
  @ApiOkResponse({ type: CompanyDto })
  async confirm(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ): Promise<CompanyDto> {
    return CompanyDto.from(await this.companies.confirm(ctx, companyId));
  }

  @Get(':companyId/offerings')
  @ApiOperation({ summary: '企业的结构化产品/服务（理解工作流抽取，逐条带来源页与原文片段）' })
  @ApiOkResponse({ type: [OfferingDto] })
  async listOfferings(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ): Promise<OfferingDto[]> {
    const rows = await this.companies.listOfferings(ctx, companyId);
    return rows.map(OfferingDto.from);
  }
}
