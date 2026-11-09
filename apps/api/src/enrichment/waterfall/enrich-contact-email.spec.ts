import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EmailEnrichmentAdapter,
  FindEmailInput,
  FindEmailOutcome,
} from '../finders/email-enrichment-provider';
import { enrichmentRequestHash } from '../finders/email-enrichment-provider';
import type {
  EmailVerificationProvider,
  EmailVerificationProviderResult,
} from '../verification/email-verification-provider';
import type { EmailVerificationState } from '../../discovery/contact-point-verification-state';
import { CapBudget } from './enrichment-budget';
import { enrichContactEmail, type EnrichContactDeps } from './enrich-contact-email';
import { emptyCircuitState, type CircuitState } from './circuit-breaker';

/**
 * P1-08：富集编排器契约——假 prisma 事务 + 假 finder/验证器，零真实出网。
 * 覆盖停止规则（≤3 家、INVALID 继续买、UNKNOWN 落库即停）、预算、熔断、复用、
 * 合规门与验证门，以及落库事务的事件账/状态回写/attempt 回填。
 */
const NOW = new Date('2026-11-09T12:00:00.000Z');
const WORKSPACE = '00000000-0000-4000-8000-0000000000aa';
const CONTACT = '00000000-0000-4000-8000-0000000000bb';

// 验证门策略的 env 兜底开关必须清掉，测试才是环境无关的（缺省 false = 人名邮箱需 basis）。
beforeEach(() => {
  delete process.env.EMAIL_VERIFY_ALLOW_PERSONAL_WITHOUT_BASIS;
});

const PERSONAL_EMAIL = 'juergen.mueller@acme.example';
const ROLE_EMAIL = 'sales@acme.example';

function fakeDb(
  seed: {
    attempts?: Array<Record<string, unknown>>;
    point?: { id: string; verificationState: string; validSince: Date | null; nextReverifyAt: Date | null };
    suppressionHit?: boolean;
  } = {},
) {
  const attemptCreates: Array<Record<string, unknown>> = [];
  const attemptUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const pointUpserts: Array<Record<string, unknown>> = [];
  const pointUpdates: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRawUnsafe: vi.fn(async () => 1),
    contactPoint: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        pointUpserts.push(create);
        return {
          id: seed.point?.id ?? 'point-1',
          verificationState: seed.point?.verificationState ?? 'UNKNOWN',
          validSince: seed.point?.validSince ?? null,
          nextReverifyAt: seed.point?.nextReverifyAt ?? null,
        };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        pointUpdates.push(data);
        return { id: where.id };
      }),
    },
    contactPointVerificationEvent: {
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return { id: `event-${events.length}` };
      }),
      findUnique: vi.fn(async () => null),
    },
    contactEnrichmentAttempt: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        attemptCreates.push(data);
        return {
          id: `attempt-${attemptCreates.length}`,
          providerKey: data.providerKey as string,
          requestHash: data.requestHash as string,
          outcome: data.outcome as string,
          errorCode: (data.errorCode as string | null) ?? null,
          emailState: (data.emailState as string | null) ?? null,
          costMicrousd: data.costMicrousd as bigint,
          attemptedAt: (data.attemptedAt as Date | undefined) ?? NOW,
        };
      }),
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { workspaceId_providerKey_requestHash: { providerKey: string; requestHash: string } };
        }) => {
          const key = where.workspaceId_providerKey_requestHash;
          return (
            (seed.attempts ?? []).find(
              (row) => row.providerKey === key.providerKey && row.requestHash === key.requestHash,
            ) ?? null
          );
        },
      ),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        attemptUpdates.push({ where, data });
        return { id: where.id, ...data };
      }),
    },
    suppressionRecord: {
      findFirst: vi.fn(async () => (seed.suppressionHit ? { id: 'suppression-1' } : null)),
    },
  };
  const prisma = {
    withWorkspace: vi.fn(
      async (_workspaceId: string, fn: (client: unknown) => Promise<unknown>) => fn(tx),
    ),
  };
  return { prisma, tx, attemptCreates, attemptUpdates, pointUpserts, pointUpdates, events };
}

interface FinderHandle {
  adapter: EmailEnrichmentAdapter;
  calls: FindEmailInput[];
}

