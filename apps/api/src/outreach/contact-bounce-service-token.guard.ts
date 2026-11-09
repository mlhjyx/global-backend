import { Injectable } from '@nestjs/common';
import { OutreachDncServiceTokenGuard } from './outreach-dnc-service-token.guard';

/** bounce/complaint 回写的服务令牌门（与 DNC 同一 env/header 与恒定时间比较）。 */
@Injectable()
export class ContactBounceServiceTokenGuard extends OutreachDncServiceTokenGuard {
  protected override readonly unavailableCode: string = 'OUTREACH_BOUNCE_NOT_CONFIGURED';
  protected override readonly unavailableMessage: string =
    '投递回写端点未配置服务令牌，拒绝写入';
  protected override readonly forbiddenCode: string = 'OUTREACH_BOUNCE_FORBIDDEN';
  protected override readonly forbiddenMessage: string = '投递回写只接受控制面服务令牌';
}
