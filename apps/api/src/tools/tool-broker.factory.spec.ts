import { describe, expect, it, vi } from 'vitest';
import { buildToolBroker, sourcePolicyReaderFrom } from './tool-broker.factory';

describe('tool broker factory governance seams', () => {
  it('maps absent, suspended and closed-purpose source policies', async () => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ reviewStatus: 'SUSPENDED', allowedPurpose: ['acquisition'] })
      .mockResolvedValueOnce({ reviewStatus: 'APPROVED', allowedPurpose: 'invalid' });
    const reader = sourcePolicyReaderFrom({ sourcePolicy: { findUnique } } as never);
    await expect(reader('missing.example')).resolves.toBeNull();
    await expect(reader('blocked.example')).resolves.toEqual({
      suspended: true,
      allowedPurpose: ['acquisition'],
    });
    await expect(reader('closed.example')).resolves.toEqual({
      suspended: false,
      allowedPurpose: undefined,
    });
    expect(findUnique).toHaveBeenNthCalledWith(1, {
      where: { domain: 'missing.example' },
      select: { reviewStatus: true, allowedPurpose: true },
    });
  });

  it('constructs a broker with an explicit non-logging trace recorder', () => {
    const traceRecorder = vi.fn();
    expect(buildToolBroker({ traceRecorder })).toBeDefined();
    expect(traceRecorder).not.toHaveBeenCalled();
  });
});
