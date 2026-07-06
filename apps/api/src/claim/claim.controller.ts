import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { ClaimService } from './claim.service';
import { ClaimDto } from './dto/claim.dto';

class CreateManualClaimDto {
  @ApiProperty({
    description: '事实类型',
    example: 'certification',
  })
  @IsString()
  @MaxLength(50)
  type!: string;

  @ApiProperty({ example: '通过 IATF 16949 认证（2025 续证）' })
  @IsString()
  @MaxLength(2000)
  statement!: string;

  @ApiPropertyOptional({ description: '依据说明（证书编号、内部资料名等）' })
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

@ApiTags('Claims')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class ClaimController {
  constructor(private readonly claims: ClaimService) {}

  @Get('companies/:companyId/claims')
  @ApiOperation({ summary: '列出企业的 Claim（可用 ?status=NEEDS_REVIEW 过滤）' })
  @ApiOkResponse({ type: [ClaimDto] })
  async list(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Query('status') status?: string,
  ): Promise<{ data: ClaimDto[] }> {
    const rows = await this.claims.listForCompany(ctx, companyId, status);
    return { data: rows.map(ClaimDto.from) };
  }

  @Post('claims/:claimId/approve')
  @HttpCode(200)
  @ApiOperation({ summary: '审批通过（NEEDS_REVIEW → APPROVED），发 ClaimApproved 事件' })
  @ApiOkResponse({ type: ClaimDto })
  async approve(
    @Ctx() ctx: RequestContext,
    @Param('claimId', ParseUUIDPipe) claimId: string,
  ): Promise<ClaimDto> {
    return ClaimDto.from(await this.claims.transition(ctx, claimId, 'APPROVED'));
  }

  @Post('claims/:claimId/reject')
  @HttpCode(200)
  @ApiOperation({ summary: '驳回（NEEDS_REVIEW → REVOKED）' })
  @ApiOkResponse({ type: ClaimDto })
  async reject(
    @Ctx() ctx: RequestContext,
    @Param('claimId', ParseUUIDPipe) claimId: string,
  ): Promise<ClaimDto> {
    return ClaimDto.from(await this.claims.transition(ctx, claimId, 'REVOKED'));
  }

  @Post('companies/:companyId/claims')
  @HttpCode(201)
  @ApiOperation({ summary: '手工录入企业事实（KNW-001 手工路径，进入同一审批生命周期）' })
  @ApiOkResponse({ type: ClaimDto })
  async createManual(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: CreateManualClaimDto,
  ): Promise<ClaimDto> {
    return ClaimDto.from(await this.claims.createManual(ctx, companyId, dto));
  }

  @Post('claims/:claimId/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: '撤销已批准事实（APPROVED → REVOKED，发 ClaimRevoked —— 下游停止使用）' })
  @ApiOkResponse({ type: ClaimDto })
  async revoke(
    @Ctx() ctx: RequestContext,
    @Param('claimId', ParseUUIDPipe) claimId: string,
  ): Promise<ClaimDto> {
    return ClaimDto.from(await this.claims.revoke(ctx, claimId));
  }

  @Get('companies/:companyId/conflicts')
  @ApiOperation({ summary: '知识冲突列表（KNW-004；?status=OPEN）' })
  async listConflicts(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Query('status') status?: string,
  ) {
    return { data: await this.claims.listConflicts(ctx, companyId, status) };
  }

  @Post('conflicts/:conflictId/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: '裁决冲突：保留一条，另一条 REVOKED' })
  async resolveConflict(
    @Ctx() ctx: RequestContext,
    @Param('conflictId', ParseUUIDPipe) conflictId: string,
    @Body() dto: ResolveConflictDto,
  ) {
    return this.claims.resolveConflict(ctx, conflictId, dto.keep);
  }
}
