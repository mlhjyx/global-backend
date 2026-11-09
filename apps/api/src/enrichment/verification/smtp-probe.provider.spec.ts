import { describe, expect, it } from 'vitest';
import { ExecutionControlError } from '../../execution-budget/execution-control-error';
import {
  BudgetAccountUnavailableError,
  BudgetExceededError,
  BudgetStoreUnavailableError,
} from '../../tools/budget-store';
import type { SmtpProbeInput, SmtpProbeOutput } from '../../tools/builtin-tools';
import type { ExecutionBroker, SourcePolicyDenyReason, ToolContext } from '../../tools/tool-contract';
import type {
  EmailVerificationProvider,
  EmailVerificationProviderResult,
  EmailVerificationRequest,
} from './email-verification-provider';
import {
  SmtpProbeProvider,
  mapSmtpProbeOutcome,
  resolveSmtpProbeConfig,
} from './smtp-probe.provider';
import { runVerificationWaterfall } from './verification-waterfall';

/**
 * P1-06 兜底票：SMTP RCPT 探测适配器——假 broker + 假 MX，零真实出网。
 * broker 的合规/预算/限流/Trace 由 ToolBroker 侧单测覆盖；这里只钉映射与调用面。
 */
const WS = '00000000-0000-4000-8000-0000000000bb';
const EMAIL = 'ana.schmidt@acme.example';

const MX = [{ exchange: 'mx1.acme.example', priority: 10 }];

interface FakeBrokerOptions {
  probe?: SmtpProbeOutput;
  invokeError?: Error;
  policy?: { allowed: boolean; reason?: SourcePolicyDenyReason };
  policyThrows?: boolean;
}

function fakeBroker(options: FakeBrokerOptions = {}) {
  const invokes: Array<{ toolId: string; input: SmtpProbeInput; ctx: ToolContext }> = [];
  const policyChecks: Array<{ toolId: string; domain: string }> = [];
  const broker: ExecutionBroker = {
    async checkSourcePolicy(toolId, domain) {
      policyChecks.push({ toolId, domain });
      if (options.policyThrows) throw new Error('policy_db_unavailable');
      return options.policy ?? { allowed: true };
    },
    async invoke<I, O>(toolId: string, input: I, ctx: ToolContext) {
      invokes.push({ toolId, input: input as SmtpProbeInput, ctx });
      if (options.invokeError) throw options.invokeError;
      return { data: (options.probe ?? reachableProbe()) as unknown as O, costCents: 0 };
    },
  };
  return { broker, invokes, policyChecks };
}

function reachableProbe(overrides: Partial<SmtpProbeOutput> = {}): SmtpProbeOutput {
  return { reachable: true, mailFromCode: 250, codes: [250, 550], ...overrides };
}

function mxs(records: Array<{ exchange: string; priority: number }> = MX) {
  return async () => records;
}

