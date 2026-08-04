import { Global, Module } from '@nestjs/common';
import { LangfuseRuntimeTelemetryService } from './langfuse-runtime-telemetry.service';

@Global()
@Module({
  providers: [LangfuseRuntimeTelemetryService],
  exports: [LangfuseRuntimeTelemetryService],
})
export class ModelRuntimeModule {}
