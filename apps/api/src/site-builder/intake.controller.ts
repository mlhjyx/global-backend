import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { Enveloped, envelope } from '../common/envelope';
import { IntakeDto, IntakeResultDto } from './dto/intake.dto';
import { IntakeService } from './intake.service';

@ApiTags('SiteBuilder')
@ApiBearerAuth()
@Controller('site-builder')
@UseGuards(AuthGuard)
export class IntakeController {
  constructor(private readonly intake: IntakeService) {}

  @Post('intake')
  @HttpCode(201)
  @ApiOperation({
    summary: '注册引导提交：建站档案 + 秒级触发 demo v0（无站）或转站点诊断分支（有站，M3）',
  })
  @ApiEnvelope(IntakeResultDto, { status: 201 })
  async create(
    @Ctx() ctx: RequestContext,
    @Body() dto: IntakeDto,
  ): Promise<Enveloped<IntakeResultDto>> {
    return envelope(IntakeResultDto.from(await this.intake.create(ctx, dto)));
  }
}
