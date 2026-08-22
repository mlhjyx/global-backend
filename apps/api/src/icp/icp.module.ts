import { Module } from '@nestjs/common';
import { IcpController } from './icp.controller';
import { IcpService } from './icp.service';
import { ExecutionBudgetModule } from '../execution-budget/execution-budget.module';

@Module({
  imports: [ExecutionBudgetModule],
  controllers: [IcpController],
  providers: [IcpService],
})
export class IcpModule {}
