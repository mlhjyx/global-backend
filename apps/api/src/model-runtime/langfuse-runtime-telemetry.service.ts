import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { RuntimeTelemetry, RuntimeTelemetryEvent } from './types';
import {
  startLangfuseRuntimeTelemetry,
  type LangfuseTelemetryLifecycle,
} from './langfuse-runtime-telemetry';

const NOOP_LIFECYCLE: LangfuseTelemetryLifecycle = Object.freeze({
  telemetry: Object.freeze({ emit: () => undefined }),
  shutdown: async () => undefined,
});

@Injectable()
export class LangfuseRuntimeTelemetryService
  implements RuntimeTelemetry, OnModuleInit, OnModuleDestroy
{
  private lifecycle: LangfuseTelemetryLifecycle = NOOP_LIFECYCLE;

  async onModuleInit(): Promise<void> {
    this.lifecycle = await startLangfuseRuntimeTelemetry();
  }

  emit(event: RuntimeTelemetryEvent): void | Promise<void> {
    return this.lifecycle.telemetry.emit(event);
  }

  async onModuleDestroy(): Promise<void> {
    await this.lifecycle.shutdown();
    this.lifecycle = NOOP_LIFECYCLE;
  }
}
