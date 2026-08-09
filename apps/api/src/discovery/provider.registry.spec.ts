import { describe, expect, it } from 'vitest';

import type { ModelGateway } from '../model-gateway/model-gateway';
import { DiscoveryProviderRegistry } from './provider.registry';

describe('DiscoveryProviderRegistry SourceClass governance', () => {
  it('binds both structured/sandbox and gateway-backed adapters to the manifest', () => {
    expect(() => new DiscoveryProviderRegistry()).not.toThrow();
    expect(
      () =>
        new DiscoveryProviderRegistry({
          gateway: {} as ModelGateway,
        }),
    ).not.toThrow();
  });
});
