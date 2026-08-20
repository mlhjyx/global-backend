import { Module } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryProviderRegistry } from './provider.registry';
import { ModelGateway } from '../model-gateway/model-gateway';
import { PrismaService } from '../prisma/prisma.service';
import { buildToolBroker, sourcePolicyReaderFrom } from '../tools/tool-broker.factory';
import { LangfuseRuntimeTelemetryService } from '../model-runtime';
import { PostgresBudgetStore, TOOL_BUDGET_STORE, type BudgetStore } from '../tools/budget-store';

@Module({
  controllers: [DiscoveryController],
  providers: [
    {
      provide: TOOL_BUDGET_STORE,
      useFactory: (prisma: PrismaService) => new PostgresBudgetStore(prisma),
      inject: [PrismaService],
    },
    DiscoveryService,
    {
      provide: DiscoveryProviderRegistry,
      // API 侧的联系人发现/邮箱验证走真实 public_web —— 注入全局 ModelGateway。
      // 收口②：全部 provider 原始出网统一经 ToolBroker（source_policy fail-closed + 预算 + 限流 + Trace）。
      useFactory: (
        gateway: ModelGateway,
        prisma: PrismaService,
        runtimeTelemetry: LangfuseRuntimeTelemetryService,
        budgetStore: BudgetStore,
      ) => {
        const sourcePolicyReader = sourcePolicyReaderFrom(prisma);
        return new DiscoveryProviderRegistry({
          gateway,
          broker: buildToolBroker({ sourcePolicyReader, prisma, budgetStore }),
          prisma, // 专利缓存读/enqueue 闭包（app_user，平台表无 RLS）
          runtimeTelemetry,
        });
      },
      inject: [ModelGateway, PrismaService, LangfuseRuntimeTelemetryService, TOOL_BUDGET_STORE],
    },
  ],
  exports: [DiscoveryProviderRegistry],
})
export class DiscoveryModule {}
