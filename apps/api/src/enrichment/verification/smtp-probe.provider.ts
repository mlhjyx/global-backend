import { createHash } from 'node:crypto';
import { resolveMx } from 'node:dns/promises';
import type { CatchAllClass, EmailVerificationState } from '../../discovery/contact-point-verification-state';
import { classifyEmailProvider, isAccepted, isRejected } from '../../discovery/providers/email-verify.provider';
import { isExecutionControlError } from '../../execution-budget/execution-control-error';
import {
  BudgetAccountUnavailableError,
  BudgetExceededError,
  BudgetStoreUnavailableError,
} from '../../tools/budget-store';
import type { SmtpProbeInput, SmtpProbeOutput } from '../../tools/builtin-tools';
import type { ExecutionBroker, ToolContext, ToolResult } from '../../tools/tool-contract';
import {
  unavailableProviderResult,
  type EmailVerificationProvider,
  type EmailVerificationProviderResult,
  type EmailVerificationRequest,
} from './email-verification-provider';
import { scoreEmailPoint } from './verification-policy';

/**
 * P1-06 兜底执行器：把 ToolBroker 的 `smtp.rcpt_probe`（端口 25 RCPT 探测，零成本、无 key）
 * 接成验证瀑布的**第二票**。外部验证器可用票数不足 2（缺 key / kill switch 关闭）时由
 * provider-pool 追加为末席位——两票一致才判 VALID/INVALID，单票永远停在 UNKNOWN（双正规则）。
 *
 * 决议语义（四态，与 smtp_self 的诚实上限一致——反枚举/catch-all/端口 25 封禁绝不谎报）：
 *  - RCPT 2xx + 随机地址 5xx（catch-all 已证伪）+ 非反枚举 → VALID·not_catch_all；
 *  - RCPT 5xx（强否定）/ 域无 MX / Null MX / NXDOMAIN → INVALID；
 *  - 随机地址也 2xx（catch-all 域）→ CATCH_ALL_RISKY·true_catch_all（acceptAll=true，
 *    投票矩阵据此压到 CATCH_ALL_RISKY 以优先于任何 positive）；
 *  - 反枚举 provider（Gmail/M365/Proofpoint…）→ UNKNOWN·unprobeable_provider（不触网）；
 *  - 真实地址 2xx 但 catch-all 未证伪（随机地址 4xx/无响应）→ UNKNOWN·inconclusive；
 *  - SMTP 不可达 / MAIL FROM 被拒 / SSRF 护栏拦截 / 超时 / broker 拒绝 → error 非空
 *    （无裁决，瀑布按 provider_error 停，绝不当成 UNKNOWN 票凑数）。
 *
 * 出网纪律：SMTP 出网**只能**经 `broker.invoke('smtp.rcpt_probe', …)`（source_policy advisory +
 * 用途门 + 预算 + 限流 + Trace + 工具内 SSRF 护栏）。凭证/门之外的失败一律降级不抛
 * （执行控制类错误原样上抛，fail-closed）。
 *
 * env：`EMAIL_VERIFY_SMTP_PROBE_ENABLED`（**缺省 false**；只有显式 `1/true/yes/on` 才启用）。
 * 默认关的实测依据（2026-11-10，本机 xin）：对 gmail-smtp-in.l.google.com / mx00.1and1.com /
 * mx.hermes.epson.de 做 25 端口探测，TCP 层被 TUN fake-ip 直接接受但 **SMTP banner 全部超时**
 * ——宿主的 25 端口出网不可用，探测只会得到 UNKNOWN（no response）。第二票的现实路径是
 * 第三方验证器 key（Emailable/MillionVerifier）或具备 25 出口的探测节点；在此之前保持默认关，
 * 开启也只产生无裁决的 UNKNOWN/error 票，不影响现有流程（不可达/超时绝不伪装成投票）。
 * 超时与限速沿用工具声明（8s 连接超时、rps=1、concurrency=2）。
 * 成本 0 微美元；detail 只含响应码/状态词，不含邮箱明文。
 */

