import { Module } from '@nestjs/common';
import { OutreachDncServiceTokenGuard } from './outreach-dnc-service-token.guard';
import { OutreachDncController } from './outreach-dnc.controller';
import { OutreachDncService } from './outreach-dnc.service';
import { ContactEligibilityServiceTokenGuard } from './contact-eligibility-service-token.guard';
import { ContactEligibilityController } from './contact-eligibility.controller';
import { ContactEligibilityService } from './contact-eligibility.service';

/** M2 步 11 受控邮件触达：DNC + 全局抑制 + P1-16 联系人可触达性查询。 */
@Module({
  controllers: [OutreachDncController, ContactEligibilityController],
  providers: [
    OutreachDncService,
    OutreachDncServiceTokenGuard,
    ContactEligibilityService,
    ContactEligibilityServiceTokenGuard,
  ],
  exports: [OutreachDncService, ContactEligibilityService],
})
export class OutreachModule {}
