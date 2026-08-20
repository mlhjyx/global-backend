import { describe, expect, it } from 'vitest';
import { ModelProviderRegistry } from './model-provider.registry';
import type { ModelProvider } from './model-provider';
import { ModelRouter } from './model-router';

function provider(id: string): ModelProvider {
  return {
    id,
    supports: () => true,
  } as ModelProvider;
}

describe('ModelRouter', () => {
  it('treats provider ids as opaque and preserves explicit registration order', () => {
    const registry = new ModelProviderRegistry();
    registry.register(provider('stub'));
    registry.register(provider('gateway'));

    const routed = new ModelRouter(registry).route(
      'generateStructured',
      'taxonomy.normalize',
    );

    expect(routed.map((candidate) => candidate.id)).toEqual([
      'stub',
      'gateway',
    ]);
  });
});
