import { Global, Module, OnModuleInit } from '@nestjs/common';
import { ModelGateway } from './model-gateway';
import { RouterModelGateway } from './router-model-gateway';
import { ModelRouter } from './model-router';
import { ModelProviderRegistry } from './model-provider.registry';
import { StubModelProvider } from './providers/stub-model.provider';

/**
 * Exposes the single ModelGateway and bootstraps the provider fleet.
 * Register real providers (Anthropic / OpenAI / LiteLLM) in onModuleInit once
 * their keys/config exist — nothing else changes.
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
  constructor(
    private readonly registry: ModelProviderRegistry,
    private readonly stub: StubModelProvider,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.stub);
    // TODO: register AnthropicProvider / LiteLLMProvider here when keys are configured.
  }
}
