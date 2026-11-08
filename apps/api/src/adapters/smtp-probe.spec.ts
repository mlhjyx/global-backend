import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { HELO_HOST, SENDER_DOMAIN, smtpRcptProbe } from './smtp-probe';

/**
 * A2：SMTP 探测发送身份修复。
 * 传输层测试用真实本地 SMTP 服务器脚本化对话：EHLO 参数、MAIL FROM 被拒后的空信封
 * 回退、双拒保持 mail_from_rejected 语义、连接失败诚实降级。
 */

interface ScriptedServer {
  port: number;
  close: () => Promise<void>;
  /** 每个连接收到的命令序列（按连接分组）。 */
  conversations: string[][];
}

function scriptedSmtp(replies: {
  greeting?: string;
  ehlo?: string;
  mailFrom: (command: string) => string;
  rcpt?: string;
}): Promise<ScriptedServer> {
  const conversations: string[][] = [];
  const server = net.createServer((socket) => {
    const convo: string[] = [];
    conversations.push(convo);
    socket.write(`${replies.greeting ?? '220 mx.test ESMTP\r\n'}`);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const command = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        convo.push(command);
        const verb = command.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') {
          socket.write(`${replies.ehlo ?? '250-mx.test\r\n250 OK\r\n'}`);
        } else if (verb === 'MAIL') {
          socket.write(replies.mailFrom(command));
        } else if (verb === 'RCPT') {
          socket.write(`${replies.rcpt ?? '250 OK\r\n'}`);
        } else if (verb === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        }
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        conversations,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

afterEach(() => {
  delete process.env.EMAIL_VERIFY_SENDER_DOMAIN;
  delete process.env.EMAIL_VERIFY_HELO_HOST;
});

describe('smtpRcptProbe（A2 发送身份）', () => {
  it('EHLO 用配置的 FQDN、MAIL FROM 用自有发送域，单会话完成并解析码序', async () => {
    const server = await scriptedSmtp({
      mailFrom: () => '250 sender ok\r\n',
      rcpt: '250 OK\r\n',
    });
    try {
      const result = await smtpRcptProbe(
        '127.0.0.1',
        `verify@${SENDER_DOMAIN}`,
        ['a@example.org', 'b@example.org'],
        2000,
        server.port,
      );
      expect(result).toEqual({
        reachable: true,
        mailFromCode: 250,
        codes: [250, 250],
      });
      expect(server.conversations).toHaveLength(1);
      expect(server.conversations[0]![0]).toBe(`EHLO ${HELO_HOST}`);
      expect(server.conversations[0]![1]).toBe(`MAIL FROM:<verify@${SENDER_DOMAIN}>`);
      expect(SENDER_DOMAIN).not.toBe('example.com');
    } finally {
      await server.close();
    }
  });

  it('MAIL FROM 被 5xx 拒 → 空信封 <>" 重试并返回回退会话的结果', async () => {
    const server = await scriptedSmtp({
      mailFrom: (command) =>
        command.includes('<>') ? '250 null sender ok\r\n' : '554 sender rejected\r\n',
      rcpt: '250 OK\r\n',
    });
    try {
      const result = await smtpRcptProbe(
        '127.0.0.1',
        `verify@${SENDER_DOMAIN}`,
        ['a@example.org', 'b@example.org'],
        2000,
        server.port,
      );
      expect(result).toEqual({
        reachable: true,
        mailFromCode: 250,
        codes: [250, 250],
      });
      expect(server.conversations).toHaveLength(2);
      expect(server.conversations[0]![1]).toBe(`MAIL FROM:<verify@${SENDER_DOMAIN}>`);
      expect(server.conversations[1]![1]).toBe('MAIL FROM:<>');
    } finally {
      await server.close();
    }
  });

  it('两种发件人都被拒 → 保留被拒码（上层判 mail_from_rejected），不崩溃', async () => {
    const server = await scriptedSmtp({
      mailFrom: () => '554 sender rejected\r\n',
    });
    try {
      const result = await smtpRcptProbe(
        '127.0.0.1',
        `verify@${SENDER_DOMAIN}`,
        ['a@example.org'],
        2000,
        server.port,
      );
      expect(result).toEqual({
        reachable: true,
        mailFromCode: 554,
        codes: [],
      });
      expect(server.conversations).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('连接失败 → reachable=false（上层诚实降级 RISKY）', async () => {
    const result = await smtpRcptProbe('127.0.0.1', `verify@${SENDER_DOMAIN}`, ['a@example.org'], 500, 1);
    expect(result).toEqual({ reachable: false, mailFromCode: null, codes: [] });
  });
});
