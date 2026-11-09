import { Module } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';
import { ContactEnrichmentService } from './enrich-contacts.service';
import { DiscoveryController } from './discovery.controller';
import { JudgmentReviewController } from './judgment/judgment-review.controller';
import { DiscoveryProviderRegistry } from './provider.registry';
import { ModelGateway } from '../model-gateway/model-gateway';
import { PrismaService } from '../prisma/prisma.service';
import { buildToolBroker, sourcePolicyReaderFrom } from '../tools/tool-broker.factory';
import { LangfuseRuntimeTelemetryService } from '../model-runtime';
import { PostgresBudgetStore, TOOL_BUDGET_STORE, type BudgetStore } from '../tools/budget-store';
import { TOOL_BROKER } from '../tools/tool-broker.tokens';
import type { ExecutionBroker } from '../tools/tool-contract';
import { ExecutionBudgetModule } from '../execution-budget/execution-budget.module';

@Module({
  imports: [ExecutionBudgetModule],
  controllers: [DiscoveryController, JudgmentReviewController],
  providers: [
    {
      provide: TOOL_BUDGET_STORE,
      useFactory: (prisma: PrismaService) => new PostgresBudgetStore(prisma),
      inject: [PrismaService],
    },
    {
      // 收口②：全部 provider 原始出网统一经 ToolBroker（source_policy fail-closed + 预算 + 限流 + Trace）。
      // 单实例供 discovery provider registry 与 SMTP 兜底票（验证瀑布第二票）共用。
      provide: TOOL_BROKER,
      useFactory: (prisma: PrismaService, budgetStore: BudgetStore) =>
        buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma), prisma, budgetStore }),
      inject: [PrismaService, TOOL_BUDGET_STORE],
    },
    DiscoveryService,
    ContactEnrichmentService,
    {
      provide: DiscoveryProviderRegistry,
      // API 侧的联系人发现/邮箱验证走真实 public_web —— 注入全局 ModelGateway。
      useFactory: (
        gateway: ModelGateway,
        prisma: PrismaService,
        runtimeTelemetry: LangfuseRuntimeTelemetryService,
        broker: ExecutionBroker,
      ) =>
        new DiscoveryProviderRegistry({
          gateway,
          broker,
          prisma, // 专利缓存读/enqueue 闭包（app_user，平台表无 RLS）
          runtimeTelemetry,
        }),
      inject: [ModelGateway, PrismaService, LangfuseRuntimeTelemetryService, TOOL_BROKER],
    },
  ],
  exports: [DiscoveryProviderRegistry],
})
export class DiscoveryModule {}
