import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';

@ApiTags('System')
@ApiBearerAuth()
@Controller('whoami')
@UseGuards(AuthGuard)
export class WhoamiController {
  @Get()
  @ApiOperation({ summary: '返回从 token 解出的调用上下文（user / workspace / roles）' })
  whoami(@Ctx() ctx: RequestContext): RequestContext {
    return ctx;
  }
}
