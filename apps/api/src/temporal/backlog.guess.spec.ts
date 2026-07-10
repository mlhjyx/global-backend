import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBacklogActivities, parseConfiguredLawfulBasis } from './backlog.activities';
import { EmailGuesser, GuessResult } from '../discovery/email-guesser';
import type { EmailVerificationAdapter } from '../discovery/provider-contract';

/**
 * 存量邮箱猜测活动（选项 B · P0.4，阶段⑤b）单测：**双闸合规门**（kill-switch + config.lawfulBasis）、
 * 缺邮箱决策人补全、水位 stamp-all、DAT-011 跳过，以及**红线**——自动路径 guess ctx **绝不**含
 * allowPersonalWithoutBasis。用注入的假 ownerDb/prisma/providers + spy 掉 EmailGuesser.prototype.guess
 * （不触真 SMTP），落库走真实 persistGuessedEmail（复用纯件，验证 RISKY 落库形态）。
 */

const WS = 'ws-1';
const ICP = 'icp-1';
const GLOBAL_LIA = { basis: 'legitimate_interest', ref: 'GLOBAL-LIA-interim' };

interface FakeContactPoint {
  type: string;
  value: string;
  status: string;
}
interface FakeContact {
  id: string;
  companyId: string;
  fullName: string;
  contactPoints: FakeContactPoint[];
}
interface FakeCompany {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  dedupeKey: string;
}

const COMPANY: FakeCompany = { id: 'c1', name: 'Acme', domain: 'acme.de', country: 'DE', dedupeKey: 'acme.de' };
const CONTACT: FakeContact = { id: 'ct1', companyId: 'c1', fullName: 'Hans Herold', contactPoints: [] };

/** 一个未证实（RISKY）猜测结果：guessedEmailWritePlan 会落库为 RISKY（allowedActions 无 outreach）。 */
const RISKY_GUESS: GuessResult = {
  status: 'unverified',
  best: {
    email: 'hans.herold@acme.de',
    pattern: 'first.last',
    prior: 0.5,
    verdict: { status: 'RISKY', detail: 'catch_all_domain', costCents: 0 },
    confidence: 0.2,
  },
  domainFact: 'catch_all',
  triedCount: 1,
  candidates: [],
  reason: 'catch_all_domain_unconfirmable',
};

function makeDeps(opts: {
  providerRow: { config: unknown } | null;
  companies: FakeCompany[];
  contacts: FakeContact[];
  suspendedDomains?: string[];
  noVerifier?: boolean;
}) {
  const updateManyCalls: { ids: string[]; data: Record<string, unknown> }[] = [];
  const upsertedPoints: { contactId: string; value: string; status: string }[] = [];
  const verifier: EmailVerificationAdapter = { key: 'fake', verifyEmail: async () => ({ status: 'RISKY', costCents: 0 }) };

  const tx = {
    canonicalCompany: {
      findMany: async ({ take }: { take?: number }) =>
        (take != null ? opts.companies.slice(0, take) : opts.companies).map((c) => ({ ...c })),
      updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Record<string, unknown> }) => {
        updateManyCalls.push({ ids: where.id.in, data });
        return { count: where.id.in.length };
      },
    },
    canonicalContact: {
      findMany: async ({ where }: { where: { companyId: { in: string[] } } }) =>
        opts.contacts
          .filter((c) => where.companyId.in.includes(c.companyId))
          .map((c) => ({ ...c, contactPoints: c.contactPoints.map((p) => ({ ...p })) })),
    },
    suppressionRecord: { findMany: async () => [] as { value: string }[] },
    // persistGuessedEmail（真实）在落库短事务里用到 contactPoint.upsert + fieldEvidence.create。
    contactPoint: {
      upsert: async ({
        where,
        create,
      }: {
        where: { contactId_type_value: { contactId: string } };
        create: { value: string; status: string };
      }) => {
        upsertedPoints.push({ contactId: where.contactId_type_value.contactId, value: create.value, status: create.status });
        return {};
      },
    },
    fieldEvidence: { create: async () => ({}) },
  };

  const prisma = {
    withWorkspace: async <T>(_ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn(tx),
    sourcePolicy: { findMany: async () => (opts.suspendedDomains ?? []).map((d) => ({ domain: d })) },
  };
  const providers = { routeEmailVerification: async () => (opts.noVerifier ? [] : [verifier]) };
  const ownerDb = { dataProvider: { findFirst: async () => opts.providerRow } };
  const deps = { prisma, providers, gateway: {}, ownerDb } as unknown as Parameters<typeof createBacklogActivities>[0];
  return { deps, updateManyCalls, upsertedPoints };
}

