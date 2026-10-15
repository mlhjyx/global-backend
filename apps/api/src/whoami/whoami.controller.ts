import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { AUTHORIZATION_SCOPES } from '../auth/scopes';
import { Enveloped, envelope } from '../common/envelope';
import { ApiEnvelope } from '../common/api-envelope.decorator';

@ApiTags('System')
@ApiBearerAuth()
@Controller('whoami')
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('ops:read')
export class WhoamiController {
  @Get()
  @ApiOperation({ summary: '返回已验证身份与服务端派生权限（user / workspace / roles / scopes）' })
  @ApiEnvelope({
    type: 'object',
    required: ['userId', 'workspaceId', 'roles', 'scopes'],
    properties: {
      userId: { type: 'string' },
      workspaceId: { type: 'string', format: 'uuid' },
      roles: { type: 'array', items: { type: 'string' } },
      scopes: {
        type: 'array',
        description: '服务端派生的 scope。取值集合会随新能力增长：客户端须容忍未列出的值（按未知 scope 忽略），不要按封闭枚举校验。',
        items: {
          type: 'string',
          // Open on purpose: a closed `enum` makes every new scope a breaking response change
          // (oasdiff response-property-enum-value-added). The known values are still listed.
          'x-extensible-enum': [...AUTHORIZATION_SCOPES],
        },
      },
    },
  })
  whoami(@Ctx() ctx: RequestContext): Enveloped<RequestContext> {
    return envelope(ctx);
  }
}
