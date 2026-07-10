import { Module } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryProviderRegistry } from './provider.registry';
import { ModelGateway } from '../model-gateway/model-gateway';
import { PrismaService } from '../prisma/prisma.service';
import { buildToolBroker, sourcePolicyReaderFrom } from '../tools/tool-broker.factory';

@Module({
  controllers: [DiscoveryController],
  providers: [
    DiscoveryService,
    {
      provide: DiscoveryProviderRegistry,
      // API 侧的联系人发现/邮箱验证走真实 public_web —— 注入全局 ModelGateway。
      // 收口②：全部 provider 原始出网统一经 ToolBroker（source_policy fail-closed + 预算 + 限流 + Trace）。
      useFactory: (gateway: ModelGateway, prisma: PrismaService) => {
        const sourcePolicyReader = sourcePolicyReaderFrom(prisma);
        return new DiscoveryProviderRegistry({
          gateway,
          broker: buildToolBroker({ sourcePolicyReader }),
        });
      },
      inject: [ModelGateway, PrismaService],
    },
  ],
  exports: [DiscoveryProviderRegistry],
})
export class DiscoveryModule {}
