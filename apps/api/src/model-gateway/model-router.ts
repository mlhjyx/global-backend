import { Injectable } from '@nestjs/common';
import { ModelProviderRegistry } from './model-provider.registry';
import { ModelProvider } from './model-provider';
import { ModelOp } from './types';

/**
 * Provider order for a (op, task): the real gateway (中转站) first, the stub last
 * as a dev fallback. Vendor-level routing/fallback (which model, which vendor)
 * lives IN the 中转站; per-task model *selection* is carried on the request
 * (input.model, from the AI Task Contract).
 */
@Injectable()
export class ModelRouter {
  constructor(private readonly registry: ModelProviderRegistry) {}

  route(op: ModelOp, task: string): ModelProvider[] {
    return this.registry
      .all()
      .filter((p) => p.supports(op, task))
      .sort((a, b) => Number(a.id === 'stub') - Number(b.id === 'stub'));
  }
}
