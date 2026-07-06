import { Module } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryProviderRegistry } from './provider.registry';
import { ModelGateway } from '../model-gateway/model-gateway';

@Module({
  controllers: [DiscoveryController],
  providers: [
    DiscoveryService,
    {
      provide: DiscoveryProviderRegistry,
      // API 侧的联系人发现/邮箱验证走真实 public_web —— 注入全局 ModelGateway。
      useFactory: (gateway: ModelGateway) => new DiscoveryProviderRegistry({ gateway }),
      inject: [ModelGateway],
    },
  ],
  exports: [DiscoveryProviderRegistry],
})
export class DiscoveryModule {}
