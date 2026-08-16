import { Module } from '@nestjs/common';
import { ProviderControlPlaneController } from './provider-control-plane.controller';
import { ProviderControlPlaneService } from './provider-control-plane.service';

@Module({
  controllers: [ProviderControlPlaneController],
  providers: [ProviderControlPlaneService],
})
export class ProviderControlPlaneModule {}
