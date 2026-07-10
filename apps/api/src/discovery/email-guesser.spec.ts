import { describe, expect, it } from 'vitest';
import { EmailGuesser } from './email-guesser';
import { generateEmailCandidates } from './email-permutation';
import { EmailVerdict, EmailVerificationAdapter } from './provider-contract';

/** 假 SMTP 验证器：按地址查表返回 verdict，记录被探测顺序。 */
function fakeVerifier(responder: (email: string) => EmailVerdict) {
  const calls: string[] = [];
  const adapter: EmailVerificationAdapter = {
    key: 'fake',
    verifyEmail: async (email: string) => {
      calls.push(email.toLowerCase());
      return responder(email.toLowerCase());
    },
  };
  return { adapter, calls };
}

const REJECT: EmailVerdict = { status: 'INVALID', detail: 'mailbox_rejected:550', costCents: 0 };
const LIA = { basis: 'legitimate_interest' as const, ref: 'LIA-1' };
const CTX = { lawfulBasis: LIA, nowIso: '2026-07-10T00:00:00.000Z' };

describe('EmailGuesser · 命中路径', () => {
  it('某候选 VALID → verified，命中即停', async () => {
    const { adapter, calls } = fakeVerifier((e) => (e === 'hans.herold@acme.de' ? { status: 'VALID', detail: 'smtp_accepted:250', costCents: 0 } : REJECT));
    const r = await new EmailGuesser(adapter).guess({ fullName: 'Hans Herold', domain: 'acme.de' }, CTX);
    expect(r.status).toBe('verified');
    expect(r.best?.email).toBe('hans.herold@acme.de');
    expect(r.best?.confidence).toBe(0.9);
    expect(r.triedCount).toBe(1); // 第一个候选即命中
    expect(calls).toEqual(['hans.herold@acme.de']);
  });

  it('格式学习候选排在最前且命中标 learned + 更高置信', async () => {
    const { adapter, calls } = fakeVerifier((e) => (e === 'h.herold@acme.de' ? { status: 'VALID', detail: 'ok', costCents: 0 } : REJECT));
    const r = await new EmailGuesser(adapter).guess(
      { fullName: 'Hans Herold', domain: 'acme.de', knownSamples: [{ fullName: 'Sabine Vogt', email: 's.vogt@acme.de' }] },
      CTX,
    );
    expect(r.status).toBe('verified');
    expect(r.best?.pattern).toBe('learned:f.last');
    expect(r.best?.confidence).toBe(0.95);
    expect(calls[0]).toBe('h.herold@acme.de'); // 学到的格式先探
  });
});

describe('EmailGuesser · 诚实降级（域级事实短路）', () => {
  it('catch-all → unverified + 最优先验猜测 + 低置信', async () => {
    const { adapter, calls } = fakeVerifier(() => ({ status: 'RISKY', detail: 'catch_all_domain', costCents: 0 }));
    const r = await new EmailGuesser(adapter).guess({ fullName: 'Hans Herold', domain: 'acme.de' }, CTX);
    expect(r.status).toBe('unverified');
    expect(r.domainFact).toBe('catch_all');
    expect(r.best?.email).toBe('hans.herold@acme.de');
    expect(r.best?.confidence).toBeLessThan(0.5);
    expect(calls).toHaveLength(1); // 一次即短路，不再扇出
  });

  it('反枚举 provider（Gmail/M365）→ unverified', async () => {
    const { adapter } = fakeVerifier(() => ({ status: 'RISKY', detail: 'provider_anti_enumeration:google_workspace', costCents: 0 }));
    const r = await new EmailGuesser(adapter).guess({ fullName: 'Hans Herold', domain: 'acme.de' }, CTX);
    expect(r.status).toBe('unverified');
    expect(r.domainFact).toBe('anti_enumeration');
  });

  it('MAIL FROM 被拒 → unreachable，一次即短路（不为每候选重复无效探测）', async () => {
    const { adapter, calls } = fakeVerifier(() => ({ status: 'RISKY', detail: 'mail_from_rejected', costCents: 0 }));
    const r = await new EmailGuesser(adapter).guess({ fullName: 'Hans Herold', domain: 'acme.de' }, CTX);
    expect(r.status).toBe('unverified');
    expect(r.domainFact).toBe('unreachable');
    expect(calls).toHaveLength(1); // 会话级事实，探一次即停
  });

  it('先 INVALID 拒收、后遇域级事实：最优猜测排除已证伪地址，且 verdict 与 email 同源（HIGH 回归）', async () => {
    const { adapter } = fakeVerifier((e) => {
      if (e === 'hans.herold@acme.de') return { status: 'INVALID', detail: 'mailbox_rejected:550', costCents: 0 }; // c0 已证实不存在
      if (e === 'h.herold@acme.de') return { status: 'RISKY', detail: 'catch_all_domain', costCents: 0 }; // c1 触发域级事实
      return REJECT;
    });
    const r = await new EmailGuesser(adapter).guess({ fullName: 'Hans Herold', domain: 'acme.de' }, CTX);
    expect(r.status).toBe('unverified');
    expect(r.domainFact).toBe('catch_all');
    expect(r.best?.email).toBe('h.herold@acme.de'); // 绝不把已被拒收的 hans.herold 当最优猜测
    expect(r.best?.verdict.detail).toBe('catch_all_domain'); // verdict 与 email 同源，不错位
    expect(r.triedCount).toBe(2);
  });

  it('无 MX → undeliverable_domain，无最优猜测', async () => {
    const { adapter } = fakeVerifier(() => ({ status: 'INVALID', detail: 'no_mx', costCents: 0 }));
    const r = await new EmailGuesser(adapter).guess({ fullName: 'Hans Herold', domain: 'acme.de' }, CTX);
    expect(r.status).toBe('undeliverable_domain');
    expect(r.best).toBeUndefined();
  });

  it('候选均被明确拒收 → exhausted', async () => {
    const { adapter, calls } = fakeVerifier(() => REJECT);
    const r = await new EmailGuesser(adapter).guess({ fullName: 'Hans Herold', domain: 'acme.de' }, CTX);
    expect(r.status).toBe('exhausted');
    expect(r.best).toBeUndefined();
    expect(calls.length).toBeGreaterThan(1); // 逐个试完
  });
});

