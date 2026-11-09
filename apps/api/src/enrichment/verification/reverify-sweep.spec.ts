import { encryptPii } from '../../compliance/pii-crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseReverifyArgs } from '../../../scripts/reverify-contact-points.mts';
import { runReverifySweep, type ReverifyOptions } from './reverify-sweep';
import type { EmailVerificationProvider } from './email-verification-provider';

/**
 * P1-19（首波）：再验证编排的批处理契约——限流/幂等/合规门/状态机落库。
 * 全部用内存 fake（无真实出网、无真实数据库）。
 */
const NOW = new Date('2026-11-09T10:00:00.000Z');

function baseOptions(overrides: Partial<ReverifyOptions> = {}): ReverifyOptions {
  return {
    dryRun: false,
    limit: 100,
    ratePerSecond: 50,
    workspaceId: null,
    ignoreSchedule: false,
    requestBucket: '2026-11-09',
    ...overrides,
  };
}

interface FakePointOverrides {
  legalBasis?: string | null;
  verificationState?: string;
  fullName?: string;
  companyStatus?: string;
}

function fakePoint(overrides: FakePointOverrides = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000aa',
    workspaceId: '00000000-0000-4000-8000-0000000000bb',
    value: encryptPii('max.mustermann@acme.example'),
    verificationState: overrides.verificationState ?? 'UNKNOWN',
    validSince: null,
    nextReverifyAt: new Date('2026-11-09T00:00:00.000Z'),
    legalBasis: overrides.legalBasis === undefined ? 'legitimate_interest' : overrides.legalBasis,
    contact: {
      fullName: overrides.fullName ?? 'Max Mustermann',
      company: {
        name: 'Acme Pumpen GmbH',
        domain: 'acme.example',
        status: overrides.companyStatus ?? 'NEW',
        dedupeKey: 'domain:acme.example',
      },
    },
  };
}

function fakePrisma(
  points: ReturnType<typeof fakePoint>[],
  suppressions: Array<{ workspaceId?: string; type: string; value: string }> = [],
) {
  const events: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const eventDelegate = {
    findUnique: vi.fn(async () => null),
    count: vi.fn(async () => 0),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      events.push(data);
      return { id: `event-${events.length}` };
    }),
  };
  const prisma = {
    contactPoint: {
      findMany: vi.fn(async () => points),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return {};
      }),
    },
    suppressionRecord: { findMany: vi.fn(async () => suppressions) },
    contactPointVerificationEvent: { findUnique: vi.fn(async () => null) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        contactPoint: { update: prisma.contactPoint.update },
        contactPointVerificationEvent: eventDelegate,
        suppressionRecord: { findMany: vi.fn(async () => suppressions) },
        $queryRaw: vi.fn(async () => [{ locked: true }]),
        $executeRawUnsafe: vi.fn(async () => 1),
      }),
  };
  return { prisma, events, updates, eventDelegate };
}

function fakeProvider(result: Awaited<ReturnType<EmailVerificationProvider['verify']>>): EmailVerificationProvider & {
  verify: ReturnType<typeof vi.fn>;
} {
  return {
    key: 'millionverifier',
    domain: 'api.millionverifier.com',
    isConfigured: () => true,
    verify: vi.fn(async () => result),
  };
}

const validResult = {
  providerKey: 'millionverifier',
  state: 'VALID' as const,
  catchAll: 'not_catch_all' as const,
  catchAllClass: 'not_catch_all' as const,
  score: 95,
  acceptAll: false,
  disposable: false,
  role: false,
  detail: 'ok:ok.mailbox',
  error: null,
  costMicrousd: 1_780,
  latencyMs: 5,
};

beforeEach(() => {
  delete process.env.EMAIL_VERIFY_ALLOW_PERSONAL_WITHOUT_BASIS;
});
afterEach(() => {
  delete process.env.EMAIL_VERIFY_ALLOW_PERSONAL_WITHOUT_BASIS;
});

