import { describe, expect, it, vi, beforeEach } from 'vitest';

// resolveMx 走真实 DNS —— mock 掉让 verifyEmail 全路径可离线确定性测试（CI 纯单测无网络）。
vi.mock('node:dns/promises', () => ({ resolveMx: vi.fn() }));
import { resolveMx } from 'node:dns/promises';

import {
  classifyEmailProvider,
  isAccepted,
  isRejected,
  decideEmailVerdict,
  SelfHostedEmailVerifier,
  EmailVerifyBroker,
} from './email-verify.provider';
import type { SmtpProbeOutput } from '../../tools/builtin-tools';

const mockedMx = resolveMx as unknown as ReturnType<typeof vi.fn>;

describe('自建邮箱验证 · 纯逻辑（诚实上限）', () => {
  it('provider 分级：Gmail/M365/Proofpoint/Mimecast = 反枚举', () => {
    expect(classifyEmailProvider(['aspmx.l.google.com'])).toEqual({ provider: 'google_workspace', enumResistant: true });
    expect(classifyEmailProvider(['acme-com.mail.protection.outlook.com'])).toEqual({ provider: 'microsoft_365', enumResistant: true });
    expect(classifyEmailProvider(['mx.pphosted.com'])?.enumResistant).toBe(true);
    expect(classifyEmailProvider(['acme.mail.mimecast.com'])?.enumResistant).toBe(true);
    // 自建/其它 = 可探测
    expect(classifyEmailProvider(['mail.acme.de'])).toEqual({ provider: 'other_or_self_hosted', enumResistant: false });
  });

  it('SMTP 码判定：2xx 接受 / 5xx 拒收 / 其余不确定', () => {
    expect(isAccepted(250)).toBe(true);
    expect(isAccepted(550)).toBe(false);
    expect(isAccepted(null)).toBe(false);
    expect(isRejected(550)).toBe(true);
    expect(isRejected(450)).toBe(false); // 4xx 临时错，非拒收
    expect(isRejected(250)).toBe(false);
  });

  const base = { mxPresent: true, provider: 'other_or_self_hosted', enumResistant: false, smtpReachable: true, mailFromOk: true } as const;

  it('裁决：反枚举 provider 永不 VALID（即便 RCPT 250）', () => {
    const v = decideEmailVerdict({ ...base, provider: 'google_workspace', enumResistant: true, rcptCode: 250, catchAllStatus: 'not_catch_all' });
    expect(v.status).toBe('RISKY');
    expect(v.detail).toContain('anti_enumeration');
  });

  it('裁决：catch-all 域永不 VALID', () => {
    const v = decideEmailVerdict({ ...base, rcptCode: 250, catchAllStatus: 'catch_all' });
    expect(v.status).toBe('RISKY');
    expect(v.detail).toBe('catch_all_domain');
  });

  it('裁决：SMTP 不可达(端口25封) → RISKY 不谎报 INVALID', () => {
    const v = decideEmailVerdict({ ...base, smtpReachable: false, mailFromOk: false, rcptCode: null, catchAllStatus: 'inconclusive' });
    expect(v.status).toBe('RISKY');
    expect(v.detail).toContain('smtp_unreachable');
  });

  it('裁决：MAIL FROM 被拒 → RISKY 不判 mailbox INVALID', () => {
    const v = decideEmailVerdict({ ...base, mailFromOk: false, rcptCode: 550, catchAllStatus: 'not_catch_all' });
    expect(v.status).toBe('RISKY');
    expect(v.detail).toBe('mail_from_rejected');
  });

  it('裁决：唯一 VALID = 可达+MAIL FROM过+接受+catch-all已证伪+非反枚举', () => {
    expect(decideEmailVerdict({ ...base, rcptCode: 250, catchAllStatus: 'not_catch_all' }).status).toBe('VALID');
  });

  it('裁决：真实地址接受但 catch-all 未证伪(inconclusive) → RISKY（不谎报 VALID）', () => {
    const v = decideEmailVerdict({ ...base, rcptCode: 250, catchAllStatus: 'inconclusive' });
    expect(v.status).toBe('RISKY');
    expect(v.detail).toBe('catch_all_unproven');
  });

  it('裁决：RCPT 550 明确拒收(MAIL FROM 过) = INVALID', () => {
    expect(decideEmailVerdict({ ...base, rcptCode: 550, catchAllStatus: 'not_catch_all' }).status).toBe('INVALID');
  });

  it('裁决：无 MX = INVALID', () => {
    expect(decideEmailVerdict({ ...base, mxPresent: false, rcptCode: null, catchAllStatus: 'inconclusive' }).status).toBe('INVALID');
  });
});

