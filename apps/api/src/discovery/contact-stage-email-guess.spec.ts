import { afterEach, describe, expect, it, vi } from 'vitest';
import { guessEmailsForRunCompany } from './contact-stage-email-guess';
import { EmailGuesser, type GuessResult } from './email-guesser';
import type { EmailVerdict, EmailVerificationAdapter } from './provider-contract';
import { MAX_RUN_EMAIL_PROBES_PER_COMPANY } from '../execution-budget/contact-discovery-budget';
import { validateDomainAckRawIdentity } from '../durable-results/domain-ack';
import type { DurableExecutionReceipt } from '../durable-results/durable-execution-receipt';

/**
 * M3：run 联系人阶段内的自动邮箱补全（email_guess 双闸开启后的代码路径）。
 * 红线断言：
 *  - 自动路径**绝不**传 allowPersonalWithoutBasis；
 *  - 每公司 SMTP 探测 ≤ D5 的 6 次（跨联系人共享），与 MAX_EMAIL_PROBE_CANDIDATES（单次调用上界 8）一起收敛；
 *  - 未证实猜测只落 RISKY（allowedActions 无 outreach），绝不升 VALID；
 *  - 联系人级禁联在探测前拦（company/contact/email 三层）。
 */

const WS = '10000000-0000-4000-8000-000000000001';
const RUN_ID = '60000000-0000-4000-8000-000000000006';
const ACCOUNT_KEY = `discovery.run:discovery_run:request:${'a'.repeat(64)}:${'a'.repeat(64)}`;
const GLOBAL_LIA = { basis: 'legitimate_interest' as const, ref: 'OWNER-DECISION-2026-10-11' };
const SMTP_RECEIPT = Object.freeze({
  schemaVersion: 'durable-execution-receipt/v1',
  scopeKey: WS,
  authorityId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  operationId: '33333333-3333-4333-8333-333333333333',
  operationKey: 'run-smtp-receipt',
  resultStrategy: 'typed_projection',
  resultSchema: 'smtp-rcpt-probe/v1',
  resultDigest: 'a'.repeat(64),
  artifactId: null,
  usage: {
    currency: 'USD',
    unit: 'microusd',
    callCount: 1,
    upperBoundMicrousd: '0',
  },
  costBasis: 'estimated_upper_bound',
}) satisfies DurableExecutionReceipt;

const ackMock = vi.hoisted(() => vi.fn(async (input: {
  transaction: unknown;
  apply: (transaction: unknown) => Promise<unknown>;
  readback: (transaction: unknown) => Promise<unknown>;
  acknowledgements: Array<{ producerId: string }>;
}) => ({
  status: 'APPLIED',
  acknowledgements: input.acknowledgements.map(({ producerId }) => ({
    producerId,
    status: 'APPLIED',
  })),
  value: await input.apply(input.transaction),
})));

vi.mock('../durable-results/domain-ack-consumer-bindings', () => ({
  applyDomainAckConsumerTransactions: ackMock,
}));

interface FakePoint {
  type: string;
  value: string;
  status: string;
}
interface FakeContact {
  id: string;
  fullName: string;
  contactPoints: FakePoint[];
}

function makeDeps(opts?: {
  suppressionRows?: { type: string; value: string }[];
  contactAllowed?: boolean;
  contactAllowedAfterProbe?: (email: string) => boolean;
}) {
  const upsertedPoints: { contactId: string; value: string; status: string }[] = [];
  const evidence: Array<{ field: string; allowedActions: unknown; status?: string }> = [];
  const contactById = new Map<string, FakeContact>();
  const tx = {
    suppressionRecord: {
      findMany: async () => opts?.suppressionRows ?? [],
    },
    canonicalContact: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const contact = contactById.get(where.id);
        if (!contact) return null;
        return {
          ...contact,
          company: {
            id: 'c1',
            name: 'Acme',
            domain: 'acme.de',
            status: 'NEW',
            dedupeKey: 'acme.de',
            attributes: {},
          },
        };
      },
    },
    contactPoint: {
      upsert: async ({
        where,
        create,
      }: {
        where: { contactId_type_value: { contactId: string; value: string } };
        create: { value: string; status: string };
      }) => {
        upsertedPoints.push({
          contactId: where.contactId_type_value.contactId,
          value: create.value,
          status: create.status,
        });
        return {};
      },
      findUnique: async ({
        where,
      }: {
        where: { contactId_type_value: { contactId: string; value: string } };
      }) => {
        const row = upsertedPoints
          .filter(
            (point) =>
              point.contactId === where.contactId_type_value.contactId &&
              point.value === where.contactId_type_value.value,
          )
          .at(-1);
        return row ? { status: row.status } : null;
      },
    },
    fieldEvidence: {
      create: async ({ data }: { data: { field: string; allowedActions: unknown; value?: { status?: string } } }) => {
        evidence.push({
          field: data.field,
          allowedActions: data.allowedActions,
          status: (data.value as { status?: string } | undefined)?.status,
        });
        return {};
      },
    },
    $queryRaw: async () => [
      { id: 'c1', name: 'Acme', domain: 'acme.de', status: 'NEW' },
    ],
  };
  const prisma = {
    withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      // contactMayUseExternalProcessing gates every contact/candidate before a probe.
      const wired = {
        ...tx,
        canonicalContact: {
          findUnique: async (args: { where: { id: string } }) => {
            if (opts?.contactAllowed === false) return null;
            return tx.canonicalContact.findUnique(args);
          },
        },
      };
      return fn(wired);
    },
  };
  return { deps: { prisma }, upsertedPoints, evidence, contactById };
}

