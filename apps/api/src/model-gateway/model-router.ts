import { Injectable } from '@nestjs/common';
import { ModelProviderRegistry } from './model-provider.registry';
import { ModelProvider } from './model-provider';
import { ModelOp } from './types';

/**
 * Provider registration order is the explicit routing order. Vendor-level
 * routing/fallback (which model, which vendor) lives IN the 中转站;
 * per-task model selection is carried on the request.
 */
@Injectable()
export class ModelRouter {
  constructor(private readonly registry: ModelProviderRegistry) {}

  route(op: ModelOp, task: string): ModelProvider[] {
    return this.registry.all().filter((p) => p.supports(op, task));
  }
}
