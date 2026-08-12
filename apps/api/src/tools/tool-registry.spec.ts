import { describe, expect, it, vi } from 'vitest';
import type { Tool } from './tool-contract';
import { ToolRegistry } from './tool-registry';

function tool(
  id: string,
  input: { healthy?: boolean; throws?: boolean; cents?: number; risk?: 'low' | 'medium' | 'high' } = {},
): Tool {
  return {
    id,
    version: '1',
    category: 'search',
    sourceClass: 'public_intelligence',
    cost: { unit: 'request', estimatedCents: input.cents ?? 0, external: false },
    rateLimit: { rps: 1, concurrency: 1 },
    compliance: {
      sourcePolicy: 'none',
      respectsRobots: false,
      personalData: false,
      allowedPurpose: ['discovery'],
      reversible: true,
      authRequired: false,
      risk: input.risk ?? 'low',
    },
    capabilities: { produces: ['domain'], accepts: ['keywords'] },
    idempotencyKey: () => id,
    healthCheck: vi.fn(async () => {
      if (input.throws) throw new Error('health unavailable');
      return { healthy: input.healthy ?? true };
    }),
    execute: vi.fn(async () => ({ data: {}, costCents: 0 })),
  } as Tool;
}

describe('ToolRegistry deterministic routing', () => {
  it('rejects duplicates and incomplete contracts', () => {
    const registry = new ToolRegistry();
    registry.register(tool('one'));
    expect(() => registry.register(tool('one'))).toThrow('already registered');
    expect(() => registry.register({ id: 'bad' } as Tool)).toThrow('missing version');
  });

  it('filters on every query dimension and sorts by price then risk', async () => {
    const registry = new ToolRegistry();
    registry.register(tool('high-risk', { cents: 1, risk: 'high' }));
    registry.register(tool('low-risk', { cents: 1, risk: 'low' }));
    registry.register(tool('expensive', { cents: 3 }));

    expect(
      (await registry.resolve({
        category: 'search',
        sourceClass: 'public_intelligence',
        produces: 'domain',
        maxUnitCents: 1,
      })).map(({ id }) => id),
    ).toEqual(['low-risk', 'high-risk']);
    await expect(registry.resolve({ category: 'verify' })).resolves.toEqual([]);
    await expect(registry.resolve({ sourceClass: 'company_registry' })).resolves.toEqual([]);
    await expect(registry.resolve({ produces: 'company' })).resolves.toEqual([]);
  });

  it('uses healthy candidates, falls back when all fail, and caches health', async () => {
    const registry = new ToolRegistry();
    const healthy = tool('healthy');
    const unhealthy = tool('unhealthy', { healthy: false });
    const throwing = tool('throwing', { throws: true });
    registry.register(unhealthy);
    registry.register(healthy);
    expect((await registry.resolve({})).map(({ id }) => id)).toEqual(['healthy']);
    await registry.resolve({});
    expect(healthy.healthCheck).toHaveBeenCalledTimes(1);

    const fallback = new ToolRegistry();
    fallback.register(unhealthy);
    fallback.register(throwing);
    expect((await fallback.resolve({})).map(({ id }) => id).sort()).toEqual([
      'throwing',
      'unhealthy',
    ]);
  });

  it('exposes registered tools by id and as an immutable snapshot array', () => {
    const registry = new ToolRegistry();
    const one = tool('one');
    registry.register(one);
    const snapshot = registry.all();
    snapshot.pop();
    expect(registry.get('one')).toBe(one);
    expect(registry.get('missing')).toBeUndefined();
    expect(registry.all()).toHaveLength(1);
  });
});

