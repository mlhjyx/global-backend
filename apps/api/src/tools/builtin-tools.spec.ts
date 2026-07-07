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
  it('已注册为 verify/email_verification，且 requiresSourcePolicy（受合规门约束）', () => {
    expect(smtpRcptProbeTool.id).toBe('smtp.rcpt_probe');
    expect(smtpRcptProbeTool.category).toBe('verify');
    expect(smtpRcptProbeTool.sourceClass).toBe('email_verification');
    expect(smtpRcptProbeTool.compliance.requiresSourcePolicy).toBe(true);
    expect(registerBuiltinTools(new ToolRegistry()).get('smtp.rcpt_probe')).toBeDefined();
  });

  it('SUSPENDED 域名：Broker 在 execute 前拒绝出网（source_policy 门，按 input.domain 判）', async () => {
    const b = broker(async (d) => ({ suspended: d === 'blocked.de' }));
    const input: SmtpProbeInput = { domain: 'blocked.de', mxHost: '127.0.0.1', rcptTo: ['a@blocked.de'] };
    await expect(b.invoke('smtp.rcpt_probe', input, { workspaceId: 'w' })).rejects.toThrow(ToolPolicyDenied);
    await expect(b.invoke('smtp.rcpt_probe', input, { workspaceId: 'w' })).rejects.toThrow(/SUSPENDED/);
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
