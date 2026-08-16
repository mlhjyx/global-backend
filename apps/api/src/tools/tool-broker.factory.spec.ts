import { describe, expect, it, vi } from 'vitest';
import { buildToolBroker, providerStatusReaderFrom } from './tool-broker.factory';
import { ToolPolicyDenied } from './tool-broker';

describe('tool broker factory provider-status wiring', () => {
  it('reads only the provider status by exact key', async () => {
    const findUnique = vi.fn(async () => ({ status: 'DISABLED' }));
    const reader = providerStatusReaderFrom({ dataProvider: { findUnique } } as never);

    await expect(reader('sec_edgar')).resolves.toEqual({ status: 'DISABLED' });
    expect(findUnique).toHaveBeenCalledWith({
      where: { key: 'sec_edgar' },
      select: { status: true },
    });
  });

  it('wires the provider reader so a disabled SEC tool is denied before execute', async () => {
    const broker = buildToolBroker({
      providerStatusReader: async () => ({ status: 'DISABLED' }),
      sourcePolicyReader: async () => ({ suspended: false, allowedPurpose: ['discovery'] }),
    });

    await expect(broker.invoke(
      'sec-edgar.company-directory.search',
      { query: 'AAPL', limit: 1 },
      { workspaceId: 'w', purpose: 'discovery' },
    )).rejects.toEqual(expect.objectContaining<ToolPolicyDenied>({
      reason: 'provider not enabled: sec_edgar',
    }));
  });
});
