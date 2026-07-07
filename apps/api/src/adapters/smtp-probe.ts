import net from 'node:net';

/**
 * 原始 SMTP 出网（端口 25，RCPT 探测；不发 DATA，不真正发信）。
 * 与其它原始出网适配器（searxng / web-crawler / net-guard）同层：**只做传输**，
 * 权限/预算/合规/限流一律不在此判断——由 ToolBroker 在 `smtp.rcpt_probe` 工具调用点强制。
 * 目标 IP 必须已由调用方过 SSRF 护栏（resolvePublicIp）解析为公网 IP 再传入。
 */

export const SENDER_DOMAIN = process.env.EMAIL_VERIFY_SENDER_DOMAIN ?? 'example.com';

/**
 * 对 mxHost:25 依次 EHLO → MAIL FROM → 每个 addr 一次 RCPT TO，收集每个 RCPT 的响应码；QUIT。
 * 不发 DATA（不投递）。端口 25 被封/超时 → reachable=false（上层判 RISKY）。
 */
export function smtpRcptProbe(
  mxHost: string,
  mailFrom: string,
  rcptTo: string[],
  timeoutMs = 8000,
): Promise<{ reachable: boolean; mailFromCode: number | null; codes: (number | null)[] }> {
  return new Promise((resolve) => {
    const codes: (number | null)[] = [];
    let mailFromCode: number | null = null;
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
      resolve({ reachable, mailFromCode, codes });
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
      if (respFor === 1) mailFromCode = Number.isFinite(code) ? code : null; // cmds[1] = MAIL FROM
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
      resolve({ reachable: false, mailFromCode, codes });
    });
    socket.on('close', done);
  });
}
