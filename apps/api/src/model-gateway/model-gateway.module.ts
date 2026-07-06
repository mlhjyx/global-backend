import { Global, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ModelGateway } from './model-gateway';
import { RouterModelGateway } from './router-model-gateway';
import { ModelRouter } from './model-router';
import { ModelProviderRegistry } from './model-provider.registry';
import { StubModelProvider } from './providers/stub-model.provider';
import { buildGatewayProvider } from './model-providers.config';

/**
 * Exposes the single ModelGateway and bootstraps the provider fleet: every vendor
 * with a configured key (DeepSeek/OpenAI/Gemini/Volcengine) plus the stub as a
 * last-resort fallback. Add a key → that model goes live; no other code changes.
 */
@Global()
@Module({
  providers: [
    ModelProviderRegistry,
    ModelRouter,
    StubModelProvider,
    { provide: ModelGateway, useClass: RouterModelGateway },
  ],
  exports: [ModelGateway],
})
export class ModelGatewayModule implements OnModuleInit {
  private readonly logger = new Logger('ModelGateway');

  constructor(
    private readonly registry: ModelProviderRegistry,
    private readonly stub: StubModelProvider,
  ) {}

  onModuleInit(): void {
    const gateway = buildGatewayProvider();
    if (gateway) {
      this.registry.register(gateway);
      this.logger.log('registered model gateway (中转站)');
    } else {
      this.logger.warn('MODEL_GATEWAY_URL/KEY 未配置 — 暂用 stub（去 new-api 建令牌后填入）');
    }
    this.registry.register(this.stub);
  }
}
