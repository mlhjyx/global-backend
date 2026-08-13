import { describe, expect, it, vi } from 'vitest';
import type { ModelProvider } from './model-provider';
import { ModelProviderRegistry } from './model-provider.registry';
import { ModelRouter } from './model-router';

const provider = (id: string, supported: boolean): ModelProvider =>
  ({ id, supports: vi.fn(() => supported) }) as unknown as ModelProvider;

describe('ModelProviderRegistry and ModelRouter', () => {
  it('registers by stable provider identity and replaces duplicates immutably at readout', () => {
    const registry = new ModelProviderRegistry();
    const first = provider('gateway', true);
    const replacement = provider('gateway', false);
    registry.register(first);
    registry.register(replacement);
    expect(registry.get('gateway')).toBe(replacement);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.all()).toEqual([replacement]);
  });

  it('filters unsupported providers and always orders the dev stub last', () => {
    const registry = new ModelProviderRegistry();
    const stub = provider('stub', true);
    const unsupported = provider('offline', false);
    const gateway = provider('gateway', true);
    registry.register(stub);
    registry.register(unsupported);
    registry.register(gateway);

    const result = new ModelRouter(registry).route('generateStructured', 'site_builder.copy');
    expect(result).toEqual([gateway, stub]);
    expect(unsupported.supports).toHaveBeenCalledWith('generateStructured', 'site_builder.copy');
  });
});
