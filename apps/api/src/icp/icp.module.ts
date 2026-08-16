import { Module } from '@nestjs/common';
import { IcpController } from './icp.controller';
import { IcpService } from './icp.service';
import { AdaptiveQueryPlanController } from './adaptive-query-plan.controller';
import { AdaptiveQueryPlanService } from './adaptive-query-plan.service';

@Module({
  controllers: [IcpController, AdaptiveQueryPlanController],
  providers: [IcpService, AdaptiveQueryPlanService],
})
export class IcpModule {}