function providerWith(
  broker: ExecutionBroker,
  options: {
    resolveMxHost?: (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
    enabled?: boolean;
  } = {},
): SmtpProbeProvider {
  return new SmtpProbeProvider(broker, {
    config: { enabled: options.enabled ?? true },
    resolveMxHost: options.resolveMxHost ?? mxs(),
  });
}

async function verify(
  broker: ExecutionBroker,
  options: Parameters<typeof providerWith>[1] = {},
  request: Partial<EmailVerificationRequest> = {},
): Promise<EmailVerificationProviderResult> {
  return providerWith(broker, options).verify({ email: EMAIL, workspaceId: WS, ...request });
}

describe('resolveSmtpProbeConfig：EMAIL_VERIFY_SMTP_PROBE_ENABLED 缺省关（25 端口实测不可用）', () => {
  it('未设置 / 假值 → 关；只有显式真值才开', () => {
    expect(resolveSmtpProbeConfig({})).toEqual({ enabled: false });
    for (const raw of ['0', 'false', 'FALSE', 'no', 'off', 'banana']) {
      expect(resolveSmtpProbeConfig({ EMAIL_VERIFY_SMTP_PROBE_ENABLED: raw })).toEqual({ enabled: false });
    }
    for (const raw of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(resolveSmtpProbeConfig({ EMAIL_VERIFY_SMTP_PROBE_ENABLED: raw })).toEqual({ enabled: true });
    }
  });
});

describe('mapSmtpProbeOutcome：探测信号 → 四态', () => {
  it('不可达 / 无响应 / MAIL FROM 拒 / egress 拦截 → error 非空（无裁决，不凑票）', () => {
    expect(mapSmtpProbeOutcome({ probe: reachableProbe({ reachable: false }) }).error).toBe('smtp_unreachable');
    // 2026-11-10 实测形态：TUN fake-ip 接受 TCP 但 SMTP banner 超时 → mailFromCode/codes 均空。
    const noResponse = mapSmtpProbeOutcome({
      probe: { reachable: true, mailFromCode: null, codes: [] },
    });
    expect(noResponse.state).toBe('UNKNOWN');
    expect(noResponse.error).toBe('smtp_no_response');
    expect(mapSmtpProbeOutcome({ probe: reachableProbe({ mailFromCode: 550, codes: [] }) }).error).toBe(
      'mail_from_rejected',
    );
    expect(
      mapSmtpProbeOutcome({ probe: reachableProbe({ reachable: false, egressBlocked: 'private_ip' }) }).error,
    ).toBe('mx_egress_blocked');
  });
});

describe('SmtpProbeProvider：映射与调用面（假 broker + 假 MX）', () => {
  it('deliverable（RCPT 2xx + 随机地址 5xx）→ VALID·not_catch_all，成本 0、method=smtp_rcpt', async () => {
    const { broker, invokes } = fakeBroker({ probe: reachableProbe() });
    const result = await verify(broker);
    expect(result.state).toBe('VALID');
    expect(result.catchAllClass).toBe('not_catch_all');
    expect(result.acceptAll).toBeNull();
    expect(result.error).toBeNull();
    expect(result.costMicrousd).toBe(0);
    expect(result.method).toBe('smtp_rcpt');
    expect(result.providerKey).toBe('smtp_self');
    expect(invokes).toHaveLength(1);
    expect(invokes[0].toolId).toBe('smtp.rcpt_probe');
    expect(invokes[0].input.domain).toBe('acme.example');
    expect(invokes[0].input.mxHost).toBe('mx1.acme.example');
    expect(invokes[0].input.rcptTo[0]).toBe(EMAIL);
    expect(invokes[0].input.rcptTo[1]).toMatch(/^x-verify-[0-9a-f]{20}@acme\.example$/u);
    expect(invokes[0].ctx.workspaceId).toBe(WS);
  });

  it('undeliverable（RCPT 5xx）→ INVALID', async () => {
    const { broker } = fakeBroker({ probe: reachableProbe({ codes: [550, 550] }) });
    const result = await verify(broker);
    expect(result.state).toBe('INVALID');
    expect(result.error).toBeNull();
    expect(result.detail).toBe('mailbox_rejected:550');
  });

  it('随机地址也 2xx（catch-all 域）→ CATCH_ALL_RISKY·true_catch_all，acceptAll=true', async () => {
    const { broker } = fakeBroker({ probe: reachableProbe({ codes: [250, 250] }) });
    const result = await verify(broker);
    expect(result.state).toBe('CATCH_ALL_RISKY');
    expect(result.catchAllClass).toBe('true_catch_all');
    expect(result.acceptAll).toBe(true);
    expect(result.catchAll).toBe('catch_all');
  });

  it('真实地址 2xx 但 catch-all 未证伪（随机地址 4xx）→ UNKNOWN·inconclusive（不得判 VALID）', async () => {
    const { broker } = fakeBroker({ probe: reachableProbe({ codes: [250, 450] }) });
    const result = await verify(broker);
    expect(result.state).toBe('UNKNOWN');
    expect(result.catchAllClass).toBe('inconclusive');
    expect(result.error).toBeNull();
  });

  it('SMTP 不可达（端口 25 封）→ UNKNOWN + error=smtp_unreachable', async () => {
    const { broker } = fakeBroker({ probe: { reachable: false, mailFromCode: null, codes: [] } });
    const result = await verify(broker);
    expect(result.state).toBe('UNKNOWN');
    expect(result.error).toBe('smtp_unreachable');
  });

  it('broker 调用超时 → UNKNOWN + error=timeout（瀑布按 provider_error 停）', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { broker } = fakeBroker({ invokeError: timeout });
    const result = await verify(broker);
    expect(result.state).toBe('UNKNOWN');
    expect(result.error).toBe('timeout');
  });

  it('broker 合规门拒绝（ToolPolicyDenied）→ UNKNOWN + error=source_policy_denied', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'ToolPolicyDenied' });
    const { broker } = fakeBroker({ invokeError: denied });
    const result = await verify(broker);
    expect(result.error).toBe('source_policy_denied');
  });

  it('执行控制类错误（平台出口围栏等）原样上抛（fail-closed，不降级成投票）', async () => {
    const control = new ExecutionControlError('PLATFORM_EGRESS_FENCE_UNAVAILABLE');
    const { broker } = fakeBroker({ invokeError: control });
    await expect(verify(broker)).rejects.toThrow('PLATFORM_EGRESS_FENCE_UNAVAILABLE');
  });

  it('预算账不可用/超限 → 降级 UNKNOWN + error（reserve 先于出网，无裁决不崩溃批量）', async () => {
    const cases: Array<[Error, string]> = [
      [new BudgetAccountUnavailableError('00000000-0000-4000-8000-0000000000bb'), 'budget_account_unavailable'],
      [new BudgetStoreUnavailableError('db down'), 'budget_store_unavailable'],
      [new BudgetExceededError('acct', 0n, 0n), 'budget_exceeded'],
    ];
    for (const [error, code] of cases) {
      const { broker } = fakeBroker({ invokeError: error });
      const result = await verify(broker);
      expect(result.state).toBe('UNKNOWN');
      expect(result.error).toBe(code);
    }
  });

  it('source_policy 预检拒绝 → 不查 MX、不 invoke（连 DNS 都不做）', async () => {
    const { broker, invokes } = fakeBroker({ policy: { allowed: false, reason: 'suspended' } });
    let mxLookups = 0;
    const result = await verify(broker, {
      resolveMxHost: async () => {
        mxLookups += 1;
        return MX;
      },
    });
    expect(result.error).toBe('source_policy_suspended');
    expect(mxLookups).toBe(0);
    expect(invokes).toHaveLength(0);
  });

  it('source_policy 预检读失败 → fail-safe 放行到 invoke 合规门', async () => {
    const { broker, invokes } = fakeBroker({ policyThrows: true });
    const result = await verify(broker);
    expect(result.state).toBe('VALID');
    expect(invokes).toHaveLength(1);
  });

  it('反枚举 provider（Gmail）→ UNKNOWN·unprobeable_provider，不触网', async () => {
    const { broker, invokes } = fakeBroker();
    const result = await verify(broker, {
      resolveMxHost: mxs([{ exchange: 'aspmx.l.google.com', priority: 1 }]),
    });
    expect(result.state).toBe('UNKNOWN');
    expect(result.catchAllClass).toBe('unprobeable_provider');
    expect(result.detail).toBe('provider_anti_enumeration:google_workspace');
    expect(result.error).toBeNull();
    expect(invokes).toHaveLength(0);
  });

  it('无 MX / Null MX / NXDOMAIN → INVALID；瞬时 DNS 失败 → error（不是判决）', async () => {
    const { broker, invokes } = fakeBroker();
    const noMx = await verify(broker, { resolveMxHost: mxs([]) });
    expect(noMx.state).toBe('INVALID');
    expect(noMx.detail).toBe('null_mx_no_mail');

    const nullMx = await verify(broker, { resolveMxHost: mxs([{ exchange: '.', priority: 0 }]) });
    expect(nullMx.state).toBe('INVALID');

    const nxdomain = await verify(broker, {
      resolveMxHost: async () => {
        throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
      },
    });
    expect(nxdomain.state).toBe('INVALID');
    expect(nxdomain.detail).toBe('no_mx');

    const transient = await verify(broker, {
      resolveMxHost: async () => {
        throw Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' });
      },
    });
    expect(transient.state).toBe('UNKNOWN');
    expect(transient.error).toBe('dns_lookup_failed');
    expect(invokes).toHaveLength(0);
  });

  it('缺 workspaceId → 不触网、诚实降级（UNKNOWN + error）', async () => {
    const { broker, invokes, policyChecks } = fakeBroker();
    const result = await providerWith(broker).verify({ email: EMAIL });
    expect(result.state).toBe('UNKNOWN');
    expect(result.error).toBe('missing_workspace_context');
    expect(invokes).toHaveLength(0);
    expect(policyChecks).toHaveLength(0);
  });

  it('关闭开关 → isConfigured=false，verify 降级 provider_unconfigured', async () => {
    const { broker, invokes } = fakeBroker();
    const provider = providerWith(broker, { enabled: false });
    expect(provider.isConfigured()).toBe(false);
    const result = await provider.verify({ email: EMAIL, workspaceId: WS });
    expect(result.error).toBe('provider_unconfigured');
    expect(invokes).toHaveLength(0);
  });

  it('语法不合法 → INVALID·syntax（不触网）', async () => {
    const { broker, invokes } = fakeBroker();
    const result = await providerWith(broker).verify({ email: 'not-an-email', workspaceId: WS });
    expect(result.state).toBe('INVALID');
    expect(result.detail).toBe('syntax');
    expect(invokes).toHaveLength(0);
  });

  it('随机地址确定性派生（同输入同 rcptTo → 命中工具幂等键）', async () => {
    const first = fakeBroker();
    const second = fakeBroker();
    await verify(first.broker);
    await verify(second.broker);
    expect(first.invokes[0].input.rcptTo).toEqual(second.invokes[0].input.rcptTo);
  });
});

