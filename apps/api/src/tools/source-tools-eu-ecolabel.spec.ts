import { describe, expect, it, vi } from 'vitest';
import { ToolBroker, ToolPolicyDenied } from './tool-broker';
import { ToolRegistry } from './tool-registry';
import { euEcolabelProductsSearchTool } from './source-tools-eu-ecolabel';
import { registerSourceTools } from './source-tools';

describe('EU Ecolabel ToolBroker boundary', () => {
  it('is registered in the shared ToolBroker registry', () => {
    expect(registerSourceTools(new ToolRegistry()).get(euEcolabelProductsSearchTool.id)).toBe(euEcolabelProductsSearchTool);
  });
  it('declares the public API as an explicit, policy-gated, potentially personal source', () => {
    expect(euEcolabelProductsSearchTool.compliance).toEqual({
      sourcePolicy: 'required', policyDomain: 'apps.data.env.service.ec.europa.eu', providerKey: 'eu_ecolabel',
      requiresExplicitPurpose: true, respectsRobots: false, personalData: true,
      allowedPurpose: ['discovery'], reversible: true, authRequired: false, risk: 'low',
    });
    expect(euEcolabelProductsSearchTool.rateLimit).toEqual({ rps: 0.5, concurrency: 1 });
  });

  it.each([
    ['missing provider', undefined, async () => ({ suspended: false, allowedPurpose: ['discovery'] })],
    ['disabled provider', async () => ({ status: 'DISABLED' }), async () => ({ suspended: false, allowedPurpose: ['discovery'] })],
    ['missing policy', async () => ({ status: 'ENABLED' }), undefined],
    ['suspended policy', async () => ({ status: 'ENABLED' }), async () => ({ suspended: true, allowedPurpose: ['discovery'] })],
  ])('fails before execution with %s', async (_label, providerStatusReader, sourcePolicyReader) => {
    const execute = vi.spyOn(euEcolabelProductsSearchTool, 'execute');
    const registry = new ToolRegistry();
    registry.register(euEcolabelProductsSearchTool);
    const broker = new ToolBroker({ registry, providerStatusReader, sourcePolicyReader } as never);
    await expect(broker.invoke(euEcolabelProductsSearchTool.id, {
      organizationName: 'ACME GmbH', country: 'Austria', offset: 0, limit: 10,
    }, { workspaceId: 'workspace-1', purpose: 'discovery' })).rejects.toBeInstanceOf(ToolPolicyDenied);
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
  });

  it('rejects implicit or wrong purpose before execution', async () => {
    const execute = vi.spyOn(euEcolabelProductsSearchTool, 'execute');
    const registry = new ToolRegistry();
    registry.register(euEcolabelProductsSearchTool);
    const broker = new ToolBroker({
      registry,
      providerStatusReader: async () => ({ status: 'ENABLED' }),
      sourcePolicyReader: async () => ({ suspended: false, allowedPurpose: ['discovery'] }),
    } as never);
    for (const purpose of [undefined, 'enrichment']) {
      await expect(broker.invoke(euEcolabelProductsSearchTool.id, {
        organizationName: 'ACME GmbH', country: 'Austria', offset: 0, limit: 10,
      }, { workspaceId: 'workspace-1', purpose })).rejects.toBeInstanceOf(ToolPolicyDenied);
    }
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
  });
});
