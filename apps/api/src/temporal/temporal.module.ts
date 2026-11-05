import { Global, Module } from '@nestjs/common';
import { PlatformTemporalClient } from './platform-temporal.client';
import { TemporalClient } from './temporal.client';

@Global()
@Module({
  providers: [TemporalClient, PlatformTemporalClient],
  exports: [TemporalClient, PlatformTemporalClient],
})
export class TemporalModule {}
