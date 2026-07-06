import { Injectable } from '@nestjs/common';
import { ModelProviderRegistry } from './model-provider.registry';
import { ModelProvider } from './model-provider';
import { ModelOp } from './types';

/**
 * Decides the ordered provider chain for a (op, task). Today: capability filter +
 * keep the stub last as a fallback. Later: policy/cost/region/latency/health-based
 * routing per PRD 9.12 — the ModelGateway interface stays the same.
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
