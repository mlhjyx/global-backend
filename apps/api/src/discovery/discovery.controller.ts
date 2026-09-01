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
  UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiQuery, ApiResponse, ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID,
  Matches,
  Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { envelope, pageEnvelope } from '../common/envelope';
import { ApiEnvelope, ApiListEnvelope, ApiPageEnvelope } from '../common/api-envelope.decorator';
import {
  DiscoveryService,
  SUPPRESSION_DECISIONS,
  SUPPRESSION_DECISION_REASONS,
  SuppressionDecisionRequest,
} from './discovery.service';
import { LAWFUL_BASIS_KINDS } from './compliance/email-verification-gate';
import { DEFAULT_MAX_GUESS_CONTACTS, MAX_EMAIL_PROBE_CANDIDATES } from './email-guess-targets';
import { LawfulBasisKind } from './provider-contract';
import { SUPPRESSION_TYPES } from './suppression-value';
import {
  ApiExecutionBudgetGrant,
  asExecutionBudgetHttpBoundary,
  ExecutionBudgetGrant,
} from '../execution-budget/execution-budget-grant.decorator';

// eslint-disable-next-line no-control-regex -- boundary contract intentionally rejects ASCII control characters.
const NO_CONTROL_CHARS = new RegExp('^[^\\u0000-\\u001f\\u007f]*$', 'u');

class CreateSuppressionDto {
  @ApiProperty({ enum: SUPPRESSION_TYPES })
  @IsIn(SUPPRESSION_TYPES)
  type!: string;

