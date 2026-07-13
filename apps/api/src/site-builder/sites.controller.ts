import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { ApiEnvelope, ApiListEnvelope } from '../common/api-envelope.decorator';
import { Enveloped, envelope } from '../common/envelope';
import { SiteDto } from './dto/site.dto';
import { previewUrlFor } from './preview-url';
import { SitesService } from './sites.service';

@ApiTags('SiteBuilder')
@ApiBearerAuth()
@Controller('site-builder')
@UseGuards(AuthGuard)
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get('sites')
  @ApiOperation({ summary: '列出本 workspace 站点（含预览地址）' })
  @ApiListEnvelope(SiteDto)
  async list(@Ctx() ctx: RequestContext): Promise<Enveloped<SiteDto[]>> {
    const rows = await this.sites.list(ctx);
    return envelope(rows.map((row) => SiteDto.from(row, previewUrlFor(row))));
  }

  @Get('sites/:id')
  @ApiOperation({ summary: '站点详情' })
  @ApiEnvelope(SiteDto)
  async get(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Enveloped<SiteDto>> {
    const row = await this.sites.get(ctx, id);
    return envelope(SiteDto.from(row, previewUrlFor(row)));
  }

  @Get('sites/:id/profile')
  @ApiOperation({ summary: '建站向导档案（五组）' })
  async getProfile(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Enveloped<Record<string, unknown>>> {
    return envelope((await this.sites.getProfile(ctx, id)) as Record<string, unknown>);
  }

  @Patch('sites/:id/profile')
  @ApiOperation({ summary: '向导分步保存：组级替换（companyProfile/trustAssets/onlineAssets/brand/contact），可跳过' })
  async patchProfile(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() patch: Record<string, unknown>,
  ): Promise<Enveloped<Record<string, unknown>>> {
    return envelope((await this.sites.patchProfile(ctx, id, patch ?? {})) as Record<string, unknown>);
  }
}
