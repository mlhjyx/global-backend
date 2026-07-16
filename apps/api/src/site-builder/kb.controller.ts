import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { ApiEnvelope } from '../common/api-envelope.decorator';
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
  @ApiEnvelope({
    type: 'object',
    required: ['documents', 'chunks', 'gaps'],
    properties: {
      documents: { type: 'integer', minimum: 0 },
      chunks: { type: 'integer', minimum: 0 },
      gaps: {
        type: 'array',
        items: {
          type: 'object',
          required: ['field', 'reason', 'hint'],
          properties: {
            field: { type: 'string' },
            reason: { type: 'string' },
            hint: { type: 'string' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Site UUID 格式错误',
    schema: {
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', enum: ['VALIDATION_ERROR'] },
            message: { type: 'string' },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: '当前 workspace 不可见该 Site',
    schema: {
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: {
            code: { type: 'string', enum: ['NOT_FOUND'] },
            message: { type: 'string' },
          },
        },
      },
    },
  })
  async status(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) siteId: string,
  ): Promise<Enveloped<KbStatus>> {
    return envelope(await this.kb.status(ctx, siteId));
  }
}