// ── SMTP 出网经 ToolBroker 闸门 + source_policy 门（合规/安全关键） ──────────────
describe('自建邮箱验证 · ToolBroker 闸门 + source_policy', () => {
  const SELF_MX = [{ exchange: 'mail.acme.de', priority: 10 }];
  const okProbe: SmtpProbeOutput = { reachable: true, mailFromCode: 250, codes: [250, 550] }; // 真实 250 / 随机 550=非 catch-all

  function fakeBroker(opts: { suspend?: string[]; probe?: SmtpProbeOutput; throwName?: string } = {}) {
    const invoke = vi.fn(async () => {
      if (opts.throwName) {
        const e = new Error('broker denied');
        e.name = opts.throwName;
        throw e;
      }
      return { data: opts.probe ?? okProbe, costCents: 0 };
    });
    const sourcePolicy = vi.fn(async (d: string) => ({ suspended: (opts.suspend ?? []).includes(d) }));
    const broker = { invoke, sourcePolicy } as unknown as EmailVerifyBroker;
    return { broker, invoke, sourcePolicy };
  }

  beforeEach(() => {
    mockedMx.mockReset();
    mockedMx.mockResolvedValue(SELF_MX);
  });

  it('SUSPENDED 域名：触网前(MX/SMTP)即跳过 → RISKY，绝不 invoke 出网工具', async () => {
    const { broker, invoke } = fakeBroker({ suspend: ['acme.de'] });
    const r = await new SelfHostedEmailVerifier(broker).verifyEmail('a@acme.de', { workspaceId: 'w' });
    expect(r).toEqual({ status: 'RISKY', detail: 'source_policy_suspended', costCents: 0 });
    expect(invoke).not.toHaveBeenCalled();
    expect(mockedMx).not.toHaveBeenCalled(); // 连 MX 解析都不触发
  });

  it('SMTP 出网走 broker.invoke(smtp.rcpt_probe)，input.domain=邮箱域名（source_policy 以此为键）', async () => {
    const { broker, invoke } = fakeBroker();
    const r = await new SelfHostedEmailVerifier(broker).verifyEmail('user@acme.de', { workspaceId: 'w' });
    expect(invoke).toHaveBeenCalledTimes(1);
    const [toolId, input, ctx] = invoke.mock.calls[0];
    expect(toolId).toBe('smtp.rcpt_probe');
    expect(input).toMatchObject({ domain: 'acme.de', mxHost: 'mail.acme.de' });
    expect((input as { rcptTo: string[] }).rcptTo[0]).toBe('user@acme.de');
    expect((input as { rcptTo: string[] }).rcptTo).toHaveLength(2); // 真实 + 随机(catch-all 探测)
    expect(ctx).toMatchObject({ workspaceId: 'w' });
    expect(r.status).toBe('VALID'); // 可达+MAIL FROM过+250+catch-all 证伪
  });

  it('无 broker：不做原始 SMTP 出网 → RISKY smtp_gate_unavailable', async () => {
    const r = await new SelfHostedEmailVerifier().verifyEmail('user@acme.de', { workspaceId: 'w' });
    expect(r).toEqual({ status: 'RISKY', detail: 'smtp_gate_unavailable', costCents: 0 });
  });

  it('工具内 SSRF 护栏拦截(egressBlocked) → RISKY mx_egress_blocked，不谎报 INVALID', async () => {
    const { broker } = fakeBroker({ probe: { reachable: false, mailFromCode: null, codes: [], egressBlocked: 'private_ip:10.0.0.1' } });
    const r = await new SelfHostedEmailVerifier(broker).verifyEmail('user@acme.de', { workspaceId: 'w' });
    expect(r.status).toBe('RISKY');
    expect(r.detail).toBe('mx_egress_blocked:private_ip:10.0.0.1');
  });

  it('broker 拒绝(ToolPolicyDenied，SUSPENDED 竞态) → RISKY source_policy_denied，不回落原始出网', async () => {
    const { broker } = fakeBroker({ throwName: 'ToolPolicyDenied' });
    const r = await new SelfHostedEmailVerifier(broker).verifyEmail('user@acme.de', { workspaceId: 'w' });
    expect(r).toEqual({ status: 'RISKY', detail: 'source_policy_denied', costCents: 0 });
  });

  it('broker 其它错误(预算/限流兜底) → RISKY smtp_probe_failed', async () => {
    const { broker } = fakeBroker({ throwName: 'Error' });
    const r = await new SelfHostedEmailVerifier(broker).verifyEmail('user@acme.de', { workspaceId: 'w' });
    expect(r).toEqual({ status: 'RISKY', detail: 'smtp_probe_failed', costCents: 0 });
  });

  it('反枚举 provider(Gmail)：MX 后短路 RISKY，不 invoke 出网工具', async () => {
    mockedMx.mockResolvedValue([{ exchange: 'aspmx.l.google.com', priority: 10 }]);
    const { broker, invoke } = fakeBroker();
    const r = await new SelfHostedEmailVerifier(broker).verifyEmail('user@gmail.com', { workspaceId: 'w' });
    expect(r.status).toBe('RISKY');
    expect(r.detail).toContain('anti_enumeration');
    expect(invoke).not.toHaveBeenCalled();
  });
});