describe('EmailGuesser · 合规红线', () => {
  it('人名邮箱无 lawful-basis 且未开开关 → BLOCKED，一个都不探测', async () => {
    const { adapter, calls } = fakeVerifier(() => REJECT);
    const r = await new EmailGuesser(adapter).guess(
      { fullName: 'Hans Herold', domain: 'acme.de' },
      { allowPersonalWithoutBasis: false },
    );
    expect(r.status).toBe('blocked');
    expect(r.triedCount).toBe(0);
    expect(calls).toHaveLength(0); // 门拦截 → 零 SMTP 出网
  });

  it('显式开关放行 → 允许探测', async () => {
    const { adapter, calls } = fakeVerifier((e) => (e === 'hans.herold@acme.de' ? { status: 'VALID', detail: 'ok', costCents: 0 } : REJECT));
    const r = await new EmailGuesser(adapter).guess(
      { fullName: 'Hans Herold', domain: 'acme.de' },
      { allowPersonalWithoutBasis: true },
    );
    expect(r.status).toBe('verified');
    expect(calls.length).toBeGreaterThan(0);
  });

  it('开关放行(无显式 basis)：门合成的 legitimate_interest 依据串回 result.lawfulBasis（HIGH 回归）', async () => {
    const { adapter } = fakeVerifier((e) => (e === 'hans.herold@acme.de' ? { status: 'VALID', detail: 'ok', costCents: 0 } : REJECT));
    const r = await new EmailGuesser(adapter).guess(
      { fullName: 'Hans Herold', domain: 'acme.de' },
      { allowPersonalWithoutBasis: true, actor: 'demo', nowIso: '2026-07-10T00:00:00.000Z' },
    );
    expect(r.status).toBe('verified');
    // 落库要用这条（否则 personal_data=true 却 lawful_basis=null），且已 stamp 断言人/时间
    expect(r.lawfulBasis).toMatchObject({ basis: 'legitimate_interest', recordedBy: 'demo', recordedAt: '2026-07-10T00:00:00.000Z' });
  });

  it('显式 basis 经 stamp 串回 result.lawfulBasis（含 who/when）', async () => {
    const { adapter } = fakeVerifier((e) => (e === 'hans.herold@acme.de' ? { status: 'VALID', detail: 'ok', costCents: 0 } : REJECT));
    const r = await new EmailGuesser(adapter).guess({ fullName: 'Hans Herold', domain: 'acme.de' }, { ...CTX, actor: 'demo' });
    expect(r.lawfulBasis).toMatchObject({ basis: 'legitimate_interest', ref: 'LIA-1', recordedBy: 'demo', recordedAt: '2026-07-10T00:00:00.000Z' });
  });

  it('BLOCKED（无 basis 无开关）：result.lawfulBasis 为空（未触网、无可留痕依据）', async () => {
    const { adapter } = fakeVerifier(() => REJECT);
    const r = await new EmailGuesser(adapter).guess({ fullName: 'Hans Herold', domain: 'acme.de' }, { allowPersonalWithoutBasis: false });
    expect(r.status).toBe('blocked');
    expect(r.lawfulBasis).toBeUndefined();
  });

  it('禁联候选跳过不探测', async () => {
    const { adapter, calls } = fakeVerifier((e) => (e === 'h.herold@acme.de' ? { status: 'VALID', detail: 'ok', costCents: 0 } : REJECT));
    const r = await new EmailGuesser(adapter).guess(
      { fullName: 'Hans Herold', domain: 'acme.de' },
      { ...CTX, suppressedEmails: new Set(['hans.herold@acme.de']) },
    );
    expect(calls).not.toContain('hans.herold@acme.de'); // 被禁联，跳过
    expect(r.best?.email).toBe('h.herold@acme.de');
  });
});

describe('EmailGuesser · 边界', () => {
  it('maxProbe 封顶扇出', async () => {
    const { adapter, calls } = fakeVerifier(() => REJECT);
    const r = await new EmailGuesser(adapter).guess({ fullName: 'Hans Herold', domain: 'acme.de' }, { ...CTX, maxProbe: 2 });
    expect(r.triedCount).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('候选全在禁联名单 → 一次未探，exhausted 标 all_candidates_suppressed（不谎称已探测拒收，MEDIUM 回归）', async () => {
    const all = new Set(generateEmailCandidates('Hans Herold', 'acme.de').map((c) => c.email.toLowerCase()));
    const { adapter, calls } = fakeVerifier(() => REJECT);
    const r = await new EmailGuesser(adapter).guess({ fullName: 'Hans Herold', domain: 'acme.de' }, { ...CTX, suppressedEmails: all });
    expect(r.status).toBe('exhausted');
    expect(r.reason).toBe('all_candidates_suppressed');
    expect(r.domainFact).toBe('suppressed');
    expect(r.triedCount).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('姓名/域无法生成候选 → no_candidates', async () => {
    const { adapter, calls } = fakeVerifier(() => REJECT);
    const r = await new EmailGuesser(adapter).guess({ fullName: '', domain: 'acme.de' }, CTX);
    expect(r.status).toBe('no_candidates');
    expect(calls).toHaveLength(0);
  });
});
