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
      // 邮箱验证 SMTP 出网经 ToolBroker 闸门；source_policy 读平台级治理表（无 RLS，直读）。
      useFactory: (gateway: ModelGateway, prisma: PrismaService) =>
        new DiscoveryProviderRegistry({
          gateway,
          broker: buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) }),
        }),
      inject: [ModelGateway, PrismaService],
    },
  ],
  exports: [DiscoveryProviderRegistry],
})
export class DiscoveryModule {}
