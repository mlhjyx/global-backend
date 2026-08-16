import { describe, expect, it, vi } from 'vitest';
import { ToolBroker, ToolPolicyDenied } from './tool-broker';
import { ToolRegistry } from './tool-registry';
import { sbirSttrCompanySearchTool } from './source-tools-sbir';
import { registerSourceTools } from './source-tools';

describe('SBIR/STTR Company API ToolBroker boundary', () => {
  it('is registered in the shared ToolBroker registry', () => {
    expect(registerSourceTools(new ToolRegistry()).get(sbirSttrCompanySearchTool.id)).toBe(sbirSttrCompanySearchTool);
  });
  it('declares a public organization-only projection behind Provider and SourcePolicy gates', () => {
    expect(sbirSttrCompanySearchTool.compliance).toEqual({
      sourcePolicy: 'required',
      policyDomain: 'api.www.sbir.gov',
      providerKey: 'sbir_sttr_companies',
      requiresExplicitPurpose: true,
      respectsRobots: false,
      personalData: true,
      allowedPurpose: ['discovery'],
      reversible: true,
      authRequired: false,
      risk: 'low',
    });
    expect(sbirSttrCompanySearchTool.idempotencyKey({
      query: 'LUNA INNOVATIONS INC', start: 0, limit: 10,
    })).not.toContain('LUNA INNOVATIONS INC');
  });

  it.each([
    ['missing provider', undefined, async () => ({ suspended: false, allowedPurpose: ['discovery'] })],
    ['disabled provider', async () => ({ status: 'DISABLED' }), async () => ({ suspended: false, allowedPurpose: ['discovery'] })],
    ['missing policy', async () => ({ status: 'ENABLED' }), undefined],
    ['suspended policy', async () => ({ status: 'ENABLED' }), async () => ({ suspended: true, allowedPurpose: ['discovery'] })],
  ])('fails before execution with %s', async (_label, providerStatusReader, sourcePolicyReader) => {
    const execute = vi.spyOn(sbirSttrCompanySearchTool, 'execute');
    const registry = new ToolRegistry();
    registry.register(sbirSttrCompanySearchTool);
    const broker = new ToolBroker({ registry, providerStatusReader, sourcePolicyReader } as never);
    await expect(broker.invoke(sbirSttrCompanySearchTool.id, {
      query: 'LUNA INNOVATIONS INC', start: 0, limit: 10,
    }, { workspaceId: 'workspace-1', purpose: 'discovery' })).rejects.toBeInstanceOf(ToolPolicyDenied);
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
  });

  it('rejects implicit or wrong purpose before execution', async () => {
    const execute = vi.spyOn(sbirSttrCompanySearchTool, 'execute');
    const registry = new ToolRegistry();
    registry.register(sbirSttrCompanySearchTool);
    const broker = new ToolBroker({
      registry,
      providerStatusReader: async () => ({ status: 'ENABLED' }),
      sourcePolicyReader: async () => ({ suspended: false, allowedPurpose: ['discovery'] }),
    } as never);
    for (const purpose of [undefined, 'enrichment']) {
      await expect(broker.invoke(sbirSttrCompanySearchTool.id, {
        query: 'LUNA INNOVATIONS INC', start: 0, limit: 10,
      }, { workspaceId: 'workspace-1', purpose })).rejects.toBeInstanceOf(ToolPolicyDenied);
    }
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
  });
});
