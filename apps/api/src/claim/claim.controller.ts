import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { ACQUISITION_CONTROLLER_SCOPE_INVENTORY } from '../auth/acquisition-scope-inventory';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { RequestContext } from '../auth/request-context';
import { Enveloped, envelope } from '../common/envelope';
import { ApiEnvelope, ApiListEnvelope } from '../common/api-envelope.decorator';
import { ClaimService } from './claim.service';
import { ClaimDto } from './dto/claim.dto';

const CLAIM_SCOPES = ACQUISITION_CONTROLLER_SCOPE_INVENTORY.ClaimController.operations;

class CreateManualClaimDto {
  @ApiProperty({
    description: '事实类型',
    example: 'certification',
    maxLength: 50,
  })
  @IsString()
  @MaxLength(50)
  type!: string;

  @ApiProperty({ example: '通过 IATF 16949 认证（2025 续证）', maxLength: 2000 })
  @IsString()
  @MaxLength(2000)
  statement!: string;

  @ApiPropertyOptional({ description: '依据说明（证书编号、内部资料名等）', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  evidence?: string;
}

class ResolveConflictDto {
  @ApiProperty({ enum: ['a', 'b'], description: '保留哪条 Claim（另一条 REVOKED）' })
  @IsIn(['a', 'b'])
  keep!: 'a' | 'b';
}

/** 知识冲突行（KNW-004）；结构化 DTO 待冲突裁决 UI 定型。 */
const CONFLICT_SCHEMA = { type: 'object', additionalProperties: true, description: '知识冲突（两条矛盾 Claim + 状态）' };

@ApiTags('Claims')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class ClaimController {
  constructor(private readonly claims: ClaimService) {}

  @Get('companies/:companyId/claims')
  @RequireScopes(...CLAIM_SCOPES.list)
  @ApiOperation({ summary: '列出企业的 Claim（可用 ?status=NEEDS_REVIEW 过滤）' })
  @ApiQuery({ name: 'status', required: false })
  @ApiListEnvelope(ClaimDto)
  async list(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Query('status') status?: string,
  ): Promise<Enveloped<ClaimDto[]>> {
    const rows = await this.claims.listForCompany(ctx, companyId, status);
    return envelope(rows.map(ClaimDto.from));
  }

  @Post('claims/:claimId/approve')
  @RequireScopes(...CLAIM_SCOPES.approve)
  @HttpCode(200)
  @ApiOperation({ summary: '审批通过（NEEDS_REVIEW → APPROVED），发 ClaimApproved 事件' })
  @ApiEnvelope(ClaimDto)
  async approve(
    @Ctx() ctx: RequestContext,
    @Param('claimId', ParseUUIDPipe) claimId: string,
  ): Promise<Enveloped<ClaimDto>> {
    return envelope(ClaimDto.from(await this.claims.transition(ctx, claimId, 'APPROVED')));
  }

  @Post('claims/:claimId/reject')
  @RequireScopes(...CLAIM_SCOPES.reject)
  @HttpCode(200)
  @ApiOperation({ summary: '驳回（NEEDS_REVIEW → REVOKED）' })
  @ApiEnvelope(ClaimDto)
  async reject(
    @Ctx() ctx: RequestContext,
    @Param('claimId', ParseUUIDPipe) claimId: string,
  ): Promise<Enveloped<ClaimDto>> {
    return envelope(ClaimDto.from(await this.claims.transition(ctx, claimId, 'REVOKED')));
  }

  @Post('companies/:companyId/claims')
  @RequireScopes(...CLAIM_SCOPES.createManual)
  @HttpCode(201)
  @ApiOperation({ summary: '手工录入企业事实（KNW-001 手工路径，进入同一审批生命周期）' })
  @ApiEnvelope(ClaimDto, { status: 201 })
  async createManual(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: CreateManualClaimDto,
  ): Promise<Enveloped<ClaimDto>> {
    return envelope(ClaimDto.from(await this.claims.createManual(ctx, companyId, dto)));
  }

  @Post('claims/:claimId/revoke')
  @RequireScopes(...CLAIM_SCOPES.revoke)
  @HttpCode(200)
  @ApiOperation({ summary: '撤销已批准事实（APPROVED → REVOKED，发 ClaimRevoked —— 下游停止使用）' })
  @ApiEnvelope(ClaimDto)
  async revoke(
    @Ctx() ctx: RequestContext,
    @Param('claimId', ParseUUIDPipe) claimId: string,
  ): Promise<Enveloped<ClaimDto>> {
    return envelope(ClaimDto.from(await this.claims.revoke(ctx, claimId)));
  }

  @Get('companies/:companyId/conflicts')
  @RequireScopes(...CLAIM_SCOPES.listConflicts)
  @ApiOperation({ summary: '知识冲突列表（KNW-004；?status=OPEN）' })
  @ApiQuery({ name: 'status', required: false })
  @ApiListEnvelope(CONFLICT_SCHEMA)
  async listConflicts(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Query('status') status?: string,
  ) {
    return envelope(await this.claims.listConflicts(ctx, companyId, status));
  }

  @Post('conflicts/:conflictId/resolve')
  @RequireScopes(...CLAIM_SCOPES.resolveConflict)
  @HttpCode(200)
  @ApiOperation({ summary: '裁决冲突：保留一条，另一条 REVOKED' })
  @ApiEnvelope(CONFLICT_SCHEMA)
  async resolveConflict(
    @Ctx() ctx: RequestContext,
    @Param('conflictId', ParseUUIDPipe) conflictId: string,
    @Body() dto: ResolveConflictDto,
  ) {
    return envelope(await this.claims.resolveConflict(ctx, conflictId, dto.keep));
  }
}
