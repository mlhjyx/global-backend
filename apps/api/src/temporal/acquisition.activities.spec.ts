import { describe, expect, it, vi } from 'vitest';
import { SourceAdapterRegistry } from '../acquisition/source-adapter';
import { createAcquisitionActivities } from './acquisition.activities';

const SENSITIVE_ERROR =
  'contact Eva Pump eva@example.de https://buyer.example/rfq token=pilot-secret';

describe('acquisition activity history boundary', () => {
  it('replaces a provider failure reason before returning an ActivityTaskCompleted payload', async () => {
    const prisma = {
      monitoredSource: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'source-1',
          status: 'ACTIVE',
          providerKey: 'test-provider',
          sourceKey: 'pump-buyers',
          config: {},
        }),
      },
      sourceFetch: {
        create: vi.fn().mockResolvedValue({ id: 'fetch-1' }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const registry = new SourceAdapterRegistry().register({
      providerKey: 'test-provider',
      fetch: vi.fn().mockRejectedValue(new Error(SENSITIVE_ERROR)),
    });
    const activities = createAcquisitionActivities({
      prisma: prisma as never,
      registry,
    });

    const result = await activities.acquireSource({ sourceId: 'source-1' });

    expect(result).toMatchObject({
      sourceId: 'source-1',
      status: 'FAILED',
      reason: 'ACQUISITION_SOURCE_FAILED',
    });
    expect(JSON.stringify(result)).not.toContain(SENSITIVE_ERROR);
    expect(JSON.stringify(result)).not.toContain('eva@example.de');
    expect(JSON.stringify(result)).not.toContain('pilot-secret');
  });

  it('replaces an untrusted skipped-status reason at the activity boundary', async () => {
    const prisma = {
      monitoredSource: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'source-1',
          status: SENSITIVE_ERROR,
          providerKey: 'test-provider',
          sourceKey: 'pump-buyers',
          config: {},
        }),
      },
    };
    const activities = createAcquisitionActivities({
      prisma: prisma as never,
      registry: new SourceAdapterRegistry(),
    });

    const result = await activities.acquireSource({ sourceId: 'source-1' });

    expect(result.reason).toBe('ACQUISITION_SOURCE_SKIPPED');
    expect(JSON.stringify(result)).not.toContain(SENSITIVE_ERROR);
  });
});
