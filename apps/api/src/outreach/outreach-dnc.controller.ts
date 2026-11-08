import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsString, MaxLength } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import type { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { envelope } from '../common/envelope';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import {
  OUTREACH_DNC_MAX_EMAILS,
  OUTREACH_DNC_REASONS,
  OutreachDncService,
  type OutreachDncReason,
} from './outreach-dnc.service';

class CheckOutreachDncDto {
  @ApiProperty({
    type: [String],
    maxItems: OUTREACH_DNC_MAX_EMAILS,
    description: '待检查的收件邮箱（≤50，调用方必须是已审批的 outreach 批次）',
  })
  @IsArray()
  @ArrayMaxSize(OUTREACH_DNC_MAX_EMAILS)
  @IsString({ each: true })
  emails!: string[];
}

class SuppressOutreachDncDto {
  @ApiProperty({
    description: '需要平台级抑制的收件邮箱（服务端只落 SHA-256，不存明文）',
    maxLength: 320,
  })
  @IsString()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ enum: OUTREACH_DNC_REASONS })
  @IsIn(OUTREACH_DNC_REASONS)
  reason!: OutreachDncReason;

  @ApiProperty({ description: '抑制来源（如 gain-saas:unsubscribe）', maxLength: 64 })
  @IsString()
  @MaxLength(64)
  source!: string;
}

/**
 * DNC 预检（M2 步 11-1）：gain-saas 控制面在批次提交/发送前调用；引擎发送路径在 11-2
 * 会再次调用同一服务（defense-in-depth）。只返回哈希与命中原因，不回传明文。
 * 11-4 增加 suppress：退订/投诉/退信经控制面写入平台级抑制（幂等）。
 */
@ApiTags('Outreach')
@ApiBearerAuth()
@Controller('outreach/dnc')
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('compliance:manage')
export class OutreachDncController {
  constructor(private readonly dnc: OutreachDncService) {}

  @Post('check')
  @HttpCode(200)
  @ApiOperation({
    summary: '检查邮箱是否被租户禁联名单或平台全局抑制命中',
    description:
      '任一命中即 suppressed=true；调用方必须 fail closed。返回规范化邮箱的 SHA-256 与命中来源，不回传明文。',
  })
  @ApiEnvelope({
    type: 'object',
    required: ['results'],
    properties: { results: { type: 'array', items: { type: 'object', additionalProperties: true } } },
  })
  async check(@Ctx() ctx: RequestContext, @Body() dto: CheckOutreachDncDto) {
    const results = await this.dnc.check(ctx.workspaceId, dto.emails);
    return envelope({ results });
  }

  @Post('suppress')
  @HttpCode(200)
  @ApiOperation({
    summary: '写入平台级外联抑制（退订/投诉/退信）',
    description:
      '规范化邮箱后只存 SHA-256；同一邮箱重复写入幂等。调用方必须已确认退订/投诉事实。',
  })
  @ApiEnvelope({
    type: 'object',
    required: ['suppressed'],
    properties: { suppressed: { type: 'boolean' } },
  })
  async suppress(@Body() dto: SuppressOutreachDncDto) {
    await this.dnc.suppressGlobal(dto);
    return envelope({ suppressed: true });
  }
}
