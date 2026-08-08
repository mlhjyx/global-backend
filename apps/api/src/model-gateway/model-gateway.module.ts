import { Global, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ModelGateway } from './model-gateway';
import { RouterModelGateway } from './router-model-gateway';
import { ModelRouter } from './model-router';
import { ModelProviderRegistry } from './model-provider.registry';
import { StubModelProvider } from './providers/stub-model.provider';
import { buildGatewayProvider, stubAllowed } from './model-providers.config';
import { AiTraceSink } from './ai-trace.sink';
import { RuntimeIdentityService } from '../runtime/runtime-admission';

/**
 * Exposes the single ModelGateway. All vendors live behind the 中转站 (new-api);
 * the stub is a DEV-ONLY fallback — production must fail loudly rather than
 * silently fabricate output (差距盘点：生产静默降级是 incorrect).
 */
@Global()
@Module({
  providers: [
    ModelProviderRegistry,
    ModelRouter,
    StubModelProvider,
    AiTraceSink,
    { provide: ModelGateway, useClass: RouterModelGateway },
  ],
  exports: [ModelGateway],
})
export class ModelGatewayModule implements OnModuleInit {
  private readonly logger = new Logger('ModelGateway');

  constructor(
    private readonly registry: ModelProviderRegistry,
    private readonly stub: StubModelProvider,
    private readonly runtimeIdentity: RuntimeIdentityService,
  ) {}

  onModuleInit(): void {
    const runtime = this.runtimeIdentity.getProcessSnapshot();
    const gateway = buildGatewayProvider(runtime.environment);
    if (gateway) {
      this.registry.register(gateway);
      this.logger.log('registered model gateway (中转站)');
    } else {
      this.logger.warn('MODEL_GATEWAY_URL/KEY 未配置 — 暂用 stub（去 new-api 建令牌后填入）');
    }
    if (stubAllowed(runtime)) {
      this.registry.register(this.stub);
    }
  }
}
