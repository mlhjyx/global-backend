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
import { ApiBearerAuth, ApiBody, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { DiscoveryService } from './discovery.service';
import { LAWFUL_BASIS_KINDS } from './compliance/email-verification-gate';
import { LawfulBasisKind } from './provider-contract';

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

/**
 * 邮箱验证的合规上下文（可选）。职能邮箱可空；探测**人名邮箱**需给合法性基础或显式开关，
 * 否则合规门返回 status=BLOCKED（不做任何 SMTP 探测）。
 */
class VerifyContactPointDto {
  @ApiPropertyOptional({ enum: LAWFUL_BASIS_KINDS, description: '探测人名邮箱的合法性基础（GDPR Art.6）；职能邮箱可省略' })
  @IsOptional()
  @IsIn(LAWFUL_BASIS_KINDS as unknown as string[])
  lawfulBasis?: LawfulBasisKind;

  @ApiPropertyOptional({ description: 'LIA / 工单 / 合同 / 同意记录的引用（可审计）' })
  @IsOptional()
  @IsString()
  lawfulBasisRef?: string;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  lawfulBasisNote?: string;

  @ApiPropertyOptional({ description: '显式开关：无 lawfulBasis 也允许探测人名邮箱（默认 false，仍留痕）' })
  @IsOptional()
  @IsBoolean()
  allowPersonalWithoutBasis?: boolean;
}

/**
 * 决策人邮箱猜测的合规上下文（可选）。猜出的候选**都是人名邮箱**（个人数据），缺 lawfulBasis
 * 且未开 allowPersonalWithoutBasis → 合规门 blocked（零探测）。maxContacts/maxProbe 为有界护栏。
 */
class GuessEmailsDto {
  @ApiPropertyOptional({ enum: LAWFUL_BASIS_KINDS, description: '探测人名邮箱的合法性基础（GDPR Art.6）；猜出的都是人名邮箱' })
  @IsOptional()
  @IsIn(LAWFUL_BASIS_KINDS as unknown as string[])
  lawfulBasis?: LawfulBasisKind;

  @ApiPropertyOptional({ description: 'LIA / 工单 / 合同 / 同意记录的引用（可审计）' })
  @IsOptional()
  @IsString()
  lawfulBasisRef?: string;

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  lawfulBasisNote?: string;

  @ApiPropertyOptional({ description: '显式开关：无 lawfulBasis 也允许探测人名邮箱（默认 false，仍留痕）' })
  @IsOptional()
  @IsBoolean()
  allowPersonalWithoutBasis?: boolean;

  @ApiPropertyOptional({ description: '最多补全几个缺邮箱决策人（有界护栏，默认 25）' })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxContacts?: number;

  @ApiPropertyOptional({ description: '每人最多探测几个候选（有界护栏，默认 8）' })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxProbe?: number;
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
  @ApiOperation({
    summary: '邮箱验证（Waterfall 第7步）：状态回写 UNVERIFIED→VALID|RISKY|INVALID|BLOCKED',
    description:
      '合规门：职能邮箱默认自动验证；人名邮箱（个人数据）需 lawfulBasis 或 allowPersonalWithoutBasis，否则 BLOCKED（不探测）。',
  })
  // body 可选：职能邮箱无需合规上下文即可 body-less 调用；仅人名邮箱要 lawfulBasis。
  @ApiBody({ type: VerifyContactPointDto, required: false })
  async verify(
    @Ctx() ctx: RequestContext,
    @Param('pointId', ParseUUIDPipe) pointId: string,
    @Body() dto?: VerifyContactPointDto,
  ) {
    return this.discovery.verifyContactPoint(ctx, pointId, {
      lawfulBasis: dto?.lawfulBasis
        ? { basis: dto.lawfulBasis, ref: dto.lawfulBasisRef, note: dto.lawfulBasisNote }
        : undefined,
      allowPersonalWithoutBasis: dto?.allowPersonalWithoutBasis,
    });
  }

  @Post('canonical-companies/:id/guess-emails')
  @HttpCode(200)
  @ApiOperation({
    summary: '猜测缺邮箱决策人的邮箱（排列/格式学习 + SMTP RCPT 验证 → 落库）',
    description:
      '合规门：猜出的都是人名邮箱（个人数据），需 lawfulBasis 或 allowPersonalWithoutBasis，否则一律 blocked（零探测）。' +
      'RISKY 未证实猜测落库但 allowedActions 不含 outreach（不可群发）；suppression 命中不落。',
  })
  // body 可选：无 body 则全 blocked（无 lawfulBasis），诚实不探。
  @ApiBody({ type: GuessEmailsDto, required: false })
  async guessEmails(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto?: GuessEmailsDto) {
    return this.discovery.guessEmailsForCompany(ctx, id, {
      lawfulBasis: dto?.lawfulBasis
        ? { basis: dto.lawfulBasis, ref: dto.lawfulBasisRef, note: dto.lawfulBasisNote }
        : undefined,
      allowPersonalWithoutBasis: dto?.allowPersonalWithoutBasis,
      maxContacts: dto?.maxContacts,
      maxProbe: dto?.maxProbe,
    });
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
