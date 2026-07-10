import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { Enveloped, envelope } from '../common/envelope';
import { ApiEnvelope } from '../common/api-envelope.decorator';

@ApiTags('System')
@ApiBearerAuth()
@Controller('whoami')
@UseGuards(AuthGuard)
export class WhoamiController {
  @Get()
  @ApiOperation({ summary: '返回从 token 解出的调用上下文（user / workspace / roles）' })
  @ApiEnvelope({
    type: 'object',
    properties: {
      userId: { type: 'string' },
      workspaceId: { type: 'string', format: 'uuid' },
      roles: { type: 'array', items: { type: 'string' } },
    },
  })
  whoami(@Ctx() ctx: RequestContext): Enveloped<RequestContext> {
    return envelope(ctx);
  }
}
