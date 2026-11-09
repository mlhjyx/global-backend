import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { envelope } from '../common/envelope';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { ChannelProbeService } from './channel-probe.service';
import { ChannelService } from './channel.service';
import {
  IMPORT_SAMPLE_CSV,
  parseCsv,
  suggestImportMapping,
} from './channel-import';

/**
 * M1 渠道数据源平台 API。
 *
 * - 平台渠道注册/治理/启停/试跑：ops:write（仅运营身份 saas-ops）；平台渠道登记表读取用 ops:read。
 * - 租户启用/停用已批准渠道、导入自己的名单：acquisition:write（租户管理员）。
 *   平台渠道的写权限不再与租户共享（数据源归属 P3：租户身份调用平台端点必须 403）。
 * - 抓取通道的试跑/运行：在平台抓取预算权威获批前 fail-closed（409），不绕过 ToolBroker。
 */
@ApiTags('Channels')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard, ScopesGuard)
export class ChannelsController {
  constructor(
    private readonly channels: ChannelService,
    private readonly probes: ChannelProbeService,
  ) {}

  @Get('source-channels')
  @RequireScopes('ops:read')
  @ApiOperation({ summary: '渠道列表（状态/模式/类别/最近运行；平台渠道对所有租户可见）' })
  @ApiEnvelope({ type: 'array', items: { type: 'object', additionalProperties: true } })
  async list(@Ctx() ctx: RequestContext) {
    return envelope(await this.channels.listChannels(ctx));
  }

  @Get('source-channels/available')
  @RequireScopes('acquisition:read')
  @ApiOperation({ summary: '租户可用渠道（已批准 ENABLED）+ 本工作空间是否已启用' })
  @ApiEnvelope({ type: 'array', items: { type: 'object', additionalProperties: true } })
  async available(@Ctx() ctx: RequestContext) {
    return envelope(await this.channels.listAvailable(ctx));
  }

  @Get('source-channels/import-template')
  @RequireScopes('acquisition:read')
  @ApiOperation({ summary: '导入通道示例 CSV（10 行，列映射与导入验收用；附建议 mapping 与可用列）' })
  @ApiEnvelope({
    type: 'object',
    required: ['csv', 'columns', 'mapping'],
    properties: {
      csv: { type: 'string' },
      columns: { type: 'array', items: { type: 'string' } },
      mapping: { type: 'object', additionalProperties: { type: 'string' } },
    },
  })
  async importTemplate() {
    const { headers } = parseCsv(IMPORT_SAMPLE_CSV);
    return envelope({
      csv: IMPORT_SAMPLE_CSV,
      columns: headers,
      mapping: suggestImportMapping(headers),
    });
  }

  @Post('source-channels')
  @RequireScopes('ops:write')
  @ApiOperation({ summary: '新建渠道（默认 DISABLED；治理信息齐全并经人工确认后才能启用）' })
  @ApiEnvelope({ type: 'object', additionalProperties: true })
  async create(@Ctx() ctx: RequestContext, @Body() body: Record<string, unknown>) {
    return envelope(await this.channels.createChannel(ctx, body));
  }

  @Patch('source-channels/:channelId')
  @RequireScopes('ops:write')
  @ApiOperation({ summary: '更新渠道配置/治理信息/状态（crawl 仅允许 robots A 启用，C 永不启用）' })
  @ApiEnvelope({ type: 'object', additionalProperties: true })
  async patch(
    @Ctx() ctx: RequestContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return envelope(await this.channels.patchChannel(ctx, channelId, body));
  }

  @Post('source-channels/:channelId/enable')
  @RequireScopes('acquisition:write')
  @ApiOperation({ summary: '租户启用一个已批准渠道' })
  @ApiEnvelope({
    type: 'object',
    required: ['channelId', 'enabled'],
    properties: { channelId: { type: 'string', format: 'uuid' }, enabled: { type: 'boolean' } },
  })
  async enable(@Ctx() ctx: RequestContext, @Param('channelId', ParseUUIDPipe) channelId: string) {
    return envelope(await this.channels.enableChannel(ctx, channelId));
  }

  @Delete('source-channels/:channelId/enable')
  @RequireScopes('acquisition:write')
  @ApiOperation({ summary: '租户停用渠道（平台渠道本身不受影响）' })
  @ApiEnvelope({
    type: 'object',
    required: ['channelId', 'enabled'],
    properties: { channelId: { type: 'string', format: 'uuid' }, enabled: { type: 'boolean' } },
  })
  async disable(@Ctx() ctx: RequestContext, @Param('channelId', ParseUUIDPipe) channelId: string) {
    return envelope(await this.channels.disableChannel(ctx, channelId));
  }

