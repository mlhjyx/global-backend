import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { Enveloped, envelope } from '../common/envelope';
import { KbService, KbStatus } from './kb.service';

@ApiTags('SiteBuilder')
@ApiBearerAuth()
@Controller('site-builder')
@UseGuards(AuthGuard)
export class KbController {
  constructor(private readonly kb: KbService) {}

  @Get('sites/:id/kb/status')
  @ApiOperation({ summary: '知识库状态：文档/块计数 + 待补资料缺口（gaps 随 M1 brandProfile）' })
  async status(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) siteId: string,
  ): Promise<Enveloped<KbStatus>> {
    return envelope(await this.kb.status(ctx, siteId));
  }
}
