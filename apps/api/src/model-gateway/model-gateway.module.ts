import { Global, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ModelGateway } from './model-gateway';
import { RouterModelGateway } from './router-model-gateway';
import { ModelRouter } from './model-router';
import { ModelProviderRegistry } from './model-provider.registry';
import { buildGatewayProvider } from './model-providers.config';
import { AiTraceSink } from './ai-trace.sink';
import { PrismaService } from '../prisma/prisma.service';
import { PostgresBudgetStore, TOOL_BUDGET_STORE } from '../tools/budget-store';

/**
 * Exposes the single ModelGateway. All vendors live behind the 中转站 (new-api);
 * missing gateway configuration leaves the product capability unavailable.
 * Test providers are injected only by test composition roots.
 */
@Global()
@Module({
  providers: [
    ModelProviderRegistry,
    ModelRouter,
    AiTraceSink,
    {
      provide: TOOL_BUDGET_STORE,
      useFactory: (prisma: PrismaService) => new PostgresBudgetStore(prisma),
      inject: [PrismaService],
    },
    { provide: ModelGateway, useClass: RouterModelGateway },
  ],
  exports: [ModelGateway],
})
export class ModelGatewayModule implements OnModuleInit {
  private readonly logger = new Logger('ModelGateway');

  constructor(private readonly registry: ModelProviderRegistry) {}

  onModuleInit(): void {
    const gateway = buildGatewayProvider();
    if (gateway) {
      this.registry.register(gateway);
      this.logger.log('registered model gateway (中转站)');
    } else {
      this.logger.warn(
        'MODEL_GATEWAY_URL/KEY 未配置 — 模型能力不可用',
      );
    }
  }
}
