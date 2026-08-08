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
import { ApiHideProperty } from '@nestjs/swagger';
import {
  IsEmpty,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { ACQUISITION_CONTROLLER_SCOPE_INVENTORY } from '../auth/acquisition-scope-inventory';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { RequestContext } from '../auth/request-context';
import { envelope, pageEnvelope } from '../common/envelope';
import { ApiEnvelope, ApiListEnvelope, ApiPageEnvelope } from '../common/api-envelope.decorator';
import { DiscoveryService } from './discovery.service';
import { LAWFUL_BASIS_KINDS } from './compliance/email-verification-gate';
import { LawfulBasisKind } from './provider-contract';

const DISCOVERY_SCOPES = ACQUISITION_CONTROLLER_SCOPE_INVENTORY.DiscoveryController.operations;

class CreateSuppressionDto {
  @ApiProperty({ enum: ['email', 'domain', 'company_name'] })
  @IsIn(['email', 'domain', 'company_name'])
  type!: string;

  @ApiProperty({ example: 'noreply@example.com' })
  @IsString()
  @MaxLength(500)
  @Matches(/^\P{Cc}+$/u)
  value!: string;

  @ApiPropertyOptional({
    enum: [
      "unsubscribe",
      "bounce",
      "complaint",
      "manual",
      "preference",
      "user_preference",
      "art17",
      "art21",
      "legal",
    ],
  })
  @IsOptional()
  @IsIn([
    "unsubscribe",
    "bounce",
    "complaint",
    "manual",
    "preference",
    "user_preference",
    "art17",
    "art21",
    "legal",
  ])
  reason?: string;
}

class RequestSuppressionReleaseDto {
  @ApiProperty({ enum: ["USER_PREFERENCE", "IDENTITY_CORRECTION"] })
  @IsIn(["USER_PREFERENCE", "IDENTITY_CORRECTION"])
  requestKind!: "USER_PREFERENCE" | "IDENTITY_CORRECTION";

  @ApiProperty({
    maxLength: 500,
    description: "审核理由；不得包含联系人值或其他个人数据",
  })
  @IsString()
  @MaxLength(500)
  @Matches(/^\P{Cc}+$/u)
  justification!: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: "非 PII 的 case/evidence 引用；身份纠错时必填",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/)
  evidenceRef?: string;

  @ApiHideProperty()
  @IsEmpty()
  workspaceId?: never;

  @ApiHideProperty()
  @IsEmpty()
  actorId?: never;
}

/**
 * 邮箱验证的合规上下文（可选）。职能邮箱可空；探测**人名邮箱**必须给合法性基础，
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

}

/**
 * 决策人邮箱猜测的合规上下文（可选）。猜出的候选**都是人名邮箱**（个人数据），缺 lawfulBasis
 * → 合规门 blocked（零探测）。maxContacts/maxProbe 为有界护栏。
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

/** 归一后公司行；字段级结构化 DTO 待实体解析最小版（ADR-007）定型。 */
const CANONICAL_COMPANY_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: 'CanonicalCompany（归一视图 + 联系人 + 字段级 Evidence）',
};

const SUPPRESSION_GOVERNANCE_DESCRIPTION =
  'Suppression records are append-only. Release requests create auditable review facts and never delete the minimum do-not-contact record.';