function contact(id: string, fullName: string, contactPoints: FakePoint[] = []): FakeContact {
  return { id, fullName, contactPoints };
}

/** RISKY catch-all verdict: the guesser must keep it RISKY (never VALID). */
const RISKY_VERDICT: EmailVerdict = {
  status: 'RISKY',
  detail: 'catch_all_domain',
  costCents: 0,
};
const INVALID_VERDICT: EmailVerdict = {
  status: 'INVALID',
  detail: 'mailbox_rejected:550',
  costCents: 0,
};
const VALID_VERDICT: EmailVerdict = {
  status: 'VALID',
  detail: 'smtp_accepted:250',
  costCents: 0,
};

function verifierReturning(verdicts: EmailVerdict | ((email: string) => EmailVerdict)) {
  const calls: string[] = [];
  const adapter: EmailVerificationAdapter = {
    key: 'smtp_self',
    verifyEmail: vi.fn(async (email: string, _ctx?: unknown): Promise<EmailVerdict> => {
      calls.push(email);
      return typeof verdicts === 'function' ? verdicts(email) : verdicts;
    }),
  };
  return { adapter, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('guessEmailsForRunCompany —— M3 自动补全的双闸与红线', () => {
  it('对缺邮箱的联系人按每公司 ≤6 次探测（跨联系人共享），剩余额度为 0 即停', async () => {
    const { deps, contactById } = makeDeps();
    contactById.set('ct1', contact('ct1', 'Hans Herold'));
    contactById.set('ct2', contact('ct2', 'Sabine Vogt'));
    const { adapter, calls } = verifierReturning(INVALID_VERDICT);

    const result = await guessEmailsForRunCompany(
      deps as never,
      {
        workspaceId: WS,
        runId: RUN_ID,
        accountKey: ACCOUNT_KEY,
        companyId: 'c1',
        domain: 'acme.de',
        contacts: [
          contact('ct1', 'Hans Herold'),
          contact('ct2', 'Sabine Vogt'),
        ],
        lawfulBasis: GLOBAL_LIA,
        maxProbes: MAX_RUN_EMAIL_PROBES_PER_COMPANY,
        verifier: adapter,
      },
    );

    // 第一名联系人用尽 6 次共享额度 → 第二名不再探测。
    expect(calls).toHaveLength(MAX_RUN_EMAIL_PROBES_PER_COMPANY);
    expect(result.probes).toBe(MAX_RUN_EMAIL_PROBES_PER_COMPANY);
    expect(result.attempted).toBe(1);
    expect(result.emaillessContacts).toBe(2);
  });

  it('调用方传入更大的探测额度也不会突破每公司 6 次', async () => {
    const { deps, contactById } = makeDeps();
    contactById.set('ct1', contact('ct1', 'Hans Herold'));
    const { adapter, calls } = verifierReturning(INVALID_VERDICT);

    const result = await guessEmailsForRunCompany(
      deps as never,
      {
        workspaceId: WS,
        runId: RUN_ID,
        accountKey: ACCOUNT_KEY,
        companyId: 'c1',
        domain: 'acme.de',
        contacts: [contact('ct1', 'Hans Herold')],
        lawfulBasis: GLOBAL_LIA,
        maxProbes: 99,
        verifier: adapter,
      },
    );

    expect(calls.length).toBeLessThanOrEqual(MAX_RUN_EMAIL_PROBES_PER_COMPANY);
    expect(result.probes).toBe(calls.length);
  });

  it('未证实猜测落 RISKY（allowedActions 无 outreach），绝不升 VALID', async () => {
    const { deps, contactById, upsertedPoints, evidence } = makeDeps();
    contactById.set('ct1', contact('ct1', 'Hans Herold'));
    const { adapter } = verifierReturning(RISKY_VERDICT);

    const result = await guessEmailsForRunCompany(
      deps as never,
      {
        workspaceId: WS,
        runId: RUN_ID,
        accountKey: ACCOUNT_KEY,
        companyId: 'c1',
        domain: 'acme.de',
        contacts: [contact('ct1', 'Hans Herold')],
        lawfulBasis: GLOBAL_LIA,
        maxProbes: MAX_RUN_EMAIL_PROBES_PER_COMPANY,
        verifier: adapter,
      },
    );

    expect(upsertedPoints).toHaveLength(1);
    expect(upsertedPoints[0]!.status).toBe('RISKY');
    const guessEvidence = evidence.find((row) => row.field === 'email.guess');
    expect(guessEvidence?.status).toBe('RISKY');
    expect(guessEvidence?.allowedActions).toEqual(['display', 'match']);
    expect(result.persisted).toBe(1);
    expect(result.risky).toBe(1);
    expect(result.verified).toBe(0);
  });

  it('SMTP 明确证实（VALID）时才落 VALID 且允许 outreach', async () => {
    const { deps, contactById, upsertedPoints, evidence } = makeDeps();
    contactById.set('ct1', contact('ct1', 'Hans Herold'));
    const { adapter } = verifierReturning(VALID_VERDICT);

    const result = await guessEmailsForRunCompany(
      deps as never,
      {
        workspaceId: WS,
        runId: RUN_ID,
        accountKey: ACCOUNT_KEY,
        companyId: 'c1',
        domain: 'acme.de',
        contacts: [contact('ct1', 'Hans Herold')],
        lawfulBasis: GLOBAL_LIA,
        maxProbes: MAX_RUN_EMAIL_PROBES_PER_COMPANY,
        verifier: adapter,
      },
    );

    expect(upsertedPoints[0]!.status).toBe('VALID');
    const guessEvidence = evidence.find((row) => row.field === 'email.guess');
    expect(guessEvidence?.allowedActions).toEqual(['display', 'match', 'outreach']);
    expect(result.verified).toBe(1);
    expect(result.risky).toBe(0);
  });

  it('🔴 自动路径绝不含 allowPersonalWithoutBasis，lawfulBasis 用全局 interim，actor 可审计', async () => {
    const { deps, contactById } = makeDeps();
    contactById.set('ct1', contact('ct1', 'Hans Herold'));
    const guessSpy = vi.spyOn(EmailGuesser.prototype, 'guess').mockResolvedValue({
      status: 'no_candidates',
      triedCount: 0,
      candidates: [],
      reason: 'test',
    } as GuessResult);

    await guessEmailsForRunCompany(
      deps as never,
      {
        workspaceId: WS,
        runId: RUN_ID,
        accountKey: ACCOUNT_KEY,
        companyId: 'c1',
        domain: 'acme.de',
        contacts: [contact('ct1', 'Hans Herold')],
        lawfulBasis: GLOBAL_LIA,
        maxProbes: MAX_RUN_EMAIL_PROBES_PER_COMPANY,
        verifier: verifierReturning(RISKY_VERDICT).adapter,
      },
    );

    const ctx = guessSpy.mock.calls[0]?.[1];
    expect(ctx?.allowPersonalWithoutBasis).toBeUndefined();
    expect(ctx?.lawfulBasis).toEqual(GLOBAL_LIA);
    expect(ctx?.workspaceId).toBe(WS);
    expect(ctx?.runId).toBe(ACCOUNT_KEY);
    expect(ctx?.actor).toBe(`discovery-run:${RUN_ID}`);
  });

  it('联系人级禁联（company/contact/email 门）在探测前拦截', async () => {
    const { deps, contactById } = makeDeps({ contactAllowed: false });
    contactById.set('ct1', contact('ct1', 'Hans Herold'));
    const { adapter, calls } = verifierReturning(INVALID_VERDICT);

    const result = await guessEmailsForRunCompany(
      deps as never,
      {
        workspaceId: WS,
        runId: RUN_ID,
        accountKey: ACCOUNT_KEY,
        companyId: 'c1',
        domain: 'acme.de',
        contacts: [contact('ct1', 'Hans Herold')],
        lawfulBasis: GLOBAL_LIA,
        maxProbes: MAX_RUN_EMAIL_PROBES_PER_COMPANY,
        verifier: adapter,
      },
    );

    expect(calls).toHaveLength(0);
    expect(result.blocked).toBe(1);
    expect(result.probes).toBe(0);
  });

  it('SMTP 回执的 domainAckKey 通过 domain-ack 身份校验（原始键不得含 PII 提示词）', async () => {
    const { deps, contactById } = makeDeps();
    contactById.set('ct1', contact('ct1', 'Hans Herold'));
    vi.spyOn(EmailGuesser.prototype, 'guess').mockImplementation(async (_input, ctx) => {
      ctx?.onDurableReceipt?.('smtp.rcpt_probe', SMTP_RECEIPT);
      return {
        status: 'unverified',
        best: {
          email: 'hans.herold@acme.de',
          pattern: 'first.last',
          prior: 0.5,
          verdict: RISKY_VERDICT,
          confidence: 0.2,
        },
        triedCount: 1,
        candidates: [],
        reason: 'no_valid_best_effort_risky',
      } as GuessResult;
    });
    ackMock.mockClear();

    await guessEmailsForRunCompany(
      deps as never,
      {
        workspaceId: WS,
        runId: RUN_ID,
        accountKey: ACCOUNT_KEY,
        companyId: 'c1',
        domain: 'acme.de',
        contacts: [contact('ct1', 'Hans Herold')],
        lawfulBasis: GLOBAL_LIA,
        maxProbes: MAX_RUN_EMAIL_PROBES_PER_COMPANY,
        verifier: verifierReturning(RISKY_VERDICT).adapter,
      },
    );

    const rawKey = (ackMock.mock.calls[0]![0] as {
      acknowledgements: Array<{ domainAckKey: string }>;
    }).acknowledgements[0]!.domainAckKey;
    // 生产实现会把原始键过 opaqueDomainIdentity → validateDomainAckRawIdentity；
    // 键里出现 email/phone/@/token 等提示词会直接 invalid。
    expect(() => validateDomainAckRawIdentity(rawKey)).not.toThrow();
  });

  it('SMTP 回执生产者异常 → 抛 DOMAIN_ACK_CONSUMER_BINDING_MISSING（不静默吞）', async () => {
    const { deps, contactById } = makeDeps();
    contactById.set('ct1', contact('ct1', 'Hans Herold'));
    vi.spyOn(EmailGuesser.prototype, 'guess').mockImplementation(async (_input, ctx) => {
      ctx?.onDurableReceipt?.('unexpected.tool', SMTP_RECEIPT);
      return {
        status: 'unverified',
        best: {
          email: 'hans.herold@acme.de',
          pattern: 'first.last',
          prior: 0.5,
          verdict: RISKY_VERDICT,
          confidence: 0.2,
        },
        triedCount: 1,
        candidates: [],
        reason: 'no_valid_best_effort_risky',
      } as GuessResult;
    });

    await expect(
      guessEmailsForRunCompany(
        deps as never,
        {
          workspaceId: WS,
          runId: RUN_ID,
          accountKey: ACCOUNT_KEY,
          companyId: 'c1',
          domain: 'acme.de',
          contacts: [contact('ct1', 'Hans Herold')],
          lawfulBasis: GLOBAL_LIA,
          maxProbes: MAX_RUN_EMAIL_PROBES_PER_COMPANY,
          verifier: verifierReturning(RISKY_VERDICT).adapter,
        },
      ),
    ).rejects.toThrow('DOMAIN_ACK_CONSUMER_BINDING_MISSING');
  });

  it('已有邮箱的联系人不进补全目标；无可补全目标时零探测', async () => {
    const { deps, contactById } = makeDeps();
    contactById.set(
      'ct1',
      contact('ct1', 'Hans Herold', [
        { type: 'email', value: 'h.herold@acme.de', status: 'VALID' },
      ]),
    );
    const { adapter, calls } = verifierReturning(INVALID_VERDICT);

    const result = await guessEmailsForRunCompany(
      deps as never,
      {
        workspaceId: WS,
        runId: RUN_ID,
        accountKey: ACCOUNT_KEY,
        companyId: 'c1',
        domain: 'acme.de',
        contacts: [
          contact('ct1', 'Hans Herold', [
            { type: 'email', value: 'h.herold@acme.de', status: 'VALID' },
          ]),
        ],
        lawfulBasis: GLOBAL_LIA,
        maxProbes: MAX_RUN_EMAIL_PROBES_PER_COMPANY,
        verifier: adapter,
      },
    );

    expect(calls).toHaveLength(0);
    expect(result.attempted).toBe(0);
    expect(result.emaillessContacts).toBe(0);
  });
});
