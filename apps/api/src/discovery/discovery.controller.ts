import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { DiscoveryService } from './discovery.service';

class CreateSuppressionDto {
  @ApiProperty({ enum: ['email', 'domain', 'company_name'] })
  @IsIn(['email', 'domain', 'company_name'])
  type!: string;

  @ApiProperty({ example: 'noreply@example.com' })
  @IsString()
  value!: string;

  @ApiPropertyOptional({ enum: ['unsubscribe', 'bounce', 'complaint', 'manual', 'legal'] })
  @IsOptional()
  @IsString()
  reason?: string;
}

@ApiTags('Discovery')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Post('query-plans/:planId/execute')
  @HttpCode(202)
  @ApiOperation({ summary: '执行 READY 查询计划：多源发现 → Raw → Canonical（异步，Temporal 编排）' })
  async execute(@Ctx() ctx: RequestContext, @Param('planId', ParseUUIDPipe) planId: string) {
    const run = await this.discovery.executePlan(ctx, planId);
    return { runId: run.id, status: run.status };
  }

  @Get('discovery-runs/:runId')
  @ApiOperation({ summary: '发现执行状态与统计（每源计数/归一/Suppression）' })
  async getRun(@Ctx() ctx: RequestContext, @Param('runId', ParseUUIDPipe) runId: string) {
    const run = await this.discovery.getRun(ctx, runId);
    return {
      id: run.id,
      planId: run.planId,
      icpId: run.icpId,
      status: run.status,
      stats: run.stats,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    };
  }

  @Get('canonical-companies')
  @ApiOperation({ summary: '发现的目标客户公司（归一后，游标分页；?status=NEW|ENRICHED|SUPPRESSED）' })
  async listCompanies(
    @Ctx() ctx: RequestContext,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const r = await this.discovery.listCanonicalCompanies(ctx, { status, limit: n, cursor });
    return { data: r.data, page: { nextCursor: r.nextCursor, hasMore: r.hasMore } };
  }

  @Get('canonical-companies/:id')
  @ApiOperation({ summary: '公司详情：canonical 视图 + 联系人 + 字段级 Evidence（每个字段值的来源）' })
  async getCompany(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.discovery.getCanonicalCompany(ctx, id);
  }

  @Post('canonical-companies/:id/discover-contacts')
  @HttpCode(201)
  @ApiOperation({ summary: '按需发现联系人（Waterfall 第5步：仅高价值企业；Suppression 先行过滤）' })
  async discoverContacts(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.discovery.discoverContacts(ctx, id);
  }

  @Post('contact-points/:pointId/verify')
  @HttpCode(200)
  @ApiOperation({ summary: '邮箱验证（Waterfall 第7步）：状态回写 UNVERIFIED→VALID|RISKY|INVALID' })
  async verify(@Ctx() ctx: RequestContext, @Param('pointId', ParseUUIDPipe) pointId: string) {
    return this.discovery.verifyContactPoint(ctx, pointId);
  }

  // ── Suppression ───────────────────────────────────────────────────────────

  @Post('suppressions')
  @HttpCode(201)
  @ApiOperation({ summary: '加入禁联名单（email/domain/company_name）；命中的公司立即 SUPPRESSED' })
  async addSuppression(@Ctx() ctx: RequestContext, @Body() dto: CreateSuppressionDto) {
    return this.discovery.addSuppression(ctx, dto);
  }

  @Get('suppressions')
  @ApiOperation({ summary: '禁联名单' })
  async listSuppressions(@Ctx() ctx: RequestContext) {
    return { data: await this.discovery.listSuppressions(ctx) };
  }

  @Delete('suppressions/:id')
  @ApiOperation({ summary: '移除禁联记录' })
  async removeSuppression(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.discovery.removeSuppression(ctx, id);
  }

  @Get('data-providers')
  @ApiOperation({ summary: 'Provider 注册表（平台级：状态/成本；DISABLED = Kill Switch）' })
  async listProviders(@Ctx() ctx: RequestContext) {
    return { data: await this.discovery.listProviders(ctx) };
  }
}
