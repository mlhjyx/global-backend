import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolBroker, ToolPolicyDenied } from './tool-broker';
import { ToolRegistry } from './tool-registry';
import { konepsContractBuyerSearchTool } from './source-tools-koneps';
import { registerSourceTools } from './source-tools';

const input = {
  organizationName: '조달청',
  productName: '철도용승강장안전발판',
  fromDate: '2026-08-01',
  toDate: '2026-08-07',
  page: 1,
  limit: 10,
};

afterEach(() => {
  delete process.env.KONEPS_SERVICE_KEY;
});

describe('KONEPS ToolBroker boundary', () => {
  it('is registered in the shared ToolBroker registry', () => {
    const registry = registerSourceTools(new ToolRegistry());
    expect(registry.get(konepsContractBuyerSearchTool.id)).toBe(konepsContractBuyerSearchTool);
  });

  it('declares authenticated, explicit-only, personal-data-aware source governance', async () => {
    expect(konepsContractBuyerSearchTool.compliance).toEqual({
      sourcePolicy: 'required',
      policyDomain: 'apis.data.go.kr',
      providerKey: 'koneps',
      requiresExplicitPurpose: true,
      respectsRobots: false,
      personalData: true,
      allowedPurpose: ['discovery'],
      reversible: true,
      authRequired: true,
      risk: 'low',
    });
    expect(konepsContractBuyerSearchTool.idempotencyKey(input)).not.toContain('조달청');
    await expect(konepsContractBuyerSearchTool.healthCheck?.()).resolves.toEqual({
      healthy: false,
      detail: 'service-key-missing',
    });
  });

  it.each([
    ['missing provider', undefined, async () => ({ suspended: false, allowedPurpose: ['discovery'] })],
    ['disabled provider', async () => ({ status: 'DISABLED' }), async () => ({ suspended: false, allowedPurpose: ['discovery'] })],
    ['missing policy', async () => ({ status: 'ENABLED' }), undefined],
    ['suspended policy', async () => ({ status: 'ENABLED' }), async () => ({ suspended: true, allowedPurpose: ['discovery'] })],
  ])('fails before execution with %s', async (_label, providerStatusReader, sourcePolicyReader) => {
    const execute = vi.spyOn(konepsContractBuyerSearchTool, 'execute');
    const registry = new ToolRegistry();
    registry.register(konepsContractBuyerSearchTool);
    const broker = new ToolBroker({ registry, providerStatusReader, sourcePolicyReader } as never);
    await expect(broker.invoke(konepsContractBuyerSearchTool.id, input, {
      workspaceId: 'workspace-1', purpose: 'discovery',
    })).rejects.toBeInstanceOf(ToolPolicyDenied);
    expect(execute).not.toHaveBeenCalled();
    execute.mockRestore();
  });

  it('does not execute without an environment-owned service key', async () => {
    await expect(konepsContractBuyerSearchTool.execute(input, {
      workspaceId: 'workspace-1', purpose: 'discovery',
    })).rejects.toThrow('KONEPS_SERVICE_KEY_REQUIRED');
  });
});
