import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  projectApprovedChannelGreenFacts,
  recordChannelDomainCooldownTouch,
  requireChannelPlatformWriter,
} from './channel-platform-writer';

function makeMockPlatformWriter(overrides: { role?: string; executeRaw?: ReturnType<typeof vi.fn> } = {}) {
  const role = overrides.role ?? 'execution_budget_platform_writer';
  return {
    $queryRaw: vi.fn(async () => [
      {
        currentUser: `${role}_login`,
        sessionUser: `${role}_login`,
        sessionRole: 'none',
        rolCanLogin: true,
        rolInherit: true,
        rolSuper: false,
        rolBypassRls: false,
        rolCreateDb: false,
        rolCreateRole: false,
        rolReplication: false,
        memberships: [role],
      },
    ]),
    $executeRaw: overrides.executeRaw ?? vi.fn(async () => 1),
  };
}

describe('channel-platform-writer (ADR-003 PG ingestion)', () => {
  it('fails closed when platformWriter is missing or uses wrong DB principal', async () => {
    await expect(requireChannelPlatformWriter(null)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(
      requireChannelPlatformWriter(makeMockPlatformWriter({ role: 'app_user' }) as never),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('skips projection with the flag off, and does not inspect records of a private channel', async () => {
    const findFirst = vi.fn(async () => ({ license: 'test', category: 'imported_buyer' }));
    const queryRaw = vi.fn();
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ sourceChannel: { findFirst }, $queryRaw: queryRaw }),
    );
    const writer = { ...makeMockPlatformWriter(), $transaction: transaction };
    const scope = { channelId: 'fixture-channel', crawlRunId: 'fixture-run', platformWriter: writer as never };

    await expect(projectApprovedChannelGreenFacts({
      ...scope, env: { ADR003_SHARED_GREEN_FACTS: 'readonly' },
    })).resolves.toBeNull();
    expect(transaction).not.toHaveBeenCalled();

    await expect(projectApprovedChannelGreenFacts({
      ...scope, env: { ADR003_SHARED_GREEN_FACTS: 'on' },
    })).resolves.toBeNull();
    expect(findFirst).toHaveBeenCalledOnce();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('logs a bounded projection diagnostic independently of the materialized record', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writer = {
      ...makeMockPlatformWriter(),
      $transaction: vi.fn(async () => { throw new Error('unbounded database diagnostic'); }),
    };
    try {
      await expect(projectApprovedChannelGreenFacts({
        channelId: 'fixture-channel', crawlRunId: 'fixture-run',
        platformWriter: writer as never, env: { ADR003_SHARED_GREEN_FACTS: 'on' },
      })).resolves.toBeNull();
      expect(warn.mock.calls).toEqual([[
        '[channels] CHANNEL_SHARED_FACT_PROJECTION_FAILED',
        { channelId: 'fixture-channel', crawlRunId: 'fixture-run' },
      ]]);
    } finally {
      warn.mockRestore();
    }
  });

  it('records category-scoped HMAC cooldown touches when pepper is configured', async () => {
    const executeRaw = vi.fn(async () => 1);
    const writer = makeMockPlatformWriter({ executeRaw });
    const reader = { $queryRaw: vi.fn(async () => []), $executeRaw: executeRaw };

    const status = await recordChannelDomainCooldownTouch({
      reader,
      platformWriter: writer as never,
      domain: 'coesaenergy.it',
      workspaceId: 'ws-1',
      category: 'trade_fair',
      env: {
        ADR003_SHARED_GREEN_FACTS: 'on',
        ADR003_DOMAIN_COOLDOWN_PEPPER: 'test-pepper-at-least-16-chars-long',
      },
    });
    expect(status?.advisoryOnly).toBe(true);
    expect(executeRaw).toHaveBeenCalled();
  });
});
