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
import { ApiBearerAuth, ApiBody, ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { envelope, pageEnvelope } from '../common/envelope';
import { ApiEnvelope, ApiListEnvelope, ApiPageEnvelope } from '../common/api-envelope.decorator';
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

/** 归一后公司行；字段级结构化 DTO 待实体解析最小版（ADR-007）定型。 */
const CANONICAL_COMPANY_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: 'CanonicalCompany（归一视图 + 联系人 + 字段级 Evidence）',
};

@ApiTags('Discovery')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Post('query-plans/:planId/execute')
  @HttpCode(202)
  @ApiOperation({ summary: '执行 READY 查询计划：多源发现 → Raw → Canonical（异步，Temporal 编排）' })
  @ApiEnvelope(
    {
      type: 'object',
      required: ['runId', 'status'],
      properties: {
        runId: { type: 'string', format: 'uuid' },
        status: { type: 'string' },
      },
    },
    { status: 202 },
  )
  async execute(@Ctx() ctx: RequestContext, @Param('planId', ParseUUIDPipe) planId: string) {
    const run = await this.discovery.executePlan(ctx, planId);
    return envelope({ runId: run.id, status: run.status });
  }

  @Get('discovery-runs/:runId')
  @ApiOperation({ summary: '发现执行状态与统计（每源计数/归一/Suppression）' })
  @ApiEnvelope({
    type: 'object',
    required: ['id', 'planId', 'icpId', 'status', 'stats', 'createdAt', 'completedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      planId: { type: 'string', format: 'uuid' },
      icpId: { type: 'string', format: 'uuid' },
      status: { type: 'string' },
      stats: { type: 'object', additionalProperties: true },
      createdAt: { type: 'string', format: 'date-time' },
      completedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  })
  async getRun(@Ctx() ctx: RequestContext, @Param('runId', ParseUUIDPipe) runId: string) {
    const run = await this.discovery.getRun(ctx, runId);
    return envelope({
      id: run.id,
      planId: run.planId,
      icpId: run.icpId,
      status: run.status,
      stats: run.stats,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
    });
  }

  @Get('canonical-companies')
  @ApiOperation({ summary: '发现的目标客户公司（归一后，游标分页；?status=NEW|ENRICHED|SUPPRESSED）' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', default: 20, maximum: 100 } })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiPageEnvelope(CANONICAL_COMPANY_SCHEMA)
  async listCompanies(
    @Ctx() ctx: RequestContext,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const r = await this.discovery.listCanonicalCompanies(ctx, { status, limit: n, cursor });
    return pageEnvelope(r.data, r);
  }

  @Get('canonical-companies/:id')
  @ApiOperation({ summary: '公司详情：canonical 视图 + 联系人 + 字段级 Evidence（每个字段值的来源）' })
  @ApiEnvelope(CANONICAL_COMPANY_SCHEMA)
  async getCompany(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return envelope(await this.discovery.getCanonicalCompany(ctx, id));
  }

  @Post('canonical-companies/:id/discover-contacts')
  @HttpCode(201)
  @ApiOperation({ summary: '按需发现联系人（Waterfall 第5步：仅高价值企业；Suppression 先行过滤）' })
  @ApiEnvelope(
    { type: 'object', additionalProperties: true, description: '联系人发现结果（新建联系人/联系点计数）' },
    { status: 201 },
  )
  async discoverContacts(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return envelope(await this.discovery.discoverContacts(ctx, id));
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
  @ApiEnvelope({ type: 'object', additionalProperties: true, description: '验证结果（status + 探测细节留痕）' })
  async verify(
    @Ctx() ctx: RequestContext,
    @Param('pointId', ParseUUIDPipe) pointId: string,
    @Body() dto?: VerifyContactPointDto,
  ) {
    return envelope(
      await this.discovery.verifyContactPoint(ctx, pointId, {
        lawfulBasis: dto?.lawfulBasis
          ? { basis: dto.lawfulBasis, ref: dto.lawfulBasisRef, note: dto.lawfulBasisNote }
          : undefined,
        allowPersonalWithoutBasis: dto?.allowPersonalWithoutBasis,
      }),
    );
  }

  // ── Suppression ───────────────────────────────────────────────────────────

  @Post('suppressions')
  @HttpCode(201)
  @ApiOperation({ summary: '加入禁联名单（email/domain/company_name）；命中的公司立即 SUPPRESSED' })
  @ApiEnvelope({ type: 'object', additionalProperties: true, description: 'Suppression 记录' }, { status: 201 })
  async addSuppression(@Ctx() ctx: RequestContext, @Body() dto: CreateSuppressionDto) {
    return envelope(await this.discovery.addSuppression(ctx, dto));
  }

  @Get('suppressions')
  @ApiOperation({ summary: '禁联名单' })
  @ApiListEnvelope({ type: 'object', additionalProperties: true, description: 'Suppression 记录' })
  async listSuppressions(@Ctx() ctx: RequestContext) {
    return envelope(await this.discovery.listSuppressions(ctx));
  }

  @Delete('suppressions/:id')
  @ApiOperation({ summary: '移除禁联记录' })
  @ApiEnvelope({ type: 'object', required: ['deleted'], properties: { deleted: { type: 'boolean' } } })
  async removeSuppression(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return envelope(await this.discovery.removeSuppression(ctx, id));
  }

  @Get('data-providers')
  @ApiOperation({ summary: 'Provider 注册表（平台级：状态/成本；DISABLED = Kill Switch）' })
  @ApiListEnvelope({ type: 'object', additionalProperties: true, description: 'DataProvider（源/状态/成本）' })
  async listProviders(@Ctx() ctx: RequestContext) {
    return envelope(await this.discovery.listProviders(ctx));
  }
}
