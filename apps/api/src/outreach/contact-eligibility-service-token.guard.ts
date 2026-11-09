import { Injectable } from '@nestjs/common';
import { OutreachDncServiceTokenGuard } from './outreach-dnc-service-token.guard';

/**
 * contact-eligibility 的服务令牌门（复用 DNC 的同一 env/header 与恒定时间比较），
 * 错误码换成本端点语境（配置缺失 503 / 令牌不符 403）。
 */
@Injectable()
export class ContactEligibilityServiceTokenGuard extends OutreachDncServiceTokenGuard {
  protected override readonly unavailableCode = 'OUTREACH_ELIGIBILITY_NOT_CONFIGURED';
  protected override readonly unavailableMessage = '联系人可触达性查询未配置服务令牌，拒绝调用';
  protected override readonly forbiddenCode = 'OUTREACH_ELIGIBILITY_FORBIDDEN';
  protected override readonly forbiddenMessage = '联系人可触达性查询只接受控制面服务令牌';
}
