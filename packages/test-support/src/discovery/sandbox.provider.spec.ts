import { describe, expect, it } from 'vitest';

import { SandboxDiscoveryProvider } from './sandbox.provider';

const context = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  traceId: 'sandbox-test',
  budget: { maxCostCents: 0 },
} as never;

describe('test-only SandboxDiscoveryProvider', () => {
  it('remains deterministic and explicitly synthetic for isolated tests', async () => {
    const provider = new SandboxDiscoveryProvider();
    const query = {
      sourceClass: 'public_intelligence' as const,
      filters: { country: ['DE'] },
      keywords: ['industrial'],
      limit: 2,
    };

    const first = await provider.discoverCompanies(query, context);
    const replay = await provider.discoverCompanies(query, context);

    expect(replay).toEqual(first);
    expect(first.records).toHaveLength(2);
    expect(first.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: expect.stringMatching(/\.sandbox\.example\.com$/),
          attributes: expect.objectContaining({ sandbox: true }),
        }),
      ]),
    );
  });
});
