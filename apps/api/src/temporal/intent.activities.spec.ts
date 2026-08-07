import { describe, expect, it, vi } from 'vitest';
import { createIntentActivities } from './intent.activities';

const SENSITIVE_ERROR =
  'contact Eva Pump eva@example.de https://buyer.example/rfq token=pilot-secret';

describe('intent activity history boundary', () => {
  it('replaces an untrusted service reason before returning an ActivityTaskCompleted payload', async () => {
    const prisma = {
      monitoredSource: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'watch-1',
          providerKey: 'web_watch',
          status: SENSITIVE_ERROR,
        }),
      },
    };
    const activities = createIntentActivities({
      prisma: prisma as never,
      fetcher: { fetch: vi.fn() },
    });

    const result = await activities.watchSource({ sourceId: 'watch-1' });

    expect(result).toMatchObject({
      sourceId: 'watch-1',
      status: 'SKIPPED',
      reason: 'INTENT_WATCH_SKIPPED',
    });
    expect(JSON.stringify(result)).not.toContain(SENSITIVE_ERROR);
    expect(JSON.stringify(result)).not.toContain('eva@example.de');
    expect(JSON.stringify(result)).not.toContain('pilot-secret');
  });
});
