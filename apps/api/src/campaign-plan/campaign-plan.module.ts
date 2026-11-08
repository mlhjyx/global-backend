import { Module } from '@nestjs/common';
import { ExecutionBudgetModule } from '../execution-budget/execution-budget.module';
import { TemporalModule } from '../temporal/temporal.module';
import { CampaignPlanInternalController } from './campaign-plan-internal.controller';
import { CampaignPlanLauncher } from './campaign-plan.launcher';
import { CampaignPlanServiceTokenGuard } from './campaign-plan-service-token.guard';

/**
 * M2.1 受限 Campaign 规划器的引擎内部入口（gain-saas 服务身份专用）。
 * 独立模块注册，不改 bff / 既有客户侧模块的依赖面。
 */
@Module({
  imports: [ExecutionBudgetModule, TemporalModule],
  controllers: [CampaignPlanInternalController],
  providers: [CampaignPlanServiceTokenGuard, CampaignPlanLauncher],
})
export class CampaignPlanModule {}
