import { describe, expect, it, vi } from 'vitest';

vi.mock('../../adapters/robots', () => ({
  isAllowedByRobots: vi.fn(async () => true),
}));

import { PublicWebDiscoveryProvider } from './public-web.provider';
import { ToolBroker } from '../../tools/tool-broker';
import { ToolRegistry } from '../../tools/tool-registry';
import { BudgetLedger } from '../../tools/budget';
import { RateLimiter } from '../../tools/rate-limiter';
import type { Tool } from '../../tools/tool-contract';

describe('PublicWebDiscoveryProvider — per-wire suppression propagation', () => {
  it('stops the second crawl when suppression is committed after the first wire', async () => {
    const execute = vi.fn(async () => ({
      data: {
        url: 'https://example.com/',
        text: '[Contact](/contact)',
        contentHash: 'hash',
      },
      costCents: 0,
    }));
    const tool = {
      id: 'crawl4ai.fetch',
      version: '1.0.0',
      category: 'fetch',
      sourceClass: 'public_intelligence',
      cost: { unit: 'page', estimatedCents: 0, external: false },
      rateLimit: { rps: 100, concurrency: 10 },
      compliance: {
        sourcePolicy: 'none',
        respectsRobots: true,
        personalData: false,
        allowedPurpose: ['discovery', 'enrichment'],
        reversible: true,
        authRequired: false,
        risk: 'low',
      },
      capabilities: { produces: ['contact'], accepts: ['domain'] },
      idempotencyKey: ({ url }: { url: string }) => url,
      healthCheck: async () => ({ healthy: true }),
      execute,
    } as Tool;
    const registry = new ToolRegistry();
    registry.register(tool);
    const broker = new ToolBroker({
      registry,
      budget: new BudgetLedger(),
      limiter: new RateLimiter(),
      providerStatusReader: async () => ({ status: 'ENABLED' }),
    });
    const authorizeExternalAction = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const provider = new PublicWebDiscoveryProvider({
      gateway: {} as never,
      broker,
    });

    await provider.discoverContacts(
      { name: 'Example GmbH', domain: 'example.com' },
      {
        workspaceId: 'workspace-1',
        authorizeExternalAction,
      },
    );

    expect(authorizeExternalAction).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('binds shared crawl calls to public_web and blocks the next wire after provider disablement', async () => {
    const wires = vi.fn();
    const tool = {
      id: 'crawl4ai.fetch',
      version: '1.0.0',
      category: 'fetch',
      sourceClass: 'public_intelligence',
      cost: { unit: 'page', estimatedCents: 0, external: false },
      rateLimit: { rps: 100, concurrency: 10 },
      compliance: {
        sourcePolicy: 'none',
        respectsRobots: true,
        personalData: false,
        allowedPurpose: ['discovery', 'enrichment'],
        reversible: true,
        authRequired: false,
        risk: 'low',
      },
      capabilities: { produces: ['contact'], accepts: ['domain'] },
      idempotencyKey: ({ url }: { url: string }) => url,
      healthCheck: async () => ({ healthy: true }),
      execute: async (_input: unknown, ctx: { reauthorizeProviderStatus?: () => Promise<void> }) => {
        await ctx.reauthorizeProviderStatus?.();
        wires();
        return {
          data: { url: 'https://example.com/', text: '[Contact](/contact)', contentHash: 'hash' },
          costCents: 0,
        };
      },
    } as Tool;
    const registry = new ToolRegistry();
    registry.register(tool);
    const providerStatusReader = vi
      .fn<() => Promise<{ status: string } | null>>()
      .mockResolvedValueOnce({ status: 'ENABLED' })
      .mockResolvedValueOnce({ status: 'ENABLED' })
      .mockResolvedValueOnce({ status: 'DISABLED' });
    const broker = new ToolBroker({
      registry,
      budget: new BudgetLedger(),
      limiter: new RateLimiter(),
      providerStatusReader,
    });
    const provider = new PublicWebDiscoveryProvider({ gateway: {} as never, broker });

    await provider.discoverContacts(
      { name: 'Example GmbH', domain: 'example.com' },
      { workspaceId: 'workspace-1' },
    );

    expect(providerStatusReader).toHaveBeenCalledTimes(3);
    expect(wires).toHaveBeenCalledOnce();
  });
});