afterEach(() => vi.restoreAllMocks());

describe('parseConfiguredLawfulBasis（config.lawfulBasis 解析）', () => {
  it('合法 basis → {basis,ref,note}；note 缺省不带', () => {
    expect(parseConfiguredLawfulBasis({ lawfulBasis: { basis: 'consent', ref: 'R', note: 'N' } })).toEqual({
      basis: 'consent',
      ref: 'R',
      note: 'N',
    });
    expect(parseConfiguredLawfulBasis({ lawfulBasis: { basis: 'contract' } })).toEqual({ basis: 'contract' });
  });

  it('缺 lawfulBasis / 非法 basis / 非对象 → undefined（自动路径一个都不探）', () => {
    expect(parseConfiguredLawfulBasis(null)).toBeUndefined();
    expect(parseConfiguredLawfulBasis({})).toBeUndefined();
    expect(parseConfiguredLawfulBasis({ lawfulBasis: { basis: 'bogus' } })).toBeUndefined();
    expect(parseConfiguredLawfulBasis({ lawfulBasis: null })).toBeUndefined();
    expect(parseConfiguredLawfulBasis('x')).toBeUndefined();
  });
});

describe('guessEmailsBacklog — 双闸合规门 + 补全 + 水位 + 红线', () => {
  it('① kill-switch DISABLED（无 ENABLED email_guess 行）→ skipped，零探测零 stamp', async () => {
    const guessSpy = vi.spyOn(EmailGuesser.prototype, 'guess').mockResolvedValue(RISKY_GUESS);
    const { deps, updateManyCalls } = makeDeps({ providerRow: null, companies: [COMPANY], contacts: [CONTACT] });
    const r = await createBacklogActivities(deps).guessEmailsBacklog({ workspaceId: WS, icpId: ICP });
    expect(r).toEqual({ scanned: 0, attempted: 0, guessed: 0, skipped: true, reason: 'kill_switch_disabled', nextCursor: null });
    expect(guessSpy).not.toHaveBeenCalled();
    expect(updateManyCalls).toHaveLength(0);
  });

  it('② config 无 lawfulBasis → skipped no_lawful_basis_configured（红线可证伪）', async () => {
    const guessSpy = vi.spyOn(EmailGuesser.prototype, 'guess').mockResolvedValue(RISKY_GUESS);
    const { deps, updateManyCalls } = makeDeps({ providerRow: { config: {} }, companies: [COMPANY], contacts: [CONTACT] });
    const r = await createBacklogActivities(deps).guessEmailsBacklog({ workspaceId: WS, icpId: ICP });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no_lawful_basis_configured');
    expect(guessSpy).not.toHaveBeenCalled();
    expect(updateManyCalls).toHaveLength(0);
  });

  it('②b 双闸过但无验证器（routeEmailVerification 空）→ skipped no_verifier，零触网且**不误 stamp**（防饿死）', async () => {
    const guessSpy = vi.spyOn(EmailGuesser.prototype, 'guess').mockResolvedValue(RISKY_GUESS);
    const { deps, updateManyCalls } = makeDeps({
      providerRow: { config: { lawfulBasis: GLOBAL_LIA } },
      companies: [COMPANY],
      contacts: [CONTACT],
      noVerifier: true,
    });
    const r = await createBacklogActivities(deps).guessEmailsBacklog({ workspaceId: WS, icpId: ICP });
    expect(r.skipped).toBe(true);
    expect(r.reason).toBe('no_verifier');
    expect(guessSpy).not.toHaveBeenCalled();
    // 🔴 无验证器时**不 stamp 水位**——否则会把够不到验证器的公司误标已处理、TTL 内饿死。
    expect(updateManyCalls).toHaveLength(0);
  });

  it('③ 双闸过 → 对缺邮箱决策人调 guesser 且 persist（RISKY 落库）', async () => {
    const guessSpy = vi.spyOn(EmailGuesser.prototype, 'guess').mockResolvedValue(RISKY_GUESS);
    const { deps, upsertedPoints } = makeDeps({
      providerRow: { config: { lawfulBasis: GLOBAL_LIA } },
      companies: [COMPANY],
      contacts: [CONTACT],
    });
    const r = await createBacklogActivities(deps).guessEmailsBacklog({ workspaceId: WS, icpId: ICP });
    expect(guessSpy).toHaveBeenCalledTimes(1);
    expect(guessSpy.mock.calls[0][0]).toEqual({ fullName: 'Hans Herold', domain: 'acme.de', knownSamples: [] });
    expect(r.scanned).toBe(1);
    expect(r.attempted).toBe(1);
    expect(r.guessed).toBe(1);
    expect(r.skipped).toBeUndefined();
    // RISKY 未证实猜测落库（persistGuessedEmail 保证 allowedActions 无 outreach）。
    expect(upsertedPoints).toEqual([{ contactId: 'ct1', value: 'hans.herold@acme.de', status: 'RISKY' }]);
  });

  it('④ 水位 stamp-all：本批全部扫到公司写 emailGuessAttemptedAt', async () => {
    vi.spyOn(EmailGuesser.prototype, 'guess').mockResolvedValue(RISKY_GUESS);
    const { deps, updateManyCalls } = makeDeps({
      providerRow: { config: { lawfulBasis: GLOBAL_LIA } },
      companies: [COMPANY],
      contacts: [CONTACT],
    });
    await createBacklogActivities(deps).guessEmailsBacklog({ workspaceId: WS, icpId: ICP });
    expect(updateManyCalls).toHaveLength(1);
    expect(updateManyCalls[0].ids).toEqual(['c1']);
    expect(updateManyCalls[0].data.emailGuessAttemptedAt).toBeInstanceOf(Date);
  });

  it('⑤ 🔴 自动路径 guess ctx 不含 allowPersonalWithoutBasis（红线：绝不捅穿），用 config 的 LIA + actor=backlog', async () => {
    const guessSpy = vi.spyOn(EmailGuesser.prototype, 'guess').mockResolvedValue(RISKY_GUESS);
    const { deps } = makeDeps({
      providerRow: { config: { lawfulBasis: GLOBAL_LIA } },
      companies: [COMPANY],
      contacts: [CONTACT],
    });
    await createBacklogActivities(deps).guessEmailsBacklog({ workspaceId: WS, icpId: ICP });
    const ctx = guessSpy.mock.calls[0][1];
    expect(ctx?.allowPersonalWithoutBasis).toBeUndefined();
    expect(ctx?.actor).toBe('backlog');
    expect(ctx?.lawfulBasis).toEqual(GLOBAL_LIA);
    expect(ctx?.workspaceId).toBe(WS);
  });

  it('DAT-011：SUSPENDED 域跳过（不 guess）但仍 stamp（30d TTL 防每 sweep 重锤 MX）', async () => {
    const guessSpy = vi.spyOn(EmailGuesser.prototype, 'guess').mockResolvedValue(RISKY_GUESS);
    const { deps, updateManyCalls } = makeDeps({
      providerRow: { config: { lawfulBasis: GLOBAL_LIA } },
      companies: [COMPANY],
      contacts: [CONTACT],
      suspendedDomains: ['acme.de'],
    });
    const r = await createBacklogActivities(deps).guessEmailsBacklog({ workspaceId: WS, icpId: ICP });
    expect(guessSpy).not.toHaveBeenCalled();
    expect(r.attempted).toBe(0);
    expect(r.guessed).toBe(0);
    expect(updateManyCalls[0].ids).toEqual(['c1']); // 仍 stamp（离开当批过滤集）
  });

  it('只对缺 email 决策人补全：已有 email point 的人不进 guess 目标', async () => {
    const guessSpy = vi.spyOn(EmailGuesser.prototype, 'guess').mockResolvedValue(RISKY_GUESS);
    const withEmail: FakeContact = {
      id: 'ct2',
      companyId: 'c1',
      fullName: 'Sabine Vogt',
      contactPoints: [{ type: 'email', value: 's.vogt@acme.de', status: 'VALID' }],
    };
    const { deps } = makeDeps({
      providerRow: { config: { lawfulBasis: GLOBAL_LIA } },
      companies: [COMPANY],
      contacts: [CONTACT, withEmail],
    });
    await createBacklogActivities(deps).guessEmailsBacklog({ workspaceId: WS, icpId: ICP });
    // 仅 ct1（缺邮箱）被 guess；ct2 已有 email 不补。且同域非-RISKY 邮箱作格式学习样本传入。
    expect(guessSpy).toHaveBeenCalledTimes(1);
    expect(guessSpy.mock.calls[0][0]).toEqual({
      fullName: 'Hans Herold',
      domain: 'acme.de',
      knownSamples: [{ fullName: 'Sabine Vogt', email: 's.vogt@acme.de' }],
    });
  });
});
