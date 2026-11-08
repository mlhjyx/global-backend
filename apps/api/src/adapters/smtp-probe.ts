import net from 'node:net';

/**
 * 原始 SMTP 出网（端口 25，RCPT 探测；不发 DATA，不真正发信）。
 * 与其它原始出网适配器（searxng / web-crawler / net-guard）同层：**只做传输**，
 * 权限/预算/合规/限流一律不在此判断——由 ToolBroker 在 `smtp.rcpt_probe` 工具调用点强制。
 * 目标 IP 必须已由调用方过 SSRF 护栏（resolvePublicIp）解析为公网 IP 再传入。
 */

/**
 * 探测用发送身份（A2，2026-11-08）：此前缺省 `example.com`（保留域名、EHLO 同域），
 * 部分 MX 直接拒其信封发件人 → `mail_from_rejected` 把整域短路成不可达。
 * 改为自有域名；可用 env 覆盖。探测身份与未来的群发发信域必须分离（A8 送达性模块
 * 为群发建独立子域/IP 池）。
 */
export const SENDER_DOMAIN = process.env.EMAIL_VERIFY_SENDER_DOMAIN ?? 'gainos.easyiothings.com';
/** EHLO 参数：真实 FQDN（缺省=发送域，与 MAIL FROM 同域）。 */
export const HELO_HOST = process.env.EMAIL_VERIFY_HELO_HOST ?? SENDER_DOMAIN;

interface SmtpSessionResult {
  connected: boolean;
  mailFromCode: number | null;
  codes: (number | null)[];
}

/**
 * 单次 SMTP 会话：EHLO → MAIL FROM → 每个 addr 一次 RCPT TO → QUIT，收集响应码。
 * 不发 DATA（不投递）。`cancelled()` 用于在 MAIL FROM 被拒后提前结束会话。
 */
function runSession(
  host: string,
  port: number,
  mailFromCommand: string,
  rcptTo: string[],
  timeoutMs: number,
): Promise<SmtpSessionResult> {
  return new Promise((resolve) => {
    const codes: (number | null)[] = [];
    let mailFromCode: number | null = null;
    let connected = false;
    let resolved = false;
    // 命令序列：EHLO → MAIL FROM → RCPT×N → QUIT。第 1 个响应是 220 greeting（对应 cmds[-1]）。
    const cmds = [`EHLO ${HELO_HOST}`, mailFromCommand, ...rcptTo.map((r) => `RCPT TO:<${r}>`), 'QUIT'];
    // 本响应对应「刚发出的 cmds[sent-1]」；RCPT 命令在 cmds 里的下标区间是 [2, 2+N-1]。
    const rcptCmdLo = 2;
    let sent = 0; // 已发命令数

    const socket = net.createConnection(port, host);
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
      resolve({ connected, mailFromCode, codes });
    };

    socket.on('connect', () => {
      connected = true;
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
      if (respFor === 1) mailFromCode = Number.isFinite(code) ? code : null; // cmds[1] = MAIL FROM
      if (respFor >= rcptCmdLo && respFor < rcptCmdLo + rcptTo.length) {
        codes.push(Number.isFinite(code) ? code : null);
      }
      // MAIL FROM 被拒（4xx/5xx）→ 本会话的 RCPT 结果不可信；提前结束，交给空信封回退会话。
      if (respFor === 1 && Number.isFinite(code) && code >= 400) {
        done();
        return;
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
      resolve({ connected: false, mailFromCode, codes });
    });
    socket.on('close', done);
  });
}

export interface SmtpProbeResult {
  reachable: boolean;
  /**
   * 「产出 codes 的会话」的 MAIL FROM 响应码（A2）：正常会话被拒时会改走空信封
   * `MAIL FROM:<>` 重试，此字段即回退会话的受理码；两种发件人都被拒时为第一次的
   * 被拒码（上层照旧判 mail_from_rejected）。
   */
  mailFromCode: number | null;
  codes: (number | null)[];
}

/**
 * 对 mxHost:25 做 RCPT 探测（A2：MAIL FROM 被拒时自动以空信封 `<>` 重试一次）。
 * 端口 25 被封/超时 → reachable=false（上层判 RISKY）。
 */
export async function smtpRcptProbe(
  mxHost: string,
  mailFrom: string,
  rcptTo: string[],
  timeoutMs = 8000,
  port = 25,
): Promise<SmtpProbeResult> {
  const primary = await runSession(
    mxHost,
    port,
    `MAIL FROM:<${mailFrom}>`,
    rcptTo,
    timeoutMs,
  );
  const toResult = (session: SmtpSessionResult): SmtpProbeResult => ({
    reachable: session.connected,
    mailFromCode: session.mailFromCode,
    codes: session.codes,
  });
  if (!primary.connected) return toResult(primary);
  if (primary.mailFromCode !== null && primary.mailFromCode < 400) return toResult(primary);

  // 信封发件人被拒：空信封（bounce 语义）是探测的标准退路，多数 MX 受理。
  const fallback = await runSession(mxHost, port, 'MAIL FROM:<>', rcptTo, timeoutMs);
  if (!fallback.connected) return toResult(primary);
  if (fallback.mailFromCode !== null && fallback.mailFromCode < 400) {
    return { reachable: true, mailFromCode: fallback.mailFromCode, codes: fallback.codes };
  }
  // 两种发件人都被拒：保留第一次的结果（被拒码），上层判 mail_from_rejected。
  return toResult(primary);
}
