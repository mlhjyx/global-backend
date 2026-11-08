import { Module } from '@nestjs/common';
import { OutreachDncServiceTokenGuard } from './outreach-dnc-service-token.guard';
import { OutreachDncController } from './outreach-dnc.controller';
import { OutreachDncService } from './outreach-dnc.service';

/** M2 步 11 受控邮件触达：11-1 只提供合规底座（DNC + 全局抑制）。 */
@Module({
  controllers: [OutreachDncController],
  providers: [OutreachDncService, OutreachDncServiceTokenGuard],
  exports: [OutreachDncService],
})
export class OutreachModule {}
