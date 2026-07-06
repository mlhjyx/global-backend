import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { IcpService } from './icp.service';
import { IcpDto } from './dto/icp.dto';

@ApiTags('ICP')
@ApiBearerAuth()
@Controller()
@UseGuards(AuthGuard)
export class IcpController {
  constructor(private readonly icps: IcpService) {}

  @Post('companies/:companyId/icps')
  @HttpCode(201)
  @ApiOperation({ summary: '基于企业已确认事实，AI 生成理想客户画像(ICP) + 买家委员会（状态 HYPOTHESIS）' })
  @ApiOkResponse({ type: IcpDto })
  async generate(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ): Promise<IcpDto> {
    return IcpDto.from(await this.icps.generateFromCompany(ctx, companyId));
  }

  @Get('icps')
  @ApiOperation({ summary: '列出 ICP（可用 ?companyId= 过滤）' })
  @ApiOkResponse({ type: [IcpDto] })
  async list(
    @Ctx() ctx: RequestContext,
    @Query('companyId') companyId?: string,
  ): Promise<{ data: IcpDto[] }> {
    const rows = await this.icps.list(ctx, companyId);
    return { data: rows.map(IcpDto.from) };
  }

  @Get('icps/:icpId')
  @ApiOperation({ summary: '获取 ICP 详情（含 Persona + 买家委员会）' })
  @ApiOkResponse({ type: IcpDto })
  async get(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
  ): Promise<IcpDto> {
    return IcpDto.from(await this.icps.get(ctx, icpId));
  }

  @Post('icps/:icpId/activate')
  @HttpCode(200)
  @ApiOperation({ summary: '激活 ICP（→ ACTIVE），发 ICPActivated 事件' })
  @ApiOkResponse({ type: IcpDto })
  async activate(
    @Ctx() ctx: RequestContext,
    @Param('icpId', ParseUUIDPipe) icpId: string,
  ): Promise<IcpDto> {
    return IcpDto.from(await this.icps.activate(ctx, icpId));
  }
}