describe('parseReverifyArgs', () => {
  it('默认值：非 dry-run、limit 100、rate 5、桶=UTC 日期', () => {
    expect(parseReverifyArgs([])).toMatchObject({
      dryRun: false,
      limit: 100,
      ratePerSecond: 5,
      workspaceId: null,
      ignoreSchedule: false,
    });
    expect(parseReverifyArgs([]).requestBucket).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it('显式参数与非法值', () => {
    expect(
      parseReverifyArgs(['--dry-run', '--limit', '50', '--rate', '10', '--workspace', 'w1', '--ignore-schedule', '--request-bucket', 'cycle-1']),
    ).toMatchObject({ dryRun: true, limit: 50, ratePerSecond: 10, workspaceId: 'w1', ignoreSchedule: true, requestBucket: 'cycle-1' });
    expect(() => parseReverifyArgs(['--limit', '0'])).toThrow(/--limit/u);
    expect(() => parseReverifyArgs(['--rate', '99'])).toThrow(/--rate/u);
  });
});

describe('runReverifySweep：单验证器 positive 不判 VALID（双正规则）', () => {
  it('供应商 ok（单票）→ 点保持 UNKNOWN，事件账记原始 valid 并注明待第二票', async () => {
    const { prisma, events, updates } = fakePrisma([fakePoint()]);
    const provider = fakeProvider(validResult);
    const summary = await runReverifySweep({
      prisma: prisma as never,
      provider,
      options: baseOptions(),
      now: () => NOW,
    });
    expect(summary.providerCalls).toBe(1);
    expect(summary.byState.UNKNOWN).toBe(1);
    expect(summary.costMicrousd).toBe(1_780);
    expect(events[0]).toMatchObject({
      verdict: 'valid',
      providerKey: 'millionverifier',
      method: 'third_party_api',
      costMicrousd: BigInt(1_780),
      actorId: 'reverify-sweep:cli',
    });
    expect(String(events[0]?.detail)).toContain('single_positive_requires_second_vote');
    expect(updates[0]).toMatchObject({
      verificationState: 'UNKNOWN',
      status: 'UNVERIFIED',
      verificationProvider: 'millionverifier',
      verificationMethod: 'third_party_api',
    });
  });

  it('供应商 invalid → INVALID（5xx 强否定，单票即可）', async () => {
    const { prisma, updates } = fakePrisma([fakePoint()]);
    const provider = fakeProvider({ ...validResult, state: 'INVALID', catchAll: 'unknown', catchAllClass: 'unknown', detail: 'invalid:invalid.mailbox' });
    const summary = await runReverifySweep({ prisma: prisma as never, provider, options: baseOptions(), now: () => NOW });
    expect(summary.byState.INVALID).toBe(1);
    expect(updates[0]).toMatchObject({ verificationState: 'INVALID', status: 'INVALID', validSince: null });
  });

  it('accept_all=true 的 ok → CATCH_ALL_RISKY·true_catch_all（不得判 VALID）', async () => {
    const { prisma, updates } = fakePrisma([fakePoint()]);
    const provider = fakeProvider({ ...validResult, state: 'CATCH_ALL_RISKY', catchAll: 'catch_all', catchAllClass: 'true_catch_all', acceptAll: true });
    const summary = await runReverifySweep({ prisma: prisma as never, provider, options: baseOptions(), now: () => NOW });
    expect(summary.byState.CATCH_ALL_RISKY).toBe(1);
    expect(updates[0]).toMatchObject({ verificationState: 'CATCH_ALL_RISKY', status: 'RISKY', catchAllClass: 'true_catch_all' });
  });

  it('供应商网络错误 → 状态不变（UNKNOWN），事件 verdict=error 且不计费', async () => {
    const { prisma, events, updates } = fakePrisma([fakePoint()]);
    const provider = fakeProvider({ ...validResult, state: 'UNKNOWN', catchAll: 'unknown', catchAllClass: 'unknown', error: 'timeout', costMicrousd: 0 });
    const summary = await runReverifySweep({ prisma: prisma as never, provider, options: baseOptions(), now: () => NOW });
    expect(summary.errors).toBe(1);
    expect(events[0]).toMatchObject({ verdict: 'error' });
    expect(updates[0]).toMatchObject({ verificationState: 'UNKNOWN' });
    expect(updates[0]).not.toHaveProperty('catchAllClass');
  });
});

describe('runReverifySweep：成本上限', () => {
  it('达到 maxCostMicrousd 即停本轮（第二个点不再调用供应商，skippedBudget>0）', async () => {
    const p1 = fakePoint();
    const p2 = { ...fakePoint(), id: '00000000-0000-4000-8000-0000000000cc' };
    const { prisma } = fakePrisma([p1, p2]);
    const provider = fakeProvider(validResult);
    const summary = await runReverifySweep({
      prisma: prisma as never,
      provider,
      options: baseOptions({ maxCostMicrousd: 1_000 }),
      now: () => NOW,
    });
    expect(summary.providerCalls).toBe(1);
    expect(summary.costMicrousd).toBe(1_780);
    expect(summary.skippedBudget).toBeGreaterThan(0);
  });
});

describe('runReverifySweep：合规门与幂等', () => {
  it('人名邮箱无 lawful basis → 不触网，记 blocked 事件，状态不变', async () => {
    const { prisma, events, updates } = fakePrisma([fakePoint({ legalBasis: null })]);
    const provider = fakeProvider(validResult);
    const summary = await runReverifySweep({ prisma: prisma as never, provider, options: baseOptions(), now: () => NOW });
    expect(provider.verify).not.toHaveBeenCalled();
    expect(summary.skippedCompliance).toBe(1);
    expect(events[0]).toMatchObject({ verdict: 'blocked' });
    expect(updates).toHaveLength(0);
  });

  it('suppression 命中（email）→ 不触网，记 blocked 事件', async () => {
    const { prisma, events } = fakePrisma([fakePoint()], [{ workspaceId: '00000000-0000-4000-8000-0000000000bb', type: 'email', value: 'MAX.MUSTERMANN@ACME.EXAMPLE' }]);
    const provider = fakeProvider(validResult);
    const summary = await runReverifySweep({ prisma: prisma as never, provider, options: baseOptions(), now: () => NOW });
    expect(provider.verify).not.toHaveBeenCalled();
    expect(summary.skippedSuppressed).toBe(1);
    expect(events[0]).toMatchObject({ verdict: 'blocked' });
  });

  it('公司被抑制（status=SUPPRESSED）→ 不触网', async () => {
    const { prisma } = fakePrisma([fakePoint({ companyStatus: 'SUPPRESSED' })]);
    const provider = fakeProvider(validResult);
    const summary = await runReverifySweep({ prisma: prisma as never, provider, options: baseOptions(), now: () => NOW });
    expect(provider.verify).not.toHaveBeenCalled();
    expect(summary.skippedSuppressed).toBe(1);
  });

  it('同桶已处理（事件已存在）→ 不调供应商、不重复计费', async () => {
    const { prisma } = fakePrisma([fakePoint()]);
    prisma.contactPointVerificationEvent.findUnique.mockResolvedValueOnce({ id: 'dup' });
    const provider = fakeProvider(validResult);
    const summary = await runReverifySweep({ prisma: prisma as never, provider, options: baseOptions(), now: () => NOW });
    expect(provider.verify).not.toHaveBeenCalled();
    expect(summary.duplicates).toBe(1);
    expect(summary.costMicrousd).toBe(0);
  });

  it('dry-run：只选点，不调用供应商/不写库', async () => {
    const { prisma, updates } = fakePrisma([fakePoint()]);
    const provider = fakeProvider(validResult);
    const summary = await runReverifySweep({
      prisma: prisma as never,
      provider,
      options: baseOptions({ dryRun: true }),
      now: () => NOW,
    });
    expect(summary.selected).toBe(1);
    expect(provider.verify).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});
