import { describe, expect, it, vi } from 'vitest';
import { ToolBroker, ToolPolicyDenied } from './tool-broker';
import { ToolRegistry } from './tool-registry';
import { fmcsaQcmobileSearchTool } from './source-tools-fmcsa';
import { registerSourceTools } from './source-tools';

describe('FMCSA QCMobile ToolBroker boundary', () => {
  it('declares an authenticated organization-only projection behind Provider and SourcePolicy gates', () => {
    expect(registerSourceTools(new ToolRegistry()).get('fmcsa-qcmobile.search')).toBe(fmcsaQcmobileSearchTool);
    expect(fmcsaQcmobileSearchTool.compliance).toEqual({
      sourcePolicy: 'required', policyDomain: 'mobile.fmcsa.dot.gov', providerKey: 'fmcsa_qcmobile',
      requiresExplicitPurpose: true, respectsRobots: false, personalData: true,
      allowedPurpose: ['discovery'], reversible: true, authRequired: true, risk: 'low',
    });
    expect(fmcsaQcmobileSearchTool.idempotencyKey({
      query: 'ACME LOGISTICS LLC', start: 0, limit: 10,
    })).not.toContain('webKey');
  });

  it.each([
    ['missing provider', undefined, async () => ({ suspended: false, allowedPurpose: ['discovery'] })],
    ['disabled provider', async () => ({ status: 'DISABLED' }), async () => ({ suspended: false, allowedPurpose: ['discovery'] })],
    ['missing policy', async () => ({ status: 'ENABLED' }), undefined],
    ['suspended policy', async () => ({ status: 'ENABLED' }), async () => ({ suspended: true, allowedPurpose: ['discovery'] })],
  ])('fails before execution with %s', async (_label, providerStatusReader, sourcePolicyReader) => {
    const execute = vi.spyOn(fmcsaQcmobileSearchTool, 'execute');
    const registry = new ToolRegistry();
    registry.register(fmcsaQcmobileSearchTool);
    const broker = new ToolBroker({ registry, providerStatusReader, sourcePolicyReader } as never);
    await expect(broker.invoke(fmcsaQcmobileSearchTool.id, {
      query: 'ACME LOGISTICS LLC', start: 0, limit: 10,
    }, { workspaceId: 'workspace-1', purpose: 'discovery' })).rejects.toBeInstanceOf(ToolPolicyDenied);
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
  });

  it('rejects implicit or wrong purpose before execution', async () => {
    const execute = vi.spyOn(fmcsaQcmobileSearchTool, 'execute');
    const registry = new ToolRegistry();
    registry.register(fmcsaQcmobileSearchTool);
    const broker = new ToolBroker({
      registry,
      providerStatusReader: async () => ({ status: 'ENABLED' }),
      sourcePolicyReader: async () => ({ suspended: false, allowedPurpose: ['discovery'] }),
    } as never);
    for (const purpose of [undefined, 'enrichment']) {
      await expect(broker.invoke(fmcsaQcmobileSearchTool.id, {
        query: 'ACME LOGISTICS LLC', start: 0, limit: 10,
      }, { workspaceId: 'workspace-1', purpose })).rejects.toBeInstanceOf(ToolPolicyDenied);
    }
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
  });
});
