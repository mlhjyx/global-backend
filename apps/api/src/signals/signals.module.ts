import { Module } from '@nestjs/common';
import { CompanySignalsController } from './company-signals.controller';
import { CompanySignalsService } from './company-signals.service';

/** P1-18 读侧：公司触发信号只读 API（PrismaService 来自全局 PrismaModule）。 */
@Module({
  controllers: [CompanySignalsController],
  providers: [CompanySignalsService],
})
export class SignalsModule {}
