import { Module } from '@nestjs/common';
import { IcpController } from './icp.controller';
import { IcpService } from './icp.service';
import { ExecutionBudgetModule } from '../execution-budget/execution-budget.module';
import { DiscoveryModule } from '../discovery/discovery.module';

@Module({
  // DiscoveryModule exports the provider registry: the query planner only plans
  // for discovery sources that are ENABLED (BI-30).
  imports: [ExecutionBudgetModule, DiscoveryModule],
  controllers: [IcpController],
  providers: [IcpService],
})
export class IcpModule {}