/** 与 `apps/api/src/discovery/providers/email-verify.provider.ts` 共用同一工具与调用面。 */
const SMTP_PROBE_TOOL = 'smtp.rcpt_probe';

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export interface SmtpProbeConfig {
  enabled: boolean;
}

/**
 * 缺省**关闭**（2026-11-10 实测：宿主 25 端口出网不可用，探测只会得到 UNKNOWN）；
 * 只有显式真值（1/true/yes/on）才启用第二票兜底——须先确认部署环境具备 25 端口出口。
 */
export function resolveSmtpProbeConfig(env: NodeJS.ProcessEnv = process.env): SmtpProbeConfig {
  const raw = (env.EMAIL_VERIFY_SMTP_PROBE_ENABLED ?? '').trim().toLowerCase();
  return { enabled: /^(1|true|yes|on)$/u.test(raw) };
}

export interface SmtpProbeMapping {
  state: EmailVerificationState;
  catchAll: 'catch_all' | 'not_catch_all' | 'inconclusive' | 'unknown';
  catchAllClass: CatchAllClass;
  acceptAll: boolean | null;
  detail: string;
  error: string | null;
}

/**
 * 探测信号 → 四态映射（纯函数，不触网）。
 * `probe` 为 null 表示未发起探测（反枚举 provider 短路；`shortCircuit` 给出直接裁决）。
 */
export function mapSmtpProbeOutcome(input: {
  probe: SmtpProbeOutput | null;
  /** 未探测时的直接裁决（反枚举 → UNKNOWN·unprobeable_provider）。 */
  shortCircuit?: SmtpProbeMapping;
}): SmtpProbeMapping {
  if (input.probe === null) {
    return (
      input.shortCircuit ?? {
        state: 'UNKNOWN',
        catchAll: 'unknown',
        catchAllClass: 'unknown',
        acceptAll: null,
        detail: 'no_probe',
        error: 'no_probe',
      }
    );
  }
  const unknown = (detail: string, error: string | null, catchAllClass: CatchAllClass = 'unknown'): SmtpProbeMapping => ({
    state: 'UNKNOWN',
    catchAll: catchAllClass === 'inconclusive' ? 'inconclusive' : 'unknown',
    catchAllClass,
    acceptAll: null,
    detail,
    error,
  });
  const probe = input.probe;
  if (probe.egressBlocked) return unknown(`mx_egress_blocked:${probe.egressBlocked}`, 'mx_egress_blocked');
  if (!probe.reachable) return unknown('smtp_unreachable_port25_blocked?', 'smtp_unreachable');
  // 连接建立但对端从未给出任何 SMTP 响应（banner 超时——宿主 TUN fake-ip 会先接受 TCP，
  // 2026-11-10 实测正是这种形态）→ 会话级不可用，不是 MAIL FROM/RCPT 判决。
  if (probe.mailFromCode === null && probe.codes.length === 0) {
    return unknown('smtp_no_response_banner_timeout', 'smtp_no_response');
  }
  // MAIL FROM 被拒（两种发件人身份都拒）→ RCPT 结果不可信，不是邮箱判决。
  if (!isAccepted(probe.mailFromCode)) return unknown('mail_from_rejected', 'mail_from_rejected');
  const rcptCode = probe.codes[0] ?? null;
  const randomCode = probe.codes[1] ?? null;
  if (isRejected(rcptCode)) {
    return {
      state: 'INVALID',
      catchAll: 'unknown',
      catchAllClass: 'unknown',
      acceptAll: null,
      detail: `mailbox_rejected:${rcptCode}`,
      error: null,
    };
  }
  if (isAccepted(randomCode)) {
    return {
      state: 'CATCH_ALL_RISKY',
      catchAll: 'catch_all',
      catchAllClass: 'true_catch_all',
      acceptAll: true,
      detail: 'catch_all_domain',
      error: null,
    };
  }
  if (isAccepted(rcptCode) && isRejected(randomCode)) {
    return {
      state: 'VALID',
      catchAll: 'not_catch_all',
      catchAllClass: 'not_catch_all',
      acceptAll: null,
      detail: `smtp_accepted:${rcptCode}`,
      error: null,
    };
  }
  if (isAccepted(rcptCode)) {
    // 真实地址被接受、但 catch-all 未证伪（随机地址 4xx/无响应）→ 不得判 VALID。
    return unknown('catch_all_unproven', null, 'inconclusive');
  }
  return unknown(`inconclusive:${rcptCode ?? 'no_code'}`, null);
}

