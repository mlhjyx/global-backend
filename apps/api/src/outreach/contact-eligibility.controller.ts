import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString, IsUUID } from 'class-validator';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { envelope } from '../common/envelope';
import { ContactEligibilityServiceTokenGuard } from './contact-eligibility-service-token.guard';
import {
  CONTACT_ELIGIBILITY_MAX_EMAILS,
  ContactEligibilityService,
} from './contact-eligibility.service';

class CheckContactEligibilityDto {
  @ApiProperty({
    format: 'uuid',
    description: '该批发送所属的 workspace（服务令牌端点：租户由控制面显式给出）',
  })
  @IsUUID()
  workspaceId!: string;

  @ApiProperty({
    type: [String],
    maxItems: CONTACT_ELIGIBILITY_MAX_EMAILS,
    description: '待检查的收件邮箱（≤50；引擎按规范化后的确定性密文等值匹配）',
  })
  @IsArray()
  @ArrayMaxSize(CONTACT_ELIGIBILITY_MAX_EMAILS)
  @IsString({ each: true })
  emails!: string[];
}

/**
 * 联系人可触达性查询（P1-16 引擎侧，ch02 §2.3.10.2）：gain-saas 发送门在批次提交前调用，
 * 拿这批邮箱在引擎里的四态与可触达动作。只返回 emailHash 与状态，不回传明文。
 * SaaS 侧接线（DNC 之前插入检查、引擎不可达 fail closed）由 gain-saas 实现，本端点只提供事实。
 */
@ApiTags('Outreach')
@ApiBearerAuth()
@Controller('outreach/contact-eligibility')
export class ContactEligibilityController {
  constructor(private readonly eligibility: ContactEligibilityService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(ContactEligibilityServiceTokenGuard)
  @ApiOperation({
    summary: '批量查询邮箱的四态与可触达动作（服务令牌）',
    description:
      '服务间端点（gain-saas 控制面，x-service-token）：按规范化邮箱的确定性密文匹配 contact_point，' +
      '返回 emailHash（sha256，与 DNC 端点同口径）、found、四态（VALID/INVALID/CATCH_ALL_RISKY/UNKNOWN）、' +
      'confidence 与 allowedActions；未找到按 UNKNOWN 处理（found=false，调用方必须 fail closed）。' +
      'CATCH_ALL_RISKY 的 catchAllPolicy 当前恒为 mode=OFF/allowed=false（灰度策略表属 P1-13，' +
      '策略不存在=一律拒发）。批量 ≤50；非法邮箱/超限返回 400，令牌未配置 503，令牌不符 403。' +
      '多租户不跨域匹配（RLS 强制）。',
  })
  @ApiEnvelope({
    type: 'object',
    required: ['results'],
    properties: {
      results: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
  })
  async check(@Body() dto: CheckContactEligibilityDto) {
    const results = await this.eligibility.check(dto.workspaceId, dto.emails);
    return envelope({ results });
  }
}
