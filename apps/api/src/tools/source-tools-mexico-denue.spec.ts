import { describe, expect, it, vi } from 'vitest';
import { ToolBroker, ToolPolicyDenied } from './tool-broker';
import { ToolRegistry } from './tool-registry';
import { mexicoDenueSearchTool } from './source-tools-mexico-denue';
import { registerSourceTools } from './source-tools';

describe('Mexico DENUE ToolBroker boundary', () => {
  it('declares an authenticated organization-only source with provider and policy gates', () => {
    expect(registerSourceTools(new ToolRegistry()).get('mexico-denue.search')).toBe(mexicoDenueSearchTool);
    expect(mexicoDenueSearchTool.compliance).toEqual({
      sourcePolicy: 'required', policyDomain: 'www.inegi.org.mx', providerKey: 'mexico_denue',
      requiresExplicitPurpose: true, respectsRobots: false, personalData: true,
      allowedPurpose: ['discovery'], reversible: true, authRequired: true, risk: 'low',
    });
    expect(mexicoDenueSearchTool.idempotencyKey({
      query: 'NISSAN MEXICANA', stateCode: '01', start: 1, limit: 20,
    })).not.toContain('token');
  });

  it.each([
    ['missing provider', undefined, async () => ({ suspended: false, allowedPurpose: ['discovery'] })],
    ['disabled provider', async () => ({ status: 'DISABLED' }), async () => ({ suspended: false, allowedPurpose: ['discovery'] })],
    ['missing policy', async () => ({ status: 'ENABLED' }), undefined],
    ['suspended policy', async () => ({ status: 'ENABLED' }), async () => ({ suspended: true, allowedPurpose: ['discovery'] })],
  ])('fails before execution with %s', async (_label, providerStatusReader, sourcePolicyReader) => {
    const execute = vi.spyOn(mexicoDenueSearchTool, 'execute');
    const registry = new ToolRegistry();
    registry.register(mexicoDenueSearchTool);
    const broker = new ToolBroker({ registry, providerStatusReader, sourcePolicyReader } as never);
    await expect(broker.invoke(mexicoDenueSearchTool.id, {
      query: 'NISSAN MEXICANA', stateCode: '01', start: 1, limit: 20,
    }, { workspaceId: 'workspace-1', purpose: 'discovery' })).rejects.toBeInstanceOf(ToolPolicyDenied);
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
  });

  it('rejects an implicit or wrong purpose before execution', async () => {
    const execute = vi.spyOn(mexicoDenueSearchTool, 'execute');
    const registry = new ToolRegistry();
    registry.register(mexicoDenueSearchTool);
    const broker = new ToolBroker({
      registry,
      providerStatusReader: async () => ({ status: 'ENABLED' }),
      sourcePolicyReader: async () => ({ suspended: false, allowedPurpose: ['discovery'] }),
    } as never);
    for (const purpose of [undefined, 'enrichment']) {
      await expect(broker.invoke(mexicoDenueSearchTool.id, {
        query: 'NISSAN MEXICANA', stateCode: '01', start: 1, limit: 20,
      }, { workspaceId: 'workspace-1', purpose })).rejects.toBeInstanceOf(ToolPolicyDenied);
    }
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
  });
});