@ApiTags('Discovery')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Post('query-plans/:planId/execute')
  @RequireScopes(...DISCOVERY_SCOPES.execute)
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
  @RequireScopes(...DISCOVERY_SCOPES.getRun)
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
  @RequireScopes(...DISCOVERY_SCOPES.listCompanies)
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
  @RequireScopes(...DISCOVERY_SCOPES.getCompany)
  @ApiOperation({ summary: '公司详情：canonical 视图 + 联系人 + 字段级 Evidence（每个字段值的来源）' })
  @ApiEnvelope(CANONICAL_COMPANY_SCHEMA)
  async getCompany(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return envelope(await this.discovery.getCanonicalCompany(ctx, id));
  }

  @Post('canonical-companies/:id/discover-contacts')
  @RequireScopes(...DISCOVERY_SCOPES.discoverContacts)
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
  @RequireScopes(...DISCOVERY_SCOPES.verify)
  @HttpCode(200)
  @ApiOperation({
    summary: '邮箱验证（Waterfall 第7步）：状态回写 UNVERIFIED→VALID|RISKY|INVALID|BLOCKED',
    description:
      '合规门：职能邮箱默认自动验证；人名邮箱（个人数据）需 lawfulBasis，否则 BLOCKED（不探测）。公开 API 不提供无依据绕过。',
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
      }),
    );
  }

  @Post('canonical-companies/:id/guess-emails')
  @RequireScopes(...DISCOVERY_SCOPES.guessEmails)
  @HttpCode(200)
  @ApiOperation({
    summary: '猜测缺邮箱决策人的邮箱（排列/格式学习 + SMTP RCPT 验证 → 落库）',
    description:
      '合规门：猜出的都是人名邮箱（个人数据），需 lawfulBasis，否则一律 blocked（零探测）；公开 API 不提供无依据绕过。' +
      'RISKY 未证实猜测落库但 allowedActions 不含 outreach（不可群发）；suppression 命中不落。',
  })
  // body 可选：无 body 则全 blocked（无 lawfulBasis），诚实不探。
  @ApiBody({ type: GuessEmailsDto, required: false })
  @ApiEnvelope({ type: 'object', additionalProperties: true, description: '邮箱猜测结果（补全计数 + 逐决策人状态/落库态）' })
  async guessEmails(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto?: GuessEmailsDto) {
    return envelope(
      await this.discovery.guessEmailsForCompany(ctx, id, {
        lawfulBasis: dto?.lawfulBasis
          ? { basis: dto.lawfulBasis, ref: dto.lawfulBasisRef, note: dto.lawfulBasisNote }
          : undefined,
        maxContacts: dto?.maxContacts,
        maxProbe: dto?.maxProbe,
      }),
    );
  }

  // ── Suppression ───────────────────────────────────────────────────────────

  @Post('suppressions')
  @RequireScopes(...DISCOVERY_SCOPES.addSuppression)
  @HttpCode(201)
  @ApiOperation({
    summary: '加入禁联名单（email/domain/company_name）；命中的公司立即 SUPPRESSED',
    description: SUPPRESSION_GOVERNANCE_DESCRIPTION,
  })
  @ApiEnvelope({ type: 'object', additionalProperties: true, description: 'Suppression 记录' }, { status: 201 })
  async addSuppression(@Ctx() ctx: RequestContext, @Body() dto: CreateSuppressionDto) {
    return envelope(await this.discovery.addSuppression(ctx, dto));
  }

  @Get('suppressions')
  @RequireScopes(...DISCOVERY_SCOPES.listSuppressions)
  @ApiOperation({
    summary: '禁联名单',
    description: SUPPRESSION_GOVERNANCE_DESCRIPTION,
  })
  @ApiListEnvelope({ type: 'object', additionalProperties: true, description: 'Suppression 记录' })
  async listSuppressions(@Ctx() ctx: RequestContext) {
    return envelope(await this.discovery.listSuppressions(ctx));
  }

  @Delete("suppressions/:id")
  @RequireScopes(...DISCOVERY_SCOPES.removeSuppression)
  @ApiOperation({
    summary: "已弃用：禁联记录不可物理删除；改用 release review request",
    description: SUPPRESSION_GOVERNANCE_DESCRIPTION,
    deprecated: true,
  })
  @ApiEnvelope({
    type: "object",
    required: ["deleted"],
    properties: { deleted: { type: "boolean" } },
  })
  async removeSuppression(
    @Ctx() ctx: RequestContext,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return envelope(await this.discovery.removeSuppression(ctx, id));
  }

  @Post("suppressions/:id/release-requests")
  @RequireScopes(...DISCOVERY_SCOPES.requestSuppressionRelease)
  @HttpCode(202)
  @ApiOperation({
    summary: "提交 append-only suppression release/correction 人工复核请求",
    description:
      "只创建 PENDING review fact，不会解除禁联。退订、投诉、Art.17/Art.21 等不得通过普通偏好请求释放。 " +
      SUPPRESSION_GOVERNANCE_DESCRIPTION,
  })
  @ApiEnvelope(
    {
      type: "object",
      additionalProperties: true,
      description: "append-only suppression release review request",
    },
    { status: 202 },
  )
  async requestSuppressionRelease(
    @Ctx() ctx: RequestContext,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RequestSuppressionReleaseDto,
  ) {
    return envelope(
      await this.discovery.requestSuppressionRelease(ctx, id, {
        requestKind: dto.requestKind,
        justification: dto.justification,
        evidenceRef: dto.evidenceRef ?? null,
      }),
    );
  }

  @Get("data-providers")
  @RequireScopes(...DISCOVERY_SCOPES.listProviders)
  @ApiOperation({
    summary: "Provider 注册表（平台级：状态/成本；DISABLED = Kill Switch）",
  })
  @ApiListEnvelope({
    type: "object",
    additionalProperties: true,
    description: "DataProvider（源/状态/成本）",
  })
  async listProviders(@Ctx() ctx: RequestContext) {
    return envelope(await this.discovery.listProviders(ctx));
  }
}