describe('瀑布集成：SMTP 兜底票作为第二票（mock broker）', () => {
  function externalProvider(
    key: string,
    result: Partial<EmailVerificationProviderResult>,
  ): EmailVerificationProvider & { requests: EmailVerificationRequest[] } {
    const requests: EmailVerificationRequest[] = [];
    return {
      key,
      domain: `${key}.example`,
      requests,
      isConfigured: () => true,
      async verify(request) {
        requests.push(request);
        return {
          providerKey: key,
          state: 'UNKNOWN',
          catchAll: 'unknown',
          catchAllClass: 'unknown',
          score: 20,
          acceptAll: null,
          disposable: null,
          role: null,
          detail: 'fixture',
          error: null,
          costMicrousd: 1_000,
          latencyMs: 3,
          ...result,
        };
      },
    };
  }

  const positive: Partial<EmailVerificationProviderResult> = {
    state: 'VALID',
    catchAll: 'not_catch_all',
    catchAllClass: 'not_catch_all',
  };

  it('外部 VALID + SMTP deliverable 两票一致 → VALID（单验证器永不判 VALID 的兜底路径）', async () => {
    const { broker } = fakeBroker({ probe: reachableProbe() });
    const external = externalProvider('zerobounce', positive);
    const outcome = await runVerificationWaterfall({
      email: EMAIL,
      workspaceId: WS,
      providers: [external, providerWith(broker)],
    });
    expect(outcome.resolved.state).toBe('VALID');
    expect(outcome.resolved.reason).toBe('two_positive_votes');
    expect(outcome.providerCalls).toBe(2);
    expect(outcome.steps.map((step) => step.providerKey)).toEqual(['zerobounce', 'smtp_self']);
    // 工作区上下文透传到工具型验证器（第三方验证器也按同一请求收到，忽略即可）。
    expect(external.requests[0].workspaceId).toBe(WS);
  });

  it('外部 VALID + SMTP INVALID 冲突 → UNKNOWN（绝不判 VALID）', async () => {
    const { broker } = fakeBroker({ probe: reachableProbe({ codes: [550, 550] }) });
    const outcome = await runVerificationWaterfall({
      email: EMAIL,
      workspaceId: WS,
      providers: [externalProvider('zerobounce', positive), providerWith(broker)],
    });
    expect(outcome.resolved.state).toBe('UNKNOWN');
    expect(outcome.resolved.reason).toBe('verifier_conflict_unresolved');
  });

  it('只有 SMTP 一票可用（无外部 key）→ 单票 UNKNOWN（等第二票，不判 VALID）', async () => {
    const { broker } = fakeBroker({ probe: reachableProbe() });
    const outcome = await runVerificationWaterfall({
      email: EMAIL,
      workspaceId: WS,
      providers: [providerWith(broker)],
    });
    expect(outcome.resolved.state).toBe('UNKNOWN');
    expect(outcome.resolved.reason).toBe('single_positive_requires_second_vote');
    expect(outcome.providerCalls).toBe(1);
  });

  it('外部 VALID + SMTP 超时 → provider_error，单票保持 UNKNOWN', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { broker } = fakeBroker({ invokeError: timeout });
    const outcome = await runVerificationWaterfall({
      email: EMAIL,
      workspaceId: WS,
      providers: [externalProvider('zerobounce', positive), providerWith(broker)],
    });
    expect(outcome.resolved.state).toBe('UNKNOWN');
    expect(outcome.stopReason).toBe('provider_error');
    expect(outcome.steps[1].result.error).toBe('timeout');
  });

  it('外部 VALID + SMTP catch-all → accept_all 优先压到 CATCH_ALL_RISKY', async () => {
    const { broker } = fakeBroker({ probe: reachableProbe({ codes: [250, 250] }) });
    const outcome = await runVerificationWaterfall({
      email: EMAIL,
      workspaceId: WS,
      providers: [externalProvider('zerobounce', positive), providerWith(broker)],
    });
    expect(outcome.resolved.state).toBe('CATCH_ALL_RISKY');
    expect(outcome.resolved.reason).toBe('accept_all_flag');
  });
});
