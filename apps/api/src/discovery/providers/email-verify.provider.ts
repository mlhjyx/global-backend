import net from 'node:net';
import { resolveMx } from 'node:dns/promises';
import { EmailVerdict, EmailVerificationAdapter } from '../provider-contract';
import { resolvePublicIp } from '../../adapters/net-guard';

/**
 * 自建邮箱验证（v3.0 P0，零付费，不接 ZeroBounce/NeverBounce）。
 * 管线：语法 → MX → **SMTP RCPT 探测**（不发 DATA）→ catch-all 检测 → provider 分级。
 *
 * 🔴 诚实上限（buyer-intelligence-v3.md §10.3，务必守）：
 *  - Gmail / Microsoft 365 等**反枚举**邮服对任意地址一律返 250 → **永不判 VALID**，只 RISKY。
 *  - **catch-all 域**（对随机地址也接受）同样不可逐一确认 → RISKY。
 *  - 端口 25 出网被封（Mac/多数云常见）→ SMTP 不可达 → RISKY（不谎报 INVALID）。
 *  只有「SMTP 可达 + RCPT 明确接受 + 非 catch-all + 非反枚举 provider」才判 VALID。
 */
export class SelfHostedEmailVerifier implements EmailVerificationAdapter {
  readonly key = 'smtp_self';

  async verifyEmail(email: string): Promise<EmailVerdict> {
    if (!EMAIL_RE.test(email)) return { status: 'INVALID', detail: 'syntax', costCents: 0 };
    const domain = email.split('@')[1].toLowerCase();

    let mx: { exchange: string; priority: number }[];
    try {
      mx = await resolveMx(domain);
    } catch {
      return { status: 'INVALID', detail: 'dns_lookup_failed', costCents: 0 };
    }
    if (!mx.length) return { status: 'INVALID', detail: 'no_mx', costCents: 0 };

    const { provider, enumResistant } = classifyEmailProvider(mx.map((m) => m.exchange));
    const host = mx.sort((a, b) => a.priority - b.priority)[0].exchange;

    // 反枚举 provider（Gmail/M365…）：SMTP 一律 250，探了也白探 → 直接 RISKY，省一次连接
    if (enumResistant) {
      return { status: 'RISKY', detail: `provider_anti_enumeration:${provider}`, costCents: 0 };
    }

    // 🛡️ SSRF 护栏：mxHost 来自邮箱域名的 MX（可被投毒指向内网）——连接前解析并拒私网/内网 IP，
    // 直连解析出的公网 IP（避免 connect 时二次解析的 TOCTOU/DNS rebinding）。
    const guard = await resolvePublicIp(host);
    if (!guard.safe || !guard.ip) {
      return { status: 'RISKY', detail: `mx_egress_blocked:${guard.reason ?? 'unsafe'}`, costCents: 0 };
    }

    // SMTP RCPT 探测：真实地址 + 一个随机地址（catch-all 检测），同一连接
    const randomLocal = `x-verify-${Date.now().toString(36)}-zzq`;
    const probe = await smtpRcptProbe(guard.ip, `verify@${SENDER_DOMAIN}`, [email, `${randomLocal}@${domain}`]);

    return decideEmailVerdict({
      mxPresent: true,
      provider,
      enumResistant,
      smtpReachable: probe.reachable,
      rcptCode: probe.codes[0] ?? null,
      catchAll: isAccepted(probe.codes[1] ?? null), // 随机地址被接受 = catch-all
    });
  }
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const SENDER_DOMAIN = process.env.EMAIL_VERIFY_SENDER_DOMAIN ?? 'example.com';

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

export interface VerdictSignals {
  mxPresent: boolean;
  provider: string;
  enumResistant: boolean;
  smtpReachable: boolean;
  rcptCode: number | null;
  catchAll: boolean;
}

/** 核心裁决（诚实：反枚举/catch-all/不可达一律 RISKY，绝不谎报 VALID）。 */
export function decideEmailVerdict(s: VerdictSignals): EmailVerdict {
  if (!s.mxPresent) return { status: 'INVALID', detail: 'no_mx', costCents: 0 };
  if (s.enumResistant) return { status: 'RISKY', detail: `provider_anti_enumeration:${s.provider}`, costCents: 0 };
  if (!s.smtpReachable) return { status: 'RISKY', detail: 'smtp_unreachable(port25_blocked?)_mx_present', costCents: 0 };
  if (isRejected(s.rcptCode)) return { status: 'INVALID', detail: `mailbox_rejected:${s.rcptCode}`, costCents: 0 };
  if (s.catchAll) return { status: 'RISKY', detail: 'catch_all_domain', costCents: 0 };
  if (isAccepted(s.rcptCode)) return { status: 'VALID', detail: `smtp_accepted:${s.rcptCode}`, costCents: 0 };
  return { status: 'RISKY', detail: `inconclusive:${s.rcptCode ?? 'no_code'}`, costCents: 0 };
}

// ─────────────────────── SMTP 探测（net，端口 25；不发 DATA，不真正发信） ───────────────────────

/**
 * 对 mxHost:25 依次 EHLO → MAIL FROM → 每个 addr 一次 RCPT TO，收集每个 RCPT 的响应码；QUIT。
 * 不发 DATA（不投递）。端口 25 被封/超时 → reachable=false（上层判 RISKY）。
 */
export function smtpRcptProbe(
  mxHost: string,
  mailFrom: string,
  rcptTo: string[],
  timeoutMs = 8000,
): Promise<{ reachable: boolean; codes: (number | null)[] }> {
  return new Promise((resolve) => {
    const codes: (number | null)[] = [];
    let reachable = false;
    let resolved = false;
    // 命令序列：EHLO → MAIL FROM → RCPT×N → QUIT。第 1 个响应是 220 greeting（对应 cmds[-1]）。
    const cmds = [`EHLO ${SENDER_DOMAIN}`, `MAIL FROM:<${mailFrom}>`, ...rcptTo.map((r) => `RCPT TO:<${r}>`), 'QUIT'];
    // 本响应对应「刚发出的 cmds[sent-1]」；RCPT 命令在 cmds 里的下标区间是 [2, 2+N-1]。
    const rcptCmdLo = 2;
    let sent = 0; // 已发命令数

    const socket = net.createConnection(25, mxHost);
    socket.setTimeout(timeoutMs);
    let buf = '';

    const done = () => {
      if (resolved) return;
      resolved = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve({ reachable, codes });
    };

    socket.on('connect', () => {
      reachable = true;
    });
    socket.on('data', (d) => {
      buf += d.toString();
      // SMTP 多行响应：续行 "NNN-...", 末行 "NNN ..."（码后空格）。等到出现末行才算一次响应完成。
      if (!/^\d{3} [^\n]*\r?\n/m.test(buf)) return;
      const finalLine = buf
        .split(/\r?\n/)
        .filter(Boolean)
        .reverse()
        .find((l) => /^\d{3} /.test(l));
      const code = finalLine ? parseInt(finalLine.slice(0, 3), 10) : NaN;
      buf = '';
      const respFor = sent - 1; // 本响应对应刚发出的 cmds[respFor]；-1 = greeting
      if (respFor >= rcptCmdLo && respFor < rcptCmdLo + rcptTo.length) {
        codes.push(Number.isFinite(code) ? code : null);
      }
      if (sent < cmds.length) {
        socket.write(cmds[sent++] + '\r\n');
      } else {
        done();
      }
    });
    socket.on('timeout', done);
    socket.on('error', () => {
      if (resolved) return;
      resolved = true;
      resolve({ reachable: false, codes });
    });
    socket.on('close', done);
  });
}