function finder(
  key: EmailEnrichmentAdapter['key'],
  outcome: FindEmailOutcome | ((input: FindEmailInput) => FindEmailOutcome),
): FinderHandle {
  const calls: FindEmailInput[] = [];
  const adapter: EmailEnrichmentAdapter = {
    key,
    domain: `api.${key}.io`,
    class: 'b2b_company_person',
    costMicrousd: 10_000,
    isConfigured: () => true,
    requestHash: (input) => enrichmentRequestHash(input.contactId, key, input),
    findEmail: async (input) => {
      calls.push(input);
      return typeof outcome === 'function' ? outcome(input) : outcome;
    },
  };
  return { adapter, calls };
}

const hit = (email: string): FindEmailOutcome => ({
  status: 'hit',
  hit: { email, raw: { provider: 'fixture', accept_all: null, pattern: null } },
  costMicrousd: 10_000,
  latencyMs: 42,
});
const miss = (): FindEmailOutcome => ({ status: 'miss', costMicrousd: 0, latencyMs: 10, detail: 'no_match' });

function verifier(
  key: string,
  states: EmailVerificationState | EmailVerificationState[],
  options: { error?: string; costMicrousd?: number } = {},
): EmailVerificationProvider & { calls: number } {
  const queue = Array.isArray(states) ? [...states] : null;
  const handle = {
    key,
    domain: `api.${key}.io`,
    calls: 0,
    isConfigured: () => true,
    verify: async (): Promise<EmailVerificationProviderResult> => {
      handle.calls += 1;
      const state = queue ? (queue.length > 1 ? (queue.shift() as EmailVerificationState) : queue[0]) : states;
      const catchAll =
        state === 'CATCH_ALL_RISKY' ? ('catch_all' as const) : state === 'UNKNOWN' ? ('unknown' as const) : ('not_catch_all' as const);
      return {
        providerKey: key,
        state: state as EmailVerificationState,
        catchAll,
        catchAllClass: state === 'CATCH_ALL_RISKY' ? 'true_catch_all' : state === 'UNKNOWN' ? 'unknown' : 'not_catch_all',
        score: 0,
        acceptAll: state === 'CATCH_ALL_RISKY' ? true : false,
        disposable: null,
        role: null,
        detail: `fixture:${state}`,
        error: options.error ?? null,
        costMicrousd: options.error ? 0 : (options.costMicrousd ?? 1_000),
        latencyMs: 5,
      };
    },
  };
  return handle;
}

const INPUT = {
  workspaceId: WORKSPACE,
  contactId: CONTACT,
  fullName: 'Jürgen Müller',
  domain: 'acme.example',
  accountKey: 'acct-1',
  lawfulBasis: 'legitimate_interest',
};

function depsFor(
  db: ReturnType<typeof fakeDb>,
  finders: FinderHandle[],
  verifiers: EmailVerificationProvider[],
  overrides: Partial<EnrichContactDeps> = {},
): EnrichContactDeps {
  return {
    prisma: db.prisma as never,
    finders: finders.map((handle) => handle.adapter),
    verifiers,
    gate: async () => ({ ok: true }),
    mayUseExternalProcessing: async () => true,
    clock: () => NOW,
    ...overrides,
  };
}

describe('enrichContactEmail：命中 + 双正验证', () => {
  it('finder hit + 两票 VALID → 落库 VALID（事件账/状态/attempt 回填同事务）', async () => {
    const db = fakeDb();
    const hunter = finder('hunter', hit(PERSONAL_EMAIL));
    const result = await enrichContactEmail(
      depsFor(db, [hunter], [verifier('millionverifier', 'VALID'), verifier('emailable', 'VALID')]),
      INPUT,
    );
    expect(result).toMatchObject({
      status: 'stored',
      state: 'VALID',
      provider: 'hunter',
      pointId: 'point-1',
      finderAttempts: 1,
      costMicrousd: 12_000,
    });
    expect(db.pointUpserts[0]).toMatchObject({
      sourceType: 'provider',
      emailType: 'personal',
      legalBasis: 'legitimate_interest',
      status: 'UNVERIFIED',
    });
    expect(db.events).toHaveLength(2);
    expect(db.events[0]).toMatchObject({ providerKey: 'millionverifier', method: 'third_party_api', verdict: 'valid' });
    expect(db.pointUpdates[0]).toMatchObject({
      verificationState: 'VALID',
      status: 'VALID',
      verificationProvider: 'emailable',
      lastVerificationEventId: 'event-2',
    });
    expect(db.attemptCreates[0]).toMatchObject({ providerKey: 'hunter', outcome: 'hit', costMicrousd: 10_000n });
    expect(db.attemptUpdates[0]?.data).toEqual({ emailState: 'VALID' });
  });
});

