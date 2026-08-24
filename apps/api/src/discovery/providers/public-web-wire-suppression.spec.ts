import { describe, expect, it, vi } from 'vitest';

vi.mock('../../adapters/robots', () => ({
  isAllowedByRobots: vi.fn(async () => true),
}));

import { PublicWebDiscoveryProvider } from './public-web.provider';
import { ToolBroker } from '../../tools/tool-broker';
import { ToolRegistry } from '../../tools/tool-registry';
import { InMemoryBudgetStoreAdapter } from '@global/test-support';
import { RateLimiter } from '../../tools/rate-limiter';
import type { Tool } from '../../tools/tool-contract';

describe('PublicWebDiscoveryProvider — per-wire suppression propagation', () => {
  it('keeps pre-identity artifact crawling held before either suppression callback or wire', async () => {
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
      durableResultStrategy: {
        kind: 'artifact_reference',
        schema: 'crawl4ai-fetch/v1',
        maxBytes: 1_000,
        mediaTypes: ['text/markdown'],
        privacyClass: 'PERSONAL_DATA',
        ttlSeconds: 86_400,
      },
      healthCheck: async () => ({ healthy: true }),
      execute,
    } as Tool;
    const registry = new ToolRegistry();
    registry.register(tool);
    const broker = new ToolBroker({
      registry,
      budgetStore: new InMemoryBudgetStoreAdapter() as never,
      limiter: new RateLimiter(),
    });
    const authorizeExternalAction = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const provider = new PublicWebDiscoveryProvider({
      gateway: {} as never,
      broker,
    });

    await expect(provider.discoverContacts(
      { name: 'Example GmbH', domain: 'example.com' },
      {
        workspaceId: 'workspace-1',
        authorizeExternalAction,
      },
    )).rejects.toMatchObject({
      reason: 'GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD',
    });

    expect(authorizeExternalAction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
