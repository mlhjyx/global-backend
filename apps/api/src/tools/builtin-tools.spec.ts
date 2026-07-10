import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './tool-registry';
import { registerBuiltinTools, smtpRcptProbeTool, SmtpProbeInput, SmtpProbeOutput } from './builtin-tools';
import { ToolBroker, ToolPolicyDenied } from './tool-broker';
import { BudgetLedger } from './budget';
import { RateLimiter } from './rate-limiter';

function broker(sourcePolicyReader?: (d: string) => Promise<{ suspended: boolean; allowedPurpose?: string[] } | null>) {
  const registry = registerBuiltinTools(new ToolRegistry());
  return new ToolBroker({
    registry,
    budget: new BudgetLedger(),
    limiter: new RateLimiter(),
    sourcePolicyReader,
    traceRecorder: () => {},
    now: () => 1_000_000,
  });
}

describe('smtp.rcpt_probe 工具 · 经 ToolBroker 闸门', () => {
  it('已注册为 verify/email_verification，sourcePolicy=advisory + personalData（登记即强制、标个人数据）', () => {
    expect(smtpRcptProbeTool.id).toBe('smtp.rcpt_probe');
    expect(smtpRcptProbeTool.category).toBe('verify');
    expect(smtpRcptProbeTool.sourceClass).toBe('email_verification');
    // advisory：标的=任意公司邮箱域，未登记放行（required 会杀死邮箱验证）；登记即强制 SUSPENDED/用途门
    expect(smtpRcptProbeTool.compliance.sourcePolicy).toBe('advisory');
    expect(smtpRcptProbeTool.compliance.personalData).toBe(true); // rcptTo 可含具名人邮箱
    expect(registerBuiltinTools(new ToolRegistry()).get('smtp.rcpt_probe')).toBeDefined();
  });

  it('SUSPENDED 域名：Broker 在 execute 前拒绝出网（source_policy 门，按 input.domain 判）', async () => {
    const b = broker(async (d) => ({ suspended: d === 'blocked.de' }));
    const input: SmtpProbeInput = { domain: 'blocked.de', mxHost: '127.0.0.1', rcptTo: ['a@blocked.de'] };
    await expect(b.invoke('smtp.rcpt_probe', input, { workspaceId: 'w' })).rejects.toThrow(ToolPolicyDenied);
    await expect(b.invoke('smtp.rcpt_probe', input, { workspaceId: 'w' })).rejects.toThrow(/SUSPENDED/);
  });

  it('用途门：域策略 allowedPurpose 与工具 [discovery,enrichment] 无交集 → execute 前拒绝', async () => {
    const b = broker(async () => ({ suspended: false, allowedPurpose: ['news_only'] }));
    const input: SmtpProbeInput = { domain: 'acme.de', mxHost: '127.0.0.1', rcptTo: ['a@acme.de'] };
    await expect(b.invoke('smtp.rcpt_probe', input, { workspaceId: 'w' })).rejects.toThrow(/purpose not allowed/);
  });

  it('用途门：域策略 allowedPurpose=[discovery] 与工具有交集 → 放行到 execute（不误拒）', async () => {
    const b = broker(async () => ({ suspended: false, allowedPurpose: ['discovery'] }));
    const input: SmtpProbeInput = { domain: 'acme.de', mxHost: '127.0.0.1', rcptTo: ['a@acme.de'] };
    const res = await b.invoke<SmtpProbeInput, SmtpProbeOutput>('smtp.rcpt_probe', input, { workspaceId: 'w' });
    expect(res.data.egressBlocked).toBe('ip_literal_not_allowed'); // 过了合规门，被 SSRF 护栏挡在真实出网前
  });

  it('非 SUSPENDED：工具内 SSRF 护栏拦截私网/IP 字面量 MX → egressBlocked，不发生出网', async () => {
    const b = broker(async () => null); // 无策略 = 放行到 execute
    const input: SmtpProbeInput = { domain: 'acme.de', mxHost: '127.0.0.1', rcptTo: ['user@acme.de'] };
    const res = await b.invoke<SmtpProbeInput, SmtpProbeOutput>('smtp.rcpt_probe', input, { workspaceId: 'w' });
    expect(res.data.reachable).toBe(false);
    expect(res.data.egressBlocked).toBe('ip_literal_not_allowed');
    expect(res.data.codes).toEqual([]);
  });
});