  @Get('source-channels/:channelId')
  @RequireScopes('ops:read')
  @ApiOperation({ summary: '渠道详情：manifest 全量 + 健康摘要 + 密钥「已配置/未配置」（值永不返回）' })
  @ApiEnvelope({ type: 'object', additionalProperties: true })
  async detail(@Ctx() ctx: RequestContext, @Param('channelId', ParseUUIDPipe) channelId: string) {
    return envelope(await this.channels.getChannel(ctx, channelId));
  }

  @Post('source-channels/:channelId/test')
  @RequireScopes('ops:write')
  @ApiOperation({
    summary: '保存即测试（probe）：按 manifest 试跑 1 页并落 source_channel_probe；未接平台出网绑定时 fail-closed 503',
  })
  @ApiEnvelope({ type: 'object', additionalProperties: true })
  async test(@Ctx() ctx: RequestContext, @Param('channelId', ParseUUIDPipe) channelId: string) {
    return envelope(await this.probes.probeChannel(ctx, channelId));
  }

  @Post('source-channels/:channelId/preview')
  @RequireScopes('ops:write')
  @ApiOperation({ summary: '试跑抓取通道（抓 1 页/前 20 条）——平台抓取预算权威获批前 fail-closed 409' })
  @ApiEnvelope({ type: 'object', additionalProperties: true })
  async preview(@Ctx() ctx: RequestContext, @Param('channelId', ParseUUIDPipe) channelId: string) {
    return envelope(await this.channels.requestCrawl(ctx, channelId, 'preview'));
  }

  @Post('source-channels/:channelId/run')
  @RequireScopes('ops:write')
  @ApiOperation({ summary: '立即运行抓取通道——平台抓取预算权威获批前 fail-closed 409' })
  @ApiEnvelope({ type: 'object', additionalProperties: true })
  async run(@Ctx() ctx: RequestContext, @Param('channelId', ParseUUIDPipe) channelId: string) {
    return envelope(await this.channels.requestCrawl(ctx, channelId, 'run'));
  }

  @Get('source-channels/:channelId/records')
  @RequireScopes('ops:read')
  @ApiOperation({
    summary: '查看渠道最近物化的抓取记录（含观察名单状态与计数；PII 按 OWNER-DECISION-2026-11-05 明文存储）',
  })
  // 可选过滤参数必须显式 required:false：@Query 推断默认 required，会把已有端点判成破坏性变更。
  @ApiQuery({ name: 'reviewStatus', required: false, enum: ['PENDING', 'APPROVED', 'REJECTED'] })
  @ApiEnvelope({ type: 'object', additionalProperties: true })
  async records(
    @Ctx() ctx: RequestContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Query('limit') limit?: string,
    @Query('reviewStatus') reviewStatus?: string,
  ) {
    return envelope(await this.channels.listChannelRecords(ctx, channelId, limit, reviewStatus));
  }

  @Post('source-channels/:channelId/records/review')
  @RequireScopes('ops:write')
  @ApiOperation({
    summary: '观察名单抽检：批量置 APPROVED/REJECTED（留 reviewed_by/at）；REJECTED 率 >20%（已抽检 ≥20）时渠道回 DISABLED',
  })
  @ApiEnvelope({ type: 'object', additionalProperties: true })
  async reviewRecords(
    @Ctx() ctx: RequestContext,
    @Param('channelId', ParseUUIDPipe) channelId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return envelope(await this.channels.reviewChannelRecords(ctx, channelId, body));
  }

  @Post('imported-buyers/preview')
  @RequireScopes('acquisition:write')
  @ApiOperation({ summary: '导入预览：解析 CSV、校验列映射、去重与抑制命中（不写库）' })
  @ApiEnvelope({ type: 'object', additionalProperties: true })
  async previewImport(@Ctx() ctx: RequestContext, @Body() body: Record<string, unknown>) {
    return envelope(await this.channels.previewImport(ctx, body));
  }

  @Post('imported-buyers')
  @RequireScopes('acquisition:write')
  @ApiOperation({ summary: '导入提交：原始行落 imported_buyer，去重/抑制后物化进公司池（私有）' })
  @ApiEnvelope({ type: 'object', additionalProperties: true })
  async importBuyers(@Ctx() ctx: RequestContext, @Body() body: Record<string, unknown>) {
    return envelope(await this.channels.importBuyers(ctx, body));
  }

  @Get('imported-buyers/:batchId')
  @RequireScopes('acquisition:read')
  @ApiOperation({ summary: '导入批次明细（每行状态：MATERIALIZED/DUPLICATE/SUPPRESSED）' })
  @ApiEnvelope({ type: 'array', items: { type: 'object', additionalProperties: true } })
  async batch(@Ctx() ctx: RequestContext, @Param('batchId', ParseUUIDPipe) batchId: string) {
    return envelope(await this.channels.listImportedBuyers(ctx, batchId));
  }
}
