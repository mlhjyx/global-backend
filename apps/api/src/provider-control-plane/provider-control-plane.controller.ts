import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import type { RequestContext } from '../auth/request-context';
import { RequireScopes } from '../auth/require-scopes.decorator';
import { ScopesGuard } from '../auth/scopes.guard';
import { envelope } from '../common/envelope';
import {
  PROVIDER_CONTROL_PLANE_RESPONSE_SCHEMA,
  type ProviderControlPlaneResponseDto,
} from './provider-control-plane.dto';
import { ProviderControlPlaneService } from './provider-control-plane.service';

const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
};

@ApiTags('Provider Control Plane')
@ApiBearerAuth()
@Controller('provider-control-plane')
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('ops:read')
export class ProviderControlPlaneController {
  constructor(private readonly controlPlane: ProviderControlPlaneService) {}

  @Get()
  @ApiOperation({
    summary: 'Provider 只读控制视图（注册、配置存在性、开关、策略、路由声明与证据分轨）',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['data'],
      properties: { data: PROVIDER_CONTROL_PLANE_RESPONSE_SCHEMA as SchemaObject },
    },
    headers: {
      'Cache-Control': {
        description: 'Sensitive configuration metadata must not be cached.',
        schema: { type: 'string', example: 'no-store' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Bearer token 缺失或无效', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: '缺少 ops:read 权限', schema: ERROR_SCHEMA })
  async list(
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ data: ProviderControlPlaneResponseDto }> {
    response.setHeader('Cache-Control', 'no-store');
    return envelope(await this.controlPlane.list(ctx));
  }
}
