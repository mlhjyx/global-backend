import { BadRequestException, Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { envelope } from '../common/envelope';
import { ContactBounceServiceTokenGuard } from './contact-bounce-service-token.guard';
import {
  CONTACT_BOUNCE_EVENTS,
  ContactBounceService,
  type ContactBounceEvent,
} from './contact-bounce.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class RecordContactBounceDto {
  @ApiProperty({
    format: 'uuid',
    description: '该投递所属的 workspace（服务令牌端点：租户由控制面显式给出）',
  })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({ enum: CONTACT_BOUNCE_EVENTS, description: 'SMTP transport 回调的投递事件' })
  @IsIn(CONTACT_BOUNCE_EVENTS)
  event!: ContactBounceEvent;

  @ApiProperty({ description: 'SMTP 消息 ID（幂等键）', maxLength: 256 })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  messageId!: string;

  @ApiPropertyOptional({ description: 'SMTP 响应码（如 550）', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  smtpCode?: string;

  @ApiPropertyOptional({ description: '事件发生时间（ISO 8601）' })
  @IsOptional()
  @IsString()
  receivedAt?: string;
}

/**
 * 投递回写（P1-13 引擎侧，ch02 §2.3.6.6）：gain-saas 的 SMTP transport 在发送结果回调里
 * 经服务令牌调用本端点——hard_bounce→INVALID+抑制、soft×3→UNKNOWN+24h 重验、
 * complaint→状态不变+confidence 0+LEGAL 抑制。messageId 幂等。
 */
@ApiTags('Outreach')
@Controller('contact-points/:pointId/bounce-events')
export class ContactBounceController {
  constructor(private readonly bounce: ContactBounceService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(ContactBounceServiceTokenGuard)
  @ApiHeader({
    name: 'x-service-token',
    required: true,
    description: 'gain-saas 控制面服务令牌（env OUTREACH_INTERNAL_SERVICE_TOKEN；与 DNC 抑制同源）',
  })
  @ApiOperation({
    summary: '回写一条投递结果（hard/soft bounce、complaint；messageId 幂等）',
    description:
      '服务间端点（gain-saas SMTP transport，x-service-token）：hard_bounce → 点置 INVALID 并写 suppression(email, bounce, ' +
      'PREFERENCE)；soft_bounce 同一地址累计第 3 次 → UNKNOWN 且 24h 后重验；complaint → 状态不变、confidence 归 0、' +
      '证据 allowedActions 去 outreach、写 suppression(email, complaint, LEGAL)。每次回写落一行验证事件账（provider=smtp_transport）' +
      '与 email.delivery 证据（无 PII）。messageId 复用返回 duplicate 且无副作用。非 email 点 409，点不存在/跨租户 404。',
  })
  @ApiEnvelope({
    type: 'object',
    required: ['status', 'action', 'duplicate'],
    properties: {
      status: { type: 'string' },
      action: { type: 'string' },
      duplicate: { type: 'boolean' },
    },
  })
  async record(@Param('pointId') pointId: string, @Body() dto: RecordContactBounceDto) {
    if (!UUID.test(pointId)) {
      throw new BadRequestException({
        error: { code: 'OUTREACH_BOUNCE_INVALID_POINT_ID', message: 'pointId must be a uuid' },
      });
    }
    const outcome = await this.bounce.record(dto.workspaceId, pointId, dto);
    return envelope({ status: 'recorded', ...outcome });
  }
}
