import { Module } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryProviderRegistry } from './provider.registry';

@Module({
  controllers: [DiscoveryController],
  providers: [DiscoveryService, { provide: DiscoveryProviderRegistry, useValue: new DiscoveryProviderRegistry() }],
  exports: [DiscoveryProviderRegistry],
})
export class DiscoveryModule {}
