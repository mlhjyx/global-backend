import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import type { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { envelope, pageEnvelope } from '../common/envelope';
import { ApiEnvelope, ApiPageEnvelope } from '../common/api-envelope.decorator';
import { ApiOrganizationIdentityErrors } from './organization-identity.openapi';
import { OrganizationIdentityService, type IdentityDecisionRequest, type IdentitySplitRequest } from './organization-identity.service';

class IdentityDecisionDto implements IdentityDecisionRequest {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') requestId!: string;
  @ApiProperty({ enum: ['merge', 'keep_separate'] })
  @IsIn(['merge', 'keep_separate'])
  decision!: 'merge' | 'keep_separate';
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  canonicalCompanyId?: string;
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  reasonCode!: string;
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

class IdentitySplitDto implements IdentitySplitRequest {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') requestId!: string;
  @ApiProperty({ minLength: 1, maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  reasonCode!: string;
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

const IDENTITY_SCHEMA = { type: 'object', additionalProperties: true };

@ApiTags('Organization Identity')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:identity:review')
export class OrganizationIdentityController {
  constructor(private readonly identity: OrganizationIdentityService) {}

  @Get('organization-identity-conflicts')
  @ApiOperation({ summary: '身份冲突工作队列' })
  @ApiQuery({ name: 'status', required: false, enum: ['open', 'resolving', 'resolved'] })
  @ApiQuery({ name: 'cursor', required: false, format: 'uuid' })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiOrganizationIdentityErrors()
  @ApiPageEnvelope(IDENTITY_SCHEMA)
  async list(
    @Ctx() ctx: RequestContext,
    @Query('status') status?: 'open' | 'resolving' | 'resolved',
    @Query('cursor') cursor?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const limit = Math.min(Math.max(Number(rawLimit) || 20, 1), 100);
    const result = await this.identity.listConflicts(ctx, {
      status,
      cursor,
      limit,
    });
    return pageEnvelope(result.data, result);
  }

  @Get('organization-identity-conflicts/:id')
  @ApiOperation({ summary: '身份冲突事实、候选企业、标识与裁决历史' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOrganizationIdentityErrors({ notFound: true })
  @ApiEnvelope(IDENTITY_SCHEMA)
  async get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.identity.getConflict(ctx, id);
    response.setHeader('ETag', result.etag);
    response.setHeader('Cache-Control', 'private, no-cache');
    return envelope(result.conflict);
  }

  @Post('organization-identity-conflicts/:id/decisions')
  @HttpCode(202)
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'GET 冲突详情返回的强 ETag',
  })
  @ApiOperation({ summary: '合并或保持分离；决定与 replay outbox 同事务写入' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOrganizationIdentityErrors({
    notFound: true,
    precondition: true,
    conflictCodes: [
      'IDEMPOTENCY_CONFLICT',
      'COMMERCIAL_FACTS_IMMUTABLE',
      'NO_CANDIDATES',
      'IDENTITY_MERGE_REQUIRES_MULTIPLE_COMPANIES',
      'INVALID_CANONICAL_COMPANY',
      'IDENTITY_MAPPING_REQUIRES_REROOT',
    ],
  })
  @ApiEnvelope(IDENTITY_SCHEMA, { status: 202 })
  async decide(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: IdentityDecisionDto,
  ) {
    return envelope(await this.identity.decideConflict(ctx, id, ifMatch, dto));
  }

  @Get('organization-identity-mappings/:id')
  @ApiOperation({ summary: '可逆企业映射详情（用于取得 split ETag）' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOrganizationIdentityErrors({ notFound: true })
  @ApiEnvelope(IDENTITY_SCHEMA)
  async getMapping(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.identity.getMapping(ctx, id);
    response.setHeader('ETag', result.etag);
    response.setHeader('Cache-Control', 'private, no-cache');
    return envelope(result.mapping);
  }

  @Post('organization-identity-mappings/:id/split-decisions')
  @HttpCode(202)
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'GET 映射详情返回的强 ETag',
  })
  @ApiOperation({ summary: '撤销别名映射并请求确定性重放' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOrganizationIdentityErrors({
    notFound: true,
    precondition: true,
    conflictCodes: [
      'IDEMPOTENCY_CONFLICT',
      'COMMERCIAL_FACTS_IMMUTABLE',
      'IDENTITY_SPLIT_ALREADY_PENDING',
      'IDENTITY_MERGE_PROJECTION_UNSETTLED',
    ],
  })
  @ApiEnvelope(IDENTITY_SCHEMA, { status: 202 })
  async split(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: IdentitySplitDto,
  ) {
    return envelope(await this.identity.splitMapping(ctx, id, ifMatch, dto));
  }
}
