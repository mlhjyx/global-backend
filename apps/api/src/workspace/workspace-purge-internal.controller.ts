import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { envelope, type Enveloped } from '../common/envelope';
import {
  RequestWorkspacePurgeDto,
  WorkspacePurgeReceiptDto,
} from './dto/workspace-purge.dto';
import { WorkspacePurgeService } from './workspace-purge.service';
import { WorkspacePurgeServiceTokenGuard } from './workspace-purge-service-token.guard';

@ApiTags('Workspace')
@Controller('internal/workspaces')
@UseGuards(WorkspacePurgeServiceTokenGuard)
export class WorkspacePurgeInternalController {
  constructor(private readonly purges: WorkspacePurgeService) {}

  @Post(':id/purge')
  @HttpCode(202)
  @ApiOperation({
    summary: '服务身份触发整工作空间物理离网清理（异步 Temporal 编排，返回 202 回执）',
  })
  @ApiHeader({
    name: 'x-service-token',
    required: true,
    description: '内部服务令牌（env WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN）',
  })
  @ApiEnvelope(WorkspacePurgeReceiptDto, { status: 202 })
  @ApiResponse({ status: 401, description: '缺少或无效的服务令牌' })
  @ApiResponse({ status: 503, description: '服务令牌未配置或 Temporal 暂不可用' })
  async purge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestWorkspacePurgeDto,
  ): Promise<Enveloped<WorkspacePurgeReceiptDto>> {
    const receipt = await this.purges.requestPurge(id, dto);
    return envelope(WorkspacePurgeReceiptDto.from(receipt));
  }

  @Get(':id/purge')
  @ApiOperation({
    summary: '查询整工作空间物理清理回执状态（非 PII 审计回执）',
  })
  @ApiHeader({
    name: 'x-service-token',
    required: true,
    description: '内部服务令牌（env WORKSPACE_PURGE_INTERNAL_SERVICE_TOKEN）',
  })
  @ApiEnvelope(WorkspacePurgeReceiptDto)
  @ApiResponse({ status: 401, description: '缺少或无效的服务令牌' })
  @ApiResponse({ status: 404, description: '清理回执不存在' })
  async getPurgeReceipt(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Enveloped<WorkspacePurgeReceiptDto>> {
    const receipt = await this.purges.getReceipt(id);
    return envelope(WorkspacePurgeReceiptDto.from(receipt));
  }
}
