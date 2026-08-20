import { describe, expect, it, vi } from 'vitest';
import { RuntimeReadinessContributorRegistry } from './runtime-readiness-registry';

describe('RuntimeReadinessContributorRegistry', () => {
  it('publishes one bounded readiness fact per named capability', async () => {
    const registry = new RuntimeReadinessContributorRegistry();
    registry.register('storage', () => ({ status: 'ok' }));

    await expect(registry.check('storage')).resolves.toEqual({ status: 'ok' });
  });

  it('fails closed for missing, throwing and malformed contributors', async () => {
    const registry = new RuntimeReadinessContributorRegistry();
    await expect(registry.check('storage')).resolves.toEqual({
      status: 'failed',
      code: 'READINESS_CONTRIBUTOR_MISSING',
    });

    registry.register('storage', () => {
      throw new Error('s3://access-key:secret@customer-bucket');
    });
    const result = await registry.check('storage');
    expect(result).toEqual({
      status: 'failed',
      code: 'READINESS_CONTRIBUTOR_FAILED',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects duplicate writers and supports exact-owner unregister', async () => {
    const registry = new RuntimeReadinessContributorRegistry();
    const first = vi.fn(() => ({ status: 'ok' as const }));
    const unregister = registry.register('storage', first);
    expect(() => registry.register('storage', () => ({ status: 'ok' }))).toThrow(
      /already registered/i,
    );

    unregister();
    await expect(registry.check('storage')).resolves.toMatchObject({ status: 'failed' });
    unregister();
  });
});
