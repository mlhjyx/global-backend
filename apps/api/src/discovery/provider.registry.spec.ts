import { describe, expect, it } from 'vitest';

import type { ModelGateway } from '../model-gateway/model-gateway';
import { DiscoveryProviderRegistry } from './provider.registry';

describe('DiscoveryProviderRegistry SourceClass governance', () => {
  it('binds structured and gateway-backed product adapters to the manifest', () => {
    expect(() => new DiscoveryProviderRegistry()).not.toThrow();
    expect(
      () =>
        new DiscoveryProviderRegistry({
          gateway: {} as ModelGateway,
        }),
    ).not.toThrow();
  });

  it('never registers a synthetic sandbox adapter when the gateway is absent or an old opt-in is set', async () => {
    const previous = process.env.DISCOVERY_ALLOW_SANDBOX;
    process.env.DISCOVERY_ALLOW_SANDBOX = 'true';
    try {
      const registry = new DiscoveryProviderRegistry();
      const db = {
        dataProvider: {
          findMany: async () => [{ key: 'sandbox' }],
        },
      };
      const routed = await Promise.all([
        registry.routeCompanyDiscovery(db as never, 'public_intelligence'),
        registry.routeContactDiscovery(db as never),
        registry.routeEmailVerification(db as never),
      ]);
      expect(routed.flat().map((adapter) => adapter.key)).not.toContain('sandbox');
    } finally {
      if (previous === undefined) delete process.env.DISCOVERY_ALLOW_SANDBOX;
      else process.env.DISCOVERY_ALLOW_SANDBOX = previous;
    }
  });

  it('never seeds a sandbox provider into the product control plane', async () => {
    const previous = process.env.DISCOVERY_ALLOW_SANDBOX;
    process.env.DISCOVERY_ALLOW_SANDBOX = 'true';
    try {
      const upsert = async (args: unknown) => {
        calls.push(args);
        return args;
      };
      const calls: unknown[] = [];
      await new DiscoveryProviderRegistry().seed({
        dataProvider: { upsert },
      } as never);
      expect(
        calls.some((entry) =>
          JSON.stringify(entry).includes('"key":"sandbox"'),
        ),
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DISCOVERY_ALLOW_SANDBOX;
      else process.env.DISCOVERY_ALLOW_SANDBOX = previous;
    }
  });
});
