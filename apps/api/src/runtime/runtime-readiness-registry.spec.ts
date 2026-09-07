import { describe, expect, it, vi } from 'vitest';
import { RuntimeReadinessContributorRegistry } from './runtime-readiness-registry';
import { PlatformAutomationReadinessService } from '../platform-authority/platform-automation-readiness';
import { PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1 } from '../platform-authority/platform-execution-contract';
import { loadVerifiedPlatformAuthorityPolicyAsset } from '../platform-authority/platform-authority-policy-asset';

describe('RuntimeReadinessContributorRegistry', () => {
  it('publishes one bounded readiness fact per named capability', async () => {
    const registry = new RuntimeReadinessContributorRegistry();
    registry.register('storage', () => ({ status: 'ok' }));

    await expect(registry.check('storage')).resolves.toEqual({ status: 'ok' });
  });

  it('fails closed for missing, throwing and malformed contributors', async () => {
    const registry = new RuntimeReadinessContributorRegistry();
    await expect(registry.check('storage')).resolves.toEqual({
      status: 'failed',
      code: 'READINESS_CONTRIBUTOR_MISSING',
    });

    registry.register('storage', () => {
      throw new Error('s3://access-key:secret@customer-bucket');
    });
    const result = await registry.check('storage');
    expect(result).toEqual({
      status: 'failed',
      code: 'READINESS_CONTRIBUTOR_FAILED',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('rejects duplicate writers and supports exact-owner unregister', async () => {
    const registry = new RuntimeReadinessContributorRegistry();
    const first = vi.fn(() => ({ status: 'ok' as const }));
    const unregister = registry.register('storage', first);
    expect(() => registry.register('storage', () => ({ status: 'ok' }))).toThrow(
      /already registered/i,
    );

    unregister();
    await expect(registry.check('storage')).resolves.toMatchObject({ status: 'failed' });
    unregister();
  });

  it('returns one sanitized aggregate and four-row projection from one contributor invocation', async () => {
    const registry = new RuntimeReadinessContributorRegistry();
    const report = await new PlatformAutomationReadinessService({
      technicalContract: PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
      policyAsset: loadVerifiedPlatformAuthorityPolicyAsset(),
      quote: async () => ({ status: 'ok' }),
      temporalProof: async () => ({ status: 'ok' }),
      issuer: async () => ({ status: 'ok' }),
      writer: async () => ({ status: 'ok' }),
      revocationDelivery: async () => ({ status: 'ok' }),
      egressFence: async () => ({
        status: 'failed',
        code: 'PLATFORM_EGRESS_FENCE_UNAVAILABLE',
      }),
    }).inspect();
    const contributor = vi.fn(async () => ({
      status: 'failed' as const,
      code: 'PLATFORM_AUTOMATION_ACQ_SWEEP_BLOCKED',
      platformAutomation: report,
      unexpectedPayload: 'sensitive-value-must-never-leak',
    }));
    registry.register('platform_budget_authority', contributor);

    const snapshot = await registry.checkPlatformAutomation(
      'platform_budget_authority',
    );

    expect(contributor).toHaveBeenCalledOnce();
    expect(snapshot.component).toEqual({
      status: 'failed',
      code: 'PLATFORM_AUTOMATION_ACQ_SWEEP_BLOCKED',
    });
    expect(snapshot.platformAutomation.rows).toHaveLength(4);
    expect(
      snapshot.platformAutomation.rows.filter(
        (row) => row.identity.purpose === 'platform.acquisition',
      ).map((row) => row.identity.scheduleId),
    ).toEqual(['acq-sweep', 'patents-cache-refresh']);
    expect(JSON.stringify(snapshot)).not.toContain(
      'sensitive-value-must-never-leak',
    );
  });

  it('does not invoke or expose an accessor-backed platform payload', async () => {
    const registry = new RuntimeReadinessContributorRegistry();
    let getterCalls = 0;
    registry.register('platform_budget_authority', () =>
      Object.defineProperties({}, {
        status: { enumerable: true, value: 'failed' },
        code: {
          enumerable: true,
          value: 'PLATFORM_AUTOMATION_ACQ_SWEEP_BLOCKED',
        },
        platformAutomation: {
          enumerable: true,
          get() {
            getterCalls += 1;
            return { opaquePayload: 'sensitive-value-must-never-leak' };
          },
        },
      }) as never,
    );

    const snapshot = await registry.checkPlatformAutomation(
      'platform_budget_authority',
    );

    expect(snapshot.component).toEqual({
      status: 'failed',
      code: 'READINESS_CONTRIBUTOR_FAILED',
    });
    expect(snapshot.platformAutomation.rows.map((row) => row.state)).toEqual(
      Array(4).fill('BLOCKED'),
    );
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain(
      'sensitive-value-must-never-leak',
    );
  });

  it('rejects an aggregate that disagrees with the same four-row snapshot', async () => {
    const registry = new RuntimeReadinessContributorRegistry();
    const report = await new PlatformAutomationReadinessService({
      technicalContract: PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
      policyAsset: loadVerifiedPlatformAuthorityPolicyAsset(),
      quote: async () => ({ status: 'ok' }),
      temporalProof: async () => ({ status: 'ok' }),
      issuer: async () => ({ status: 'ok' }),
      writer: async () => ({ status: 'ok' }),
      revocationDelivery: async () => ({ status: 'ok' }),
      egressFence: async () => ({
        status: 'failed',
        code: 'PLATFORM_EGRESS_FENCE_UNAVAILABLE',
      }),
    }).inspect();
    registry.register('platform_budget_authority', async () => ({
      status: 'ok',
      platformAutomation: report,
    }));

    await expect(
      registry.checkPlatformAutomation('platform_budget_authority'),
    ).resolves.toMatchObject({
      component: {
        status: 'failed',
        code: 'READINESS_CONTRIBUTOR_FAILED',
      },
      platformAutomation: {
        rows: [
          { state: 'BLOCKED' },
          { state: 'BLOCKED' },
          { state: 'BLOCKED' },
          { state: 'BLOCKED' },
        ],
      },
    });
  });
});
