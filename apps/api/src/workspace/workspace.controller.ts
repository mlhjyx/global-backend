import { Body, Controller, Get, HttpCode, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import type { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { envelope, type Enveloped } from '../common/envelope';
import {
  UpdateWorkspaceDto,
  WorkspaceDto,
  WorkspaceUsageSummaryDto,
} from './dto/workspace.dto';
import { WorkspaceService } from './workspace.service';

@ApiTags('Workspace')
@ApiBearerAuth()
@Controller('workspace')
@UseGuards(AuthGuard, ScopesGuard)
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Patch()
  @RequireScopes('acquisition:write')
  @HttpCode(200)
  @ApiOperation({ summary: '同步工作空间名称（支持懒创建空间幂等 upsert）' })
  @ApiEnvelope(WorkspaceDto)
  async update(
    @Ctx() ctx: RequestContext,
    @Body() dto: UpdateWorkspaceDto,
  ): Promise<Enveloped<WorkspaceDto>> {
    return envelope(WorkspaceDto.from(await this.workspace.update(ctx, dto)));
  }

  @Get('usage-summary')
  @RequireScopes('acquisition:read')
  @ApiOperation({ summary: '获取当前工作空间的实体数量与存储用量全景' })
  @ApiEnvelope(WorkspaceUsageSummaryDto)
  async usageSummary(
    @Ctx() ctx: RequestContext,
  ): Promise<Enveloped<WorkspaceUsageSummaryDto>> {
    return envelope(await this.workspace.usageSummary(ctx));
  }
}