describe('enrichContactEmail：停止规则', () => {
  it('验证 INVALID → 继续下一家 finder；UNKNOWN → 落库即停（不再买第三家）', async () => {
    const db = fakeDb();
    const hunter = finder('hunter', hit(PERSONAL_EMAIL));
    const findymail = finder('findymail', hit('h.mueller@acme.example'));
    const prospeo = finder('prospeo', hit('hm@acme.example'));
    const result = await enrichContactEmail(
      depsFor(db, [hunter, findymail, prospeo], [
        verifier('millionverifier', ['INVALID', 'UNKNOWN']),
        verifier('emailable', 'VALID'),
      ]),
      INPUT,
    );
    expect(result).toMatchObject({ status: 'stored', state: 'UNKNOWN', provider: 'findymail', finderAttempts: 2 });
    expect(prospeo.calls).toHaveLength(0);
    // 第一家 hit 的 attempt 回填 INVALID（进 scorecard），第二家回填 UNKNOWN。
    expect(db.attemptUpdates.map((update) => update.data.emailState)).toEqual(['INVALID', 'UNKNOWN']);
  });

  it('全部 miss → not_found；finder 尝试上限 3 家（第 4 家不调用）', async () => {
    const db = fakeDb();
    const handles = [
      finder('hunter', miss()),
      finder('findymail', miss()),
      finder('prospeo', miss()),
      finder('apollo', miss()),
    ];
    const result = await enrichContactEmail(depsFor(db, handles, [verifier('millionverifier', 'VALID')]), INPUT);
    expect(result).toMatchObject({ status: 'not_found', finderAttempts: 3, costMicrousd: 0 });
    expect(handles.map((handle) => handle.calls.length)).toEqual([1, 1, 1, 0]);
  });

  it('命中但验证 INVALID 且已是最后一家 → invalid_all', async () => {
    const db = fakeDb();
    const result = await enrichContactEmail(
      depsFor(db, [finder('hunter', hit(PERSONAL_EMAIL))], [verifier('millionverifier', 'INVALID')]),
      INPUT,
    );
    expect(result).toMatchObject({ status: 'invalid_all', finderAttempts: 1 });
    expect(db.pointUpserts).toHaveLength(0);
  });
});

describe('enrichContactEmail：预算与熔断', () => {
  it('预算不足 → skipped_budget（记尝试行、不调用）', async () => {
    const db = fakeDb();
    const hunter = finder('hunter', hit(PERSONAL_EMAIL));
    const result = await enrichContactEmail(
      depsFor(db, [hunter], [], { budget: new CapBudget(5_000) }),
      INPUT,
    );
    expect(result).toMatchObject({ status: 'skipped_budget', finderAttempts: 0, costMicrousd: 0 });
    expect(hunter.calls).toHaveLength(0);
    expect(db.attemptCreates[0]).toMatchObject({ outcome: 'skipped_budget' });
  });

  it('熔断 OPEN → 不调用并记 circuit_open；下一家正常继续', async () => {
    const db = fakeDb();
    const hunter = finder('hunter', hit(PERSONAL_EMAIL));
    const findymail = finder('findymail', hit(ROLE_EMAIL));
    const open: CircuitState = { ...emptyCircuitState(), status: 'OPEN', openedAt: NOW.toISOString() };
    const circuits = {
      load: vi.fn(async (key: string) => (key === 'hunter' ? open : emptyCircuitState())),
      save: vi.fn(async () => undefined),
    };
    const result = await enrichContactEmail(
      depsFor(db, [hunter, findymail], [verifier('millionverifier', 'VALID'), verifier('emailable', 'VALID')], { circuits }),
      INPUT,
    );
    expect(result).toMatchObject({ status: 'stored', provider: 'findymail', state: 'VALID' });
    expect(hunter.calls).toHaveLength(0);
    expect(db.attemptCreates[0]).toMatchObject({ providerKey: 'hunter', outcome: 'error', errorCode: 'circuit_open' });
    expect(circuits.save).toHaveBeenCalledWith('findymail', expect.objectContaining({ status: 'CLOSED' }));
  });
});

