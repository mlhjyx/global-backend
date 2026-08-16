import { describe, expect, it, vi } from 'vitest';
import { ProviderControlPlaneController } from './provider-control-plane.controller';

describe('ProviderControlPlaneController', () => {
  it('returns the typed read model with no-store and delegates the authenticated workspace', async () => {
    const list = vi.fn(async () => ({ providers: [] }));
    const controller = new ProviderControlPlaneController({ list } as never);
    const setHeader = vi.fn();
    const ctx = { userId: 'u1', workspaceId: 'ws1', roles: ['ops'] };

    await controller.list(ctx, { setHeader } as never);

    expect(list).toHaveBeenCalledWith(ctx);
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
});