type MxResolver = (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;

function dnsFailureIsTerminal(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 'ENOTFOUND' || code === 'ENODATA';
}

/**
 * 预算账可用性类错误：reserve 在 execute 之前失败 → **没有任何出网**，降级成无裁决的
 * UNKNOWN（事件 verdict=error）比让整个批量 sweep 因个别 workspace 没开预算账户而崩溃更
 * 符合「按点诚实降级」；其余执行控制错误（平台出口围栏/域名 ACK/账本重放）仍原样上抛。
 */
function budgetUnavailableCode(error: unknown): string | null {
  if (error instanceof BudgetAccountUnavailableError) return 'budget_account_unavailable';
  if (error instanceof BudgetStoreUnavailableError) return 'budget_store_unavailable';
  if (error instanceof BudgetExceededError) return 'budget_exceeded';
  return null;
}

export class SmtpProbeProvider implements EmailVerificationProvider {
  readonly key = 'smtp_self';
  /**
   * 无固定 API 域：source_policy 按**收件域名**在 broker.invoke 时逐次执行（advisory 模式）。
   * 本字段只为接口形状；provider-pool 的兜底注入发生在注册表前置门之后，SMTP 侧门由
   * broker 在调用时权威判定（SUSPENDED / 用途门 / SSRF / 限流）。
   */
  readonly domain = SMTP_PROBE_TOOL;

  private readonly config: SmtpProbeConfig;
  private readonly resolveMxHost: MxResolver;

  constructor(
    private readonly broker: ExecutionBroker,
    options: { config?: SmtpProbeConfig; resolveMxHost?: MxResolver } = {},
  ) {
    this.config = options.config ?? resolveSmtpProbeConfig();
    this.resolveMxHost = options.resolveMxHost ?? resolveMx;
  }

  isConfigured(): boolean {
    return this.config.enabled;
  }

  async verify(request: EmailVerificationRequest): Promise<EmailVerificationProviderResult> {
    const startedAt = Date.now();
    const unavailable = (error: string, detail: string) => ({
      ...unavailableProviderResult({ providerKey: this.key, error, detail, latencyMs: Date.now() - startedAt }),
      method: 'smtp_rcpt' as const,
    });
    if (!this.config.enabled) return unavailable('provider_unconfigured', 'EMAIL_VERIFY_SMTP_PROBE_ENABLED 关闭');
    const email = request.email.trim();
    if (!EMAIL_RE.test(email)) {
      return this.toResult(
        {
          state: 'INVALID',
          catchAll: 'unknown',
          catchAllClass: 'unknown',
          acceptAll: null,
          detail: 'syntax',
          error: null,
        },
        startedAt,
      );
    }
    if (!request.workspaceId) {
      // 无租户上下文 = 无法归账预算 / 无法过 suppression 门 → 不触网、不伪造结论。
      return unavailable('missing_workspace_context', '工作区上下文缺失，SMTP 探测不发起');
    }
    const domain = (email.split('@')[1] ?? '').toLowerCase();

    // source_policy 预检（早于 DNS）：SUSPENDED/用途门不通过就连 MX 都不查。
    // 读失败不硬失败——broker.invoke 的合规门仍是权威判定（与 smtp_self 同纪律）。
    try {
      const precheck = await this.broker.checkSourcePolicy(SMTP_PROBE_TOOL, domain);
      if (!precheck.allowed) {
        return unavailable(`source_policy_${precheck.reason ?? 'denied'}`, '收件域的 source_policy 拒绝探测');
      }
    } catch {
      /* fail-safe：放行到 invoke 合规门 */
    }

    let mx: Array<{ exchange: string; priority: number }>;
    try {
      mx = await this.resolveMxHost(domain);
    } catch (error) {
      if (dnsFailureIsTerminal(error)) {
        return this.toResult(
          {
            state: 'INVALID',
            catchAll: 'unknown',
            catchAllClass: 'unknown',
            acceptAll: null,
            detail: 'no_mx',
            error: null,
          },
          startedAt,
        );
      }
      return unavailable('dns_lookup_failed', 'MX 解析暂时失败（非 NXDOMAIN），非邮箱判决');
    }
    const usable = mx.filter((record) => record.exchange && record.exchange !== '.');
    if (usable.length === 0) {
      return this.toResult(
        {
          state: 'INVALID',
          catchAll: 'unknown',
          catchAllClass: 'unknown',
          acceptAll: null,
          detail: 'null_mx_no_mail',
          error: null,
        },
        startedAt,
      );
    }
    const { provider, enumResistant } = classifyEmailProvider(usable.map((record) => record.exchange));
    if (enumResistant) {
      // 反枚举 provider 对任意地址恒 250，探测拿不到信息 → 直接 UNKNOWN，省一次连接。
      return this.toResult(mapSmtpProbeOutcome({
        probe: null,
        shortCircuit: {
          state: 'UNKNOWN',
          catchAll: 'inconclusive',
          catchAllClass: 'unprobeable_provider',
          acceptAll: null,
          detail: `provider_anti_enumeration:${provider}`,
          error: null,
        },
      }), startedAt);
    }
    const host = usable.sort((a, b) => a.priority - b.priority)[0].exchange;
    // 随机地址做 catch-all 探测；按 (运行+收件箱) 确定性派生，重复调用命中工具的幂等键。
    const randomLocal = `x-verify-${createHash('sha256')
      .update(`${request.runId ?? 'no-run'}:${request.workspaceId}:${email.toLowerCase()}:${domain}`)
      .digest('hex')
      .slice(0, 20)}`;
    const toolCtx: ToolContext = {
      workspaceId: request.workspaceId,
      runId: request.runId,
      correlationId: `smtp-probe:${domain}`,
      authorizeExternalAction: request.authorizeExternalAction,
    };

    let result: ToolResult<SmtpProbeOutput>;
    try {
      result = await this.broker.invoke<SmtpProbeInput, SmtpProbeOutput>(
        SMTP_PROBE_TOOL,
        { domain, mxHost: host, rcptTo: [email, `${randomLocal}@${domain}`] },
        toolCtx,
      );
    } catch (error) {
      const budgetCode = budgetUnavailableCode(error);
      if (budgetCode) return unavailable(budgetCode, '工具预算账不可用，SMTP 探测未发起（无裁决）');
      if (isExecutionControlError(error)) throw error;
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      if ((error as { name?: unknown })?.name === 'ToolPolicyDenied') {
        return unavailable('source_policy_denied', 'broker 合规门拒绝 SMTP 探测');
      }
      return timedOut
        ? unavailable('timeout', 'broker 调用超时')
        : unavailable('smtp_probe_failed', 'SMTP 探测工具调用失败');
    }
    return this.toResult(mapSmtpProbeOutcome({ probe: result.data }), startedAt);
  }

  private toResult(mapping: SmtpProbeMapping, startedAt: number): EmailVerificationProviderResult {
    return {
      providerKey: this.key,
      state: mapping.state,
      catchAll: mapping.catchAll,
      catchAllClass: mapping.catchAllClass,
      score: scoreEmailPoint({ state: mapping.state, catchAllClass: mapping.catchAllClass }),
      acceptAll: mapping.acceptAll,
      disposable: null,
      role: null,
      detail: mapping.detail,
      error: mapping.error,
      costMicrousd: 0,
      latencyMs: Date.now() - startedAt,
      method: 'smtp_rcpt',
    };
  }
}