  @ApiProperty({ example: 'noreply@example.com', minLength: 1, maxLength: 2048,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  value!: string;

  @ApiPropertyOptional({ enum: ['unsubscribe', 'bounce', 'complaint', 'manual', 'legal'],
  })
  @IsOptional()
  @IsIn(['unsubscribe', 'bounce', 'complaint', 'manual', 'legal'])
  reason?: string;
}

class SuppressionDecisionDto implements SuppressionDecisionRequest {
  @ApiProperty({ format: 'uuid', description: '调用方生成的幂等请求 ID' })
  @IsUUID('4')
  requestId!: string;

  @ApiProperty({ enum: SUPPRESSION_DECISIONS })
  @IsIn(SUPPRESSION_DECISIONS)
  decision!: SuppressionDecisionRequest['decision'];

  @ApiProperty({ enum: SUPPRESSION_DECISION_REASONS })
  @IsIn(SUPPRESSION_DECISION_REASONS)
  reasonCode!: SuppressionDecisionRequest['reasonCode'];
}

class SuppressionPageDto {
  @ApiPropertyOptional({ format: 'uuid', description: '上一页最后一条记录的 id',
  })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/**
 * 邮箱验证的合规上下文（可选）。职能邮箱可空；探测**人名邮箱**需给合法性基础或显式开关，
 * 否则合规门返回 status=BLOCKED（不做任何 SMTP 探测）。
 */
class VerifyContactPointDto {
  @ApiPropertyOptional({ enum: LAWFUL_BASIS_KINDS, description: '探测人名邮箱的合法性基础（GDPR Art.6）；职能邮箱可省略',
  })
  @IsOptional()
  @IsIn(LAWFUL_BASIS_KINDS as unknown as string[])
  lawfulBasis?: LawfulBasisKind;

  @ApiPropertyOptional({ description: 'LIA / 工单 / 合同 / 同意记录的引用（可审计）',
    maxLength: 512,
    pattern: NO_CONTROL_CHARS.source,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(NO_CONTROL_CHARS)
  lawfulBasisRef?: string;

  @ApiPropertyOptional({ description: '备注',
    maxLength: 1000,
    pattern: NO_CONTROL_CHARS.source,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Matches(NO_CONTROL_CHARS)
  lawfulBasisNote?: string;

  @ApiPropertyOptional({ description: '显式开关：无 lawfulBasis 也允许探测人名邮箱（默认 false，仍留痕）',
  })
  @IsOptional()
  @IsBoolean()
  allowPersonalWithoutBasis?: boolean;
}

/**
 * Named-contact discovery processes personal data, so every product request
 * must carry an explicit, auditable Art. 6 basis. There is deliberately no
 * development or policy-override bypass on this endpoint.
 */
class DiscoverContactsDto {
  @ApiProperty({
    enum: LAWFUL_BASIS_KINDS,
    description: '发现并持久化具名联系人的合法性基础（GDPR Art.6）',
  })
  @IsIn(LAWFUL_BASIS_KINDS as unknown as string[])
  lawfulBasis!: LawfulBasisKind;

  @ApiPropertyOptional({
    description: 'LIA / 工单 / 合同 / 同意记录的引用（可审计）',
    maxLength: 512,
    pattern: NO_CONTROL_CHARS.source,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(NO_CONTROL_CHARS)
  lawfulBasisRef?: string;

  @ApiPropertyOptional({
    description: '有界审计备注',
    maxLength: 1000,
    pattern: NO_CONTROL_CHARS.source,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Matches(NO_CONTROL_CHARS)
  lawfulBasisNote?: string;
}

/**
 * 决策人邮箱猜测的合规上下文（可选）。猜出的候选**都是人名邮箱**（个人数据），缺 lawfulBasis
 * 且未开 allowPersonalWithoutBasis → 合规门 blocked（零探测）。maxContacts/maxProbe 为有界护栏。
 */
class GuessEmailsDto {
  @ApiPropertyOptional({ enum: LAWFUL_BASIS_KINDS, description: '探测人名邮箱的合法性基础（GDPR Art.6）；猜出的都是人名邮箱',
  })
  @IsOptional()
  @IsIn(LAWFUL_BASIS_KINDS as unknown as string[])
  lawfulBasis?: LawfulBasisKind;

  @ApiPropertyOptional({ description: 'LIA / 工单 / 合同 / 同意记录的引用（可审计）',
    maxLength: 512,
    pattern: NO_CONTROL_CHARS.source,
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  @Matches(NO_CONTROL_CHARS)
  lawfulBasisRef?: string;

  @ApiPropertyOptional({ description: '备注',
    maxLength: 1000,
    pattern: NO_CONTROL_CHARS.source,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Matches(NO_CONTROL_CHARS)
  lawfulBasisNote?: string;

  @ApiPropertyOptional({ description: '显式开关：无 lawfulBasis 也允许探测人名邮箱（默认 false，仍留痕）',
  })
  @IsOptional()
  @IsBoolean()
  allowPersonalWithoutBasis?: boolean;

  @ApiPropertyOptional({
    type: 'integer',
    description: '最多补全几个缺邮箱决策人（有界护栏，默认 25）',
    minimum: 1,
    maximum: DEFAULT_MAX_GUESS_CONTACTS,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(DEFAULT_MAX_GUESS_CONTACTS)
  maxContacts?: number;

  @ApiPropertyOptional({
    type: 'integer',
    description: '每人最多探测几个候选（有界护栏，默认 8）',
    minimum: 1,
    maximum: MAX_EMAIL_PROBE_CANDIDATES,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_EMAIL_PROBE_CANDIDATES)
  maxProbe?: number;
}

/** 归一后公司行；字段级结构化 DTO 待实体解析最小版（ADR-007）定型。 */
const CANONICAL_COMPANY_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  description: 'CanonicalCompany（归一视图 + 联系人 + 字段级 Evidence）',
};

const suppressionErrorSchema = (codes: readonly string[], includeDecisionId = false) => ({
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', enum: [...codes] },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
        ...(includeDecisionId ? { decisionId: { type: 'string', format: 'uuid' } } : {}),
      },
    },
  },
});

const SUPPRESSION_CREATE_VALIDATION_ERROR_SCHEMA = suppressionErrorSchema([
  'VALIDATION_ERROR',
  'INVALID_SUPPRESSION_VALUE',
]);
const SUPPRESSION_PATH_VALIDATION_ERROR_SCHEMA = suppressionErrorSchema(['VALIDATION_ERROR']);
const SUPPRESSION_DECISION_VALIDATION_ERROR_SCHEMA = suppressionErrorSchema(['VALIDATION_ERROR', 'INVALID_REASON']);
const SUPPRESSION_NOT_FOUND_SCHEMA = suppressionErrorSchema(['NOT_FOUND']);
const SUPPRESSION_DECISION_CONFLICT_SCHEMA = suppressionErrorSchema(
  ['LEGAL_SUPPRESSION_IMMUTABLE', 'IDEMPOTENCY_CONFLICT', 'DECISION_NOT_PERSISTED'],
  true,
);

@ApiTags('Discovery')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:read')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Post('query-plans/:planId/execute')
  @RequireScopes('acquisition:write')
  @HttpCode(202)
  @ApiOperation({ summary: '执行 READY 查询计划：多源发现 → Raw → Canonical（异步，Temporal 编排）',
  })
  @ApiExecutionBudgetGrant()
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
  async execute(
    @Ctx() ctx: RequestContext,
    @Param('planId', ParseUUIDPipe) planId: string,
    @ExecutionBudgetGrant() compactJws?: string,
  ) {
    const run = await asExecutionBudgetHttpBoundary(() =>
      this.discovery.executePlan(ctx, planId, compactJws),
    );
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
  @ApiOperation({ summary: '发现的目标客户公司（归一后，游标分页；?status=NEW|ENRICHED|SUPPRESSED）',
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', default: 20, maximum: 100 },
  })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiPageEnvelope(CANONICAL_COMPANY_SCHEMA)
  async listCompanies(
    @Ctx() ctx: RequestContext,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const r = await this.discovery.listCanonicalCompanies(ctx, { status, limit: n, cursor,
    });
    return pageEnvelope(r.data, r);
  }

  @Get('canonical-companies/:id')
  @RequireScopes('acquisition:read', 'personal-data:read')
  @ApiOperation({ summary: '公司详情：canonical 视图 + 联系人 + 字段级 Evidence（每个字段值的来源）',
  })
  @ApiEnvelope(CANONICAL_COMPANY_SCHEMA)
  async getCompany(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return envelope(await this.discovery.getCanonicalCompany(ctx, id));
  }

  @Post('canonical-companies/:id/discover-contacts')
  @RequireScopes(
    'acquisition:write',
    'personal-data:read',
    'compliance:manage')
  @HttpCode(201)
  @ApiOperation({ summary: '按需发现联系人（Waterfall 第5步：仅高价值企业；Suppression 先行过滤）',
  })
  @ApiExecutionBudgetGrant({
    additionalForbiddenCodes: [
      'CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED',
    ],
  })
  @ApiBody({
    type: DiscoverContactsDto,
    required: false,
    description:
      'Required for execution. An absent body is rejected before authority consumption with CONTACT_DISCOVERY_LAWFUL_BASIS_REQUIRED.',
  })
  @ApiEnvelope(
    { type: 'object', additionalProperties: true, description: '联系人发现结果（新建联系人/联系点计数）',
    },
    { status: 201 },
  )
  async discoverContacts(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto?: DiscoverContactsDto,
    @ExecutionBudgetGrant() compactJws?: string,
  ) {
    return envelope(
      await asExecutionBudgetHttpBoundary(() =>
        this.discovery.discoverContacts(
          ctx,
          id,
          {
            lawfulBasis: dto
              ? {
                  basis: dto.lawfulBasis,
                  ref: dto.lawfulBasisRef,
                  note: dto.lawfulBasisNote,
                }
              : undefined,
          },
          compactJws,
        ),
      ),
    );
  }

  @Post('contact-points/:pointId/verify')
  @RequireScopes(
    'acquisition:write',
    'personal-data:read',
    'compliance:manage')
  @HttpCode(200)
  @ApiOperation({
    summary: '邮箱验证（Waterfall 第7步）：状态回写 UNVERIFIED→VALID|RISKY|INVALID|BLOCKED',
    description:
      '合规门：职能邮箱默认自动验证；人名邮箱（个人数据）需 lawfulBasis 或 allowPersonalWithoutBasis，否则 BLOCKED（不探测）。',
  })
  @ApiExecutionBudgetGrant()
  // body 可选：职能邮箱无需合规上下文即可 body-less 调用；仅人名邮箱要 lawfulBasis。
  @ApiBody({ type: VerifyContactPointDto, required: false })
  @ApiEnvelope({ type: 'object', additionalProperties: true, description: '验证结果（status + 探测细节留痕）',
  })
  async verify(
    @Ctx() ctx: RequestContext,
    @Param('pointId', ParseUUIDPipe) pointId: string,
    @Body() dto?: VerifyContactPointDto,
    @ExecutionBudgetGrant() compactJws?: string,
  ) {
    return envelope(
      await asExecutionBudgetHttpBoundary(() =>
        this.discovery.verifyContactPoint(
          ctx,
          pointId,
          {
            lawfulBasis: dto?.lawfulBasis
              ? {
                  basis: dto.lawfulBasis,
                  ref: dto.lawfulBasisRef,
                  note: dto.lawfulBasisNote,
                }
              : undefined,
            allowPersonalWithoutBasis: dto?.allowPersonalWithoutBasis,
          },
          compactJws,
          dto,
        ),
      ),
    );
  }

  @Post('canonical-companies/:id/guess-emails')
  @RequireScopes(
    'acquisition:write',
    'personal-data:read',
    'compliance:manage')
  @HttpCode(200)
  @ApiOperation({
    summary: '猜测缺邮箱决策人的邮箱（排列/格式学习 + SMTP RCPT 验证 → 落库）',
    description:
      '合规门：猜出的都是人名邮箱（个人数据），需 lawfulBasis 或 allowPersonalWithoutBasis，否则一律 blocked（零探测）。' +
      'RISKY 未证实猜测落库但 allowedActions 不含 outreach（不可群发）；suppression 命中不落。',
  })
  @ApiExecutionBudgetGrant()
  // body 可选：无 body 则全 blocked（无 lawfulBasis），诚实不探。
  @ApiBody({ type: GuessEmailsDto, required: false })
  @ApiEnvelope({ type: 'object', additionalProperties: true, description: '邮箱猜测结果（补全计数 + 逐决策人状态/落库态）',
  })
  async guessEmails(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto?: GuessEmailsDto,
    @ExecutionBudgetGrant() compactJws?: string,
  ) {
    return envelope(
      await asExecutionBudgetHttpBoundary(() =>
        this.discovery.guessEmailsForCompany(
          ctx,
          id,
          {
            lawfulBasis: dto?.lawfulBasis
              ? {
                  basis: dto.lawfulBasis,
                  ref: dto.lawfulBasisRef,
                  note: dto.lawfulBasisNote,
                }
              : undefined,
            allowPersonalWithoutBasis: dto?.allowPersonalWithoutBasis,
            maxContacts: dto?.maxContacts,
            maxProbe: dto?.maxProbe,
          },
          compactJws,
          dto,
        ),
      ),
    );
  }

  // ── Suppression ───────────────────────────────────────────────────────────

  @Post('suppressions')
  @RequireScopes('compliance:manage')
  @HttpCode(201)
  @ApiOperation({ summary: '加入禁联名单（email/domain/company_name）；命中的公司立即 SUPPRESSED',
  })
  @ApiEnvelope({ type: 'object', additionalProperties: true, description: 'Suppression 记录',
    }, { status: 201 },
  )
  @ApiResponse({ status: 400, description: '请求校验失败或 suppression value 非法', schema: SUPPRESSION_CREATE_VALIDATION_ERROR_SCHEMA,
  })
  async addSuppression(@Ctx() ctx: RequestContext, @Body() dto: CreateSuppressionDto) {
    return envelope(await this.discovery.addSuppression(ctx, dto));
  }

  @Get('suppressions')
  @RequireScopes('compliance:manage', 'personal-data:read')
  @ApiOperation({ summary: '禁联名单' })
  @ApiPageEnvelope({ type: 'object', additionalProperties: true, description: 'Suppression 记录',
  })
  @ApiResponse({ status: 400, description: '分页参数校验失败', schema: SUPPRESSION_PATH_VALIDATION_ERROR_SCHEMA,
  })
  async listSuppressions(@Ctx() ctx: RequestContext, @Query() page: SuppressionPageDto) {
    const result = await this.discovery.listSuppressions(ctx, page);
    return pageEnvelope(result.rows, result);
  }

  @Post('suppressions/:id/decisions')
  @RequireScopes('compliance:manage')
  @HttpCode(201)
  @ApiOperation({
    summary: '追加 suppression release/correction 请求；请求本身不解除禁联',
    description: '法定 suppression 的 release 请求会持久化拒绝审计并返回 409。',
  })
  @ApiEnvelope({ type: 'object', additionalProperties: true, description: 'append-only SuppressionDecision',
    }, { status: 201 },
  )
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 400, description: '路径或请求体校验失败', schema: SUPPRESSION_DECISION_VALIDATION_ERROR_SCHEMA,
  })
  @ApiResponse({ status: 404, description: 'suppression 不存在', schema: SUPPRESSION_NOT_FOUND_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: '法定 suppression 不可释放，或幂等 requestId 与首个事实冲突',
    schema: SUPPRESSION_DECISION_CONFLICT_SCHEMA,
  })
  async requestSuppressionDecision(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuppressionDecisionDto,
  ) {
    return envelope(await this.discovery.requestSuppressionDecision(ctx, id, dto));
  }

  @Get('suppressions/:id/decisions')
  @RequireScopes('compliance:manage')
  @ApiOperation({ summary: '列出 suppression 的 append-only release/correction 决策',
  })
  @ApiPageEnvelope({ type: 'object', additionalProperties: true, description: 'SuppressionDecision',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 400, description: '路径或分页参数校验失败', schema: SUPPRESSION_PATH_VALIDATION_ERROR_SCHEMA,
  })
  @ApiResponse({ status: 404, description: 'suppression 不存在', schema: SUPPRESSION_NOT_FOUND_SCHEMA,
  })
  async listSuppressionDecisions(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() page: SuppressionPageDto,
  ) {
    const result = await this.discovery.listSuppressionDecisions(ctx, id, page);
    return pageEnvelope(result.rows, result);
  }

  @Delete('suppressions/:id')
  @RequireScopes('compliance:manage')
  @ApiOperation({
    summary: '已弃用：提交 preference release request，永不物理删除',
    deprecated: true,
  })
  @ApiEnvelope({
    type: 'object',
    required: ['deleted', 'releaseRequested', 'decisionId'],
    properties: {
      deleted: { type: 'boolean', enum: [false] },
      releaseRequested: { type: 'boolean', enum: [true] },
      decisionId: { type: 'string', format: 'uuid' },
    },
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 400, description: '路径参数校验失败', schema: SUPPRESSION_PATH_VALIDATION_ERROR_SCHEMA,
  })
  @ApiResponse({ status: 404, description: 'suppression 不存在', schema: SUPPRESSION_NOT_FOUND_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: '法定 suppression 不可释放；拒绝决策已 append-only 持久化',
    schema: SUPPRESSION_DECISION_CONFLICT_SCHEMA,
  })
  async removeSuppression(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return envelope(await this.discovery.removeSuppression(ctx, id));
  }

  @Get('data-providers')
  @RequireScopes('ops:read')
  @ApiOperation({ summary: 'Provider 注册表（平台级：状态/成本；DISABLED = Kill Switch）',
  })
  @ApiListEnvelope({ type: 'object', additionalProperties: true, description: 'DataProvider（源/状态/成本）',
  })
  async listProviders(@Ctx() ctx: RequestContext) {
    return envelope(await this.discovery.listProviders(ctx));
  }
}
