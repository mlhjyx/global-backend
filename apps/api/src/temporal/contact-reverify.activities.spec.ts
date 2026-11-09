import { describe, expect, it, vi } from 'vitest';
import { createContactReverifyActivities } from './contact-reverify.activities';
import type { EmailVerificationProvider } from '../enrichment/verification/email-verification-provider';

/**
 * P1-19：CONTACT_REVERIFY_SWEEP 活动的三重门——任一不满足都返回 skipped 且零供应商调用。
 * 取数/落库本体由 reverify-sweep.spec.ts 覆盖；这里只钉活动边界。
 */
function fakeOwnerDb(overrides?: {
  dataProviderStatus?: string | null;
  policy?: { reviewStatus: string; allowedPurpose: string[] } | null;
}) {
  return {
    dataProvider: {
      findUnique: vi.fn(async () =>
        overrides?.dataProviderStatus === null
          ? null
          : { status: overrides?.dataProviderStatus ?? 'ENABLED' },
      ),
    },
    sourcePolicy: {
      findUnique: vi.fn(async () =>
        overrides?.policy === null
          ? null
          : (overrides?.policy ?? { reviewStatus: 'APPROVED', allowedPurpose: ['enrichment'] }),
      ),
    },
    contactPoint: { findMany: vi.fn(async () => []) },
    suppressionRecord: { findMany: vi.fn(async () => []) },
  };
}

function fakeProvider(configured: boolean): EmailVerificationProvider & { verify: ReturnType<typeof vi.fn> } {
  return {
    key: 'millionverifier',
    domain: 'api.millionverifier.com',
    isConfigured: () => configured,
    verify: vi.fn(),
  };
}

const NOW = () => new Date('2026-11-09T00:00:00.000Z');

describe('contactReverifySweepOnce：三重门', () => {
  it('data_provider 未启用（kill switch）→ skipped，零调用', async () => {
    const provider = fakeProvider(true);
    const activities = createContactReverifyActivities({
      ownerDb: fakeOwnerDb({ dataProviderStatus: 'DISABLED' }) as never,
      providers: [provider],
      now: NOW,
    });
    await expect(activities.contactReverifySweepOnce()).resolves.toMatchObject({
      status: 'skipped',
      summary: null,
    });
    expect(provider.verify).not.toHaveBeenCalled();
  });

  it('data_provider 行缺失 / source_policy 未登记 → skipped', async () => {
    const provider = fakeProvider(true);
    const missingRow = createContactReverifyActivities({
      ownerDb: fakeOwnerDb({ dataProviderStatus: null }) as never,
      providers: [provider],
      now: NOW,
    });
    await expect(missingRow.contactReverifySweepOnce()).resolves.toMatchObject({ status: 'skipped' });

    const unregistered = createContactReverifyActivities({
      ownerDb: fakeOwnerDb({ policy: null }) as never,
      providers: [provider],
      now: NOW,
    });
    await expect(unregistered.contactReverifySweepOnce()).resolves.toMatchObject({
      status: 'skipped',
    });
    expect(provider.verify).not.toHaveBeenCalled();
  });

  it('凭据未配置 → skipped（即使 provider 已 ENABLED）', async () => {
    const provider = fakeProvider(false);
    const activities = createContactReverifyActivities({
      ownerDb: fakeOwnerDb() as never,
      providers: [provider],
      now: NOW,
    });
    await expect(activities.contactReverifySweepOnce()).resolves.toMatchObject({
      status: 'skipped',
      reason: 'provider_unconfigured',
    });
    expect(provider.verify).not.toHaveBeenCalled();
  });

  it('无外部验证器凭据但 broker 已装配 → SMTP 兜底票单独成池，活动继续（ran）', async () => {
    const broker = {
      checkSourcePolicy: vi.fn(async () => ({ allowed: true })),
      invoke: vi.fn(),
    };
    const activities = createContactReverifyActivities({
      ownerDb: fakeOwnerDb() as never,
      providers: [],
      broker: broker as never,
      now: NOW,
    });
    await expect(activities.contactReverifySweepOnce()).resolves.toMatchObject({ status: 'ran' });
  });

  it('三道门全过 → ran（有界批次、含成本上限与统计）', async () => {
    const provider = fakeProvider(true);
    const activities = createContactReverifyActivities({
      ownerDb: fakeOwnerDb() as never,
      providers: [provider],
      now: NOW,
    });
    const result = await activities.contactReverifySweepOnce({ limit: 50 });
    expect(result.status).toBe('ran');
    if (result.status !== 'ran') return;
    expect(result.summary).toMatchObject({
      selected: 0,
      providerCalls: 0,
      costMicrousd: 0,
      skippedBudget: 0,
      byState: { VALID: 0, INVALID: 0, CATCH_ALL_RISKY: 0, UNKNOWN: 0 },
    });
  });
});
