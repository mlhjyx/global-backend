import { resolveMx } from 'node:dns/promises';
import { EmailVerdict, EmailVerificationAdapter, EmailVerifyContext } from '../provider-contract';
import type { ToolContext, ToolResult } from '../../tools/tool-contract';
import type { SmtpProbeInput, SmtpProbeOutput } from '../../tools/builtin-tools';

/**
 * ToolBroker 的最小面（供本 verifier 依赖 + 测试注入假实现）。SMTP 原始出网**只能**经此闸门：
 * `invoke('smtp.rcpt_probe', …)` 会强制 source_policy(SUSPENDED/用途) + 预算 + 限流 + 幂等 + Trace。
 */
export interface EmailVerifyBroker {
  sourcePolicy(domain: string): Promise<{ suspended: boolean; allowedPurpose?: string[] } | null>;
  invoke<I, O>(toolId: string, input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

const SMTP_PROBE_TOOL = 'smtp.rcpt_probe';

/**
 * 自建邮箱验证（v3.0 P0，零付费，不接 ZeroBounce/NeverBounce）。
 * 管线：语法 → **source_policy 门（SUSPENDED 跳过）** → MX → **经 ToolBroker 的 SMTP RCPT 探测**
 *       （不发 DATA）→ catch-all 检测 → provider 分级。
 *
 * 🛡️ SMTP 出网**不自行发起**：一律走注入的 ToolBroker（唯一确定性执行闸门——白名单/预算/限流/
 *    source_policy/幂等/Trace + 工具内 SSRF 护栏）。无 broker = 不做原始出网，诚实降级 RISKY。
 *
 * 🔴 诚实上限（buyer-intelligence-v3.md §10.3，务必守）：
 *  - Gmail / Microsoft 365 等**反枚举**邮服对任意地址一律返 250 → **永不判 VALID**，只 RISKY。
 *  - **catch-all 域**（对随机地址也接受）同样不可逐一确认 → RISKY。
 *  - 端口 25 出网被封（Mac/多数云常见）→ SMTP 不可达 → RISKY（不谎报 INVALID）。
 *  只有「SMTP 可达 + RCPT 明确接受 + 非 catch-all + 非反枚举 provider」才判 VALID。
 */
export class SelfHostedEmailVerifier implements EmailVerificationAdapter {
  readonly key = 'smtp_self';

  constructor(private readonly broker?: EmailVerifyBroker) {}

  async verifyEmail(email: string, ctx?: EmailVerifyContext): Promise<EmailVerdict> {
    if (!EMAIL_RE.test(email)) return { status: 'INVALID', detail: 'syntax', costCents: 0 };
    const domain = email.split('@')[1].toLowerCase();

    // source_policy 门（DAT-011）：SUSPENDED 域名在任何触网（MX/SMTP）前直接跳过 → RISKY。
    // 这只是「昂贵前置前的主动跳过」优化；权威判定在 broker.invoke 的合规门（防竞态、单点强制）。
    // 读失败**不硬失败**（§5 fail-safe）：吞掉异常放行到下游，SMTP 出网仍受 invoke 合规门约束
    // （SUSPENDED 会在那里被拒 → RISKY），绝不因一次 DB 抖动把应 RISKY 的验证变成请求 500。
    if (this.broker) {
      let suspended = false;
      try {
        suspended = (await this.broker.sourcePolicy(domain))?.suspended ?? false;
      } catch {
        // 读失败 → 视为未 suspended，放行到下游 invoke 合规门权威判定（fail-safe）
      }
      if (suspended) return { status: 'RISKY', detail: 'source_policy_suspended', costCents: 0 };
    }

    let mx: { exchange: string; priority: number }[];
    try {
      mx = await resolveMx(domain);
    } catch {
      return { status: 'INVALID', detail: 'dns_lookup_failed', costCents: 0 };
    }
    if (!mx.length) return { status: 'INVALID', detail: 'no_mx', costCents: 0 };
    // Null MX（RFC 7505：单条 exchange="."）= 域明示不收邮件 → INVALID，不去探测 "."
    const usable = mx.filter((m) => m.exchange && m.exchange !== '.');
    if (!usable.length) return { status: 'INVALID', detail: 'null_mx_no_mail', costCents: 0 };

    const { provider, enumResistant } = classifyEmailProvider(usable.map((m) => m.exchange));
    const host = usable.sort((a, b) => a.priority - b.priority)[0].exchange;

    // 反枚举 provider（Gmail/M365…）：SMTP 一律 250，探了也白探 → 直接 RISKY，省一次连接
    if (enumResistant) {
      return { status: 'RISKY', detail: `provider_anti_enumeration:${provider}`, costCents: 0 };
    }

    // 无闸门 = 不允许原始 SMTP 出网（绝不绕过 ToolBroker）→ 诚实降级。
    if (!this.broker) return { status: 'RISKY', detail: 'smtp_gate_unavailable', costCents: 0 };

    // SMTP RCPT 探测经 ToolBroker：真实地址 + 一个随机地址（catch-all 检测）。SSRF 护栏在工具内。
    const randomLocal = `x-verify-${Date.now().toString(36)}-zzq`;
    const toolCtx: ToolContext = {
      workspaceId: ctx?.workspaceId ?? 'platform',
      // runId 不塞常量：broker 预算/限流按 runId ?? workspaceId 归账，留空即按真实 workspace 归属，
      // 不把各租户折叠进同一个合成 run。
      runId: ctx?.runId,
      correlationId: `email-verify:${domain}`,
    };
    let probe: SmtpProbeOutput;
    try {
      const res = await this.broker.invoke<SmtpProbeInput, SmtpProbeOutput>(
        SMTP_PROBE_TOOL,
        { domain, mxHost: host, rcptTo: [email, `${randomLocal}@${domain}`] },
        toolCtx,
      );
      probe = res.data;
    } catch (err) {
      // Broker 拒绝：SUSPENDED/用途门（竞态）= source_policy_denied；其余（预算/限流兜底）= probe_failed。
      // 任何情况都**不**回落到原始出网。
      const denied = (err as { name?: string })?.name === 'ToolPolicyDenied';
      return { status: 'RISKY', detail: denied ? 'source_policy_denied' : 'smtp_probe_failed', costCents: 0 };
    }
    // 工具内 SSRF 护栏拦截（MX 指向私网/内网）→ 未发生出网 → RISKY。
    if (probe.egressBlocked) {
      return { status: 'RISKY', detail: `mx_egress_blocked:${probe.egressBlocked}`, costCents: 0 };
    }
    const randomCode = probe.codes[1] ?? null;

    return decideEmailVerdict({
      mxPresent: true,
      provider,
      enumResistant,
      smtpReachable: probe.reachable,
      mailFromOk: isAccepted(probe.mailFromCode), // MAIL FROM 被拒 → RCPT 结果不可信
      rcptCode: probe.codes[0] ?? null,
      // catch-all 三态：随机地址被接受=catch_all；被明确拒收=not_catch_all（证伪）；4xx/无=inconclusive
      catchAllStatus: isAccepted(randomCode) ? 'catch_all' : isRejected(randomCode) ? 'not_catch_all' : 'inconclusive',
    });
  }
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// ─────────────────────── 纯逻辑（可测，不触网） ───────────────────────

/** 从 MX 主机名分类邮件服务商 + 是否**反枚举**（对任意地址一律 250，无法逐一确认）。 */
export function classifyEmailProvider(mxExchanges: string[]): { provider: string; enumResistant: boolean } {
  const h = mxExchanges.join(' ').toLowerCase();
  if (/aspmx|google|googlemail/.test(h)) return { provider: 'google_workspace', enumResistant: true };
  if (/protection\.outlook|outlook|office365|microsoft/.test(h)) return { provider: 'microsoft_365', enumResistant: true };
  if (/pphosted|proofpoint/.test(h)) return { provider: 'proofpoint', enumResistant: true };
  if (/mimecast/.test(h)) return { provider: 'mimecast', enumResistant: true };
  if (/barracuda/.test(h)) return { provider: 'barracuda', enumResistant: true };
  if (/secureserver\.net/.test(h)) return { provider: 'godaddy', enumResistant: false };
  if (/zoho/.test(h)) return { provider: 'zoho', enumResistant: false };
  return { provider: 'other_or_self_hosted', enumResistant: false };
}

/** SMTP 响应码判定：2xx=接受，5xx=拒收，其余(4xx/无)=不确定。 */
export function isAccepted(code: number | null): boolean {
  return code != null && code >= 200 && code < 300;
}
export function isRejected(code: number | null): boolean {
  return code != null && code >= 500 && code < 600;
}

export type CatchAllStatus = 'catch_all' | 'not_catch_all' | 'inconclusive';

export interface VerdictSignals {
  mxPresent: boolean;
  provider: string;
  enumResistant: boolean;
  smtpReachable: boolean;
  mailFromOk: boolean; // MAIL FROM 是否被接受（被拒则 RCPT 结果不可信）
  rcptCode: number | null;
  catchAllStatus: CatchAllStatus;
}

/**
 * 核心裁决（诚实：反枚举/catch-all/不可达/MAIL FROM被拒/catch-all未证伪 一律 RISKY，绝不谎报 VALID）。
 * VALID 唯一路径：可达 + MAIL FROM 通过 + RCPT 接受 + **catch-all 已证伪(not_catch_all)** + 非反枚举。
 */
export function decideEmailVerdict(s: VerdictSignals): EmailVerdict {
  if (!s.mxPresent) return { status: 'INVALID', detail: 'no_mx', costCents: 0 };
  if (s.enumResistant) return { status: 'RISKY', detail: `provider_anti_enumeration:${s.provider}`, costCents: 0 };
  if (!s.smtpReachable) return { status: 'RISKY', detail: 'smtp_unreachable(port25_blocked?)_mx_present', costCents: 0 };
  // MAIL FROM 被拒（发件人策略/503/554…）→ RCPT 结果不代表 mailbox 存在性，不可判 INVALID
  if (!s.mailFromOk) return { status: 'RISKY', detail: 'mail_from_rejected', costCents: 0 };
  if (isRejected(s.rcptCode)) return { status: 'INVALID', detail: `mailbox_rejected:${s.rcptCode}`, costCents: 0 };
  if (s.catchAllStatus === 'catch_all') return { status: 'RISKY', detail: 'catch_all_domain', costCents: 0 };
  if (isAccepted(s.rcptCode) && s.catchAllStatus === 'not_catch_all') {
    return { status: 'VALID', detail: `smtp_accepted:${s.rcptCode}`, costCents: 0 };
  }
  // 真实地址被接受、但 catch-all 未证伪(inconclusive) → 不能判 VALID（可能是 catch-all）
  if (isAccepted(s.rcptCode)) return { status: 'RISKY', detail: 'catch_all_unproven', costCents: 0 };
  return { status: 'RISKY', detail: `inconclusive:${s.rcptCode ?? 'no_code'}`, costCents: 0 };
}