describe('enrichContactEmail：合规门与验证门', () => {
  it('联系人/公司被抑制 → skipped_compliance，不调用任何 finder、不落任何行', async () => {
    const db = fakeDb();
    const hunter = finder('hunter', hit(PERSONAL_EMAIL));
    const result = await enrichContactEmail(
      depsFor(db, [hunter], [], { mayUseExternalProcessing: async () => false }),
      INPUT,
    );
    expect(result).toMatchObject({ status: 'skipped_compliance', reason: 'suppressed_contact_or_company' });
    expect(hunter.calls).toHaveLength(0);
    expect(db.attemptCreates).toHaveLength(0);
  });

  it('data_provider 门未开 → 该家记 skipped_compliance 尝试行、继续下一家', async () => {
    const db = fakeDb();
    const hunter = finder('hunter', hit(PERSONAL_EMAIL));
    const findymail = finder('findymail', hit(ROLE_EMAIL));
    const result = await enrichContactEmail(
      depsFor(db, [hunter, findymail], [verifier('millionverifier', 'VALID'), verifier('emailable', 'VALID')], {
        gate: async (candidate) =>
          candidate.key === 'hunter' ? { ok: false, reason: 'data_provider.hunter 未启用' } : { ok: true },
      }),
      INPUT,
    );
    expect(result).toMatchObject({ status: 'stored', provider: 'findymail' });
    expect(hunter.calls).toHaveLength(0);
    expect(db.attemptCreates[0]).toMatchObject({
      providerKey: 'hunter',
      outcome: 'skipped_compliance',
      errorCode: 'provider_gate_closed',
    });
  });

  it('personal 邮箱无 lawful basis → 验证门拦截：不调验证器、落库 UNKNOWN + 24h 重验', async () => {
    const db = fakeDb();
    const mv = verifier('millionverifier', 'VALID');
    const { lawfulBasis: _omit, ...inputWithoutBasis } = INPUT;
    const result = await enrichContactEmail(
      depsFor(db, [finder('hunter', hit(PERSONAL_EMAIL))], [mv]),
      inputWithoutBasis,
    );
    expect(result).toMatchObject({ status: 'stored', state: 'UNKNOWN', note: 'personal_email_no_lawful_basis' });
    expect(mv.calls).toBe(0);
    expect(db.events).toHaveLength(0);
    expect(db.pointUpdates[0]).toMatchObject({
      verificationState: 'UNKNOWN',
      nextReverifyAt: new Date(NOW.getTime() + 24 * 3_600_000),
      confidence: 20,
    });
  });

  it('地址被抑制 → 不调验证器、落库 UNKNOWN（note=suppressed_email）', async () => {
    const db = fakeDb({ suppressionHit: true });
    const mv = verifier('millionverifier', 'VALID');
    const result = await enrichContactEmail(
      depsFor(db, [finder('hunter', hit(ROLE_EMAIL))], [mv]),
      INPUT,
    );
    expect(result).toMatchObject({ status: 'stored', state: 'UNKNOWN', note: 'suppressed_email' });
    expect(mv.calls).toBe(0);
  });

  it('无已配置验证器 → 落库 UNKNOWN（note=no_configured_verifiers），绝不冒充已验证', async () => {
    const db = fakeDb();
    const result = await enrichContactEmail(depsFor(db, [finder('hunter', hit(ROLE_EMAIL))], []), INPUT);
    expect(result).toMatchObject({ status: 'stored', state: 'UNKNOWN', note: 'no_configured_verifiers' });
    expect(db.events).toHaveLength(0);
    expect(db.attemptUpdates[0]?.data).toEqual({ emailState: 'UNKNOWN' });
  });
});

describe('enrichContactEmail：本地复用', () => {
  it('同输入版本的 90 天 hit → reused（不发请求、零成本）', async () => {
    const db = fakeDb({
      attempts: [
        {
          id: 'attempt-old',
          providerKey: 'hunter',
          requestHash: enrichmentRequestHash(CONTACT, 'hunter', {
            fullName: INPUT.fullName,
            domain: INPUT.domain,
          }),
          outcome: 'hit',
          errorCode: null,
          emailState: 'VALID',
          costMicrousd: 1_700n,
          attemptedAt: new Date(NOW.getTime() - 1_000),
        },
      ],
    });
    const hunter = finder('hunter', hit(PERSONAL_EMAIL));
    const result = await enrichContactEmail(
      depsFor(db, [hunter], [verifier('millionverifier', 'VALID')]),
      INPUT,
    );
    expect(result).toMatchObject({ status: 'reused', state: 'VALID', provider: 'hunter', costMicrousd: 0 });
    expect(hunter.calls).toHaveLength(0);
    expect(db.pointUpserts).toHaveLength(0);
  });

  it('无 finder → no_finders', async () => {
    const db = fakeDb();
    expect(await enrichContactEmail(depsFor(db, [], []), INPUT)).toEqual({ status: 'no_finders' });
  });
});
