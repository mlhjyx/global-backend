import { Global, Module } from '@nestjs/common';
import { TemporalClient } from './temporal.client';

@Global()
@Module({
  providers: [TemporalClient],
  exports: [TemporalClient],
})
export class TemporalModule {}
