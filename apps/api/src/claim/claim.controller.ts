import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { ClaimService } from './claim.service';
import { ClaimDto } from './dto/claim.dto';

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
}
