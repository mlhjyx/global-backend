import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EgressBlockedError,
  requestPublicHttp,
  type PinnedPublicUrl,
  type PublicUrlResolver,
} from './guarded-http';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('requestPublicHttp — 连接层 pinning 与逐跳 redirect 闸', () => {
  it('连接固定到校验所得 IP，不对原始 hostname 做第二次 DNS 解析', async () => {
    const server = createServer((req, res) => {
      expect(req.headers.host).toMatch(/^rebind\.example:/);
      res.end('pinned');
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const resolver: PublicUrlResolver = vi.fn(async (raw): Promise<PinnedPublicUrl> => ({
      url: new URL(raw),
      ip: '::1', // test-only：首个已验证 pin 不可达时只回退到第二个已验证 pin
      family: 6,
      addresses: [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ],
    }));
    const response = await requestPublicHttp(
      `http://rebind.example:${address.port}/probe`,
      { maxBytes: 1024 },
      { resolver },
    );

    expect(response.text).toBe('pinned');
    expect(response.finalUrl).toBe(`http://rebind.example:${address.port}/probe`);
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('重定向每一跳重新校验；跳向 metadata 时不发起第二次请求', async () => {
    const resolver: PublicUrlResolver = vi.fn(async (raw) => {
      if (raw.includes('public.example')) {
        return {
          url: new URL(raw),
          ip: '93.184.216.34',
          family: 4,
          addresses: [{ address: '93.184.216.34', family: 4 }],
        };
      }
      throw new EgressBlockedError('non_global_address');
    });
    const executePinned = vi.fn(async () => ({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      body: Buffer.alloc(0),
      text: '',
    }));

    await expect(
      requestPublicHttp(
        'https://public.example/start',
        { maxRedirects: 3 },
        { resolver, executePinned },
      ),
    ).rejects.toMatchObject({ code: 'non_global_address' });

    expect(executePinned).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('响应体超过上限即中止，不先整段读入内存', async () => {
    const server = createServer((_req, res) => {
      res.write(Buffer.alloc(2048, 1));
      res.end();
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const resolver: PublicUrlResolver = async (raw) => ({
      url: new URL(raw),
      ip: '127.0.0.1',
      family: 4,
      addresses: [{ address: '127.0.0.1', family: 4 }],
    });

    await expect(
      requestPublicHttp(`http://large.example:${address.port}/`, { maxBytes: 128 }, { resolver }),
    ).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('总墙钟超时不会被慢速持续响应续命', async () => {
    const server = createServer((_req, res) => {
      const interval = setInterval(() => res.write('x'), 20);
      res.once('close', () => clearInterval(interval));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const resolver: PublicUrlResolver = async (raw) => ({
      url: new URL(raw),
      ip: '127.0.0.1',
      family: 4,
      addresses: [{ address: '127.0.0.1', family: 4 }],
    });

    await expect(
      requestPublicHttp(`http://slow.example:${address.port}/`, { timeoutMs: 120 }, { resolver }),
    ).rejects.toThrow('public_http_timeout');
  });

  it('跨域 redirect 剥离 Authorization/Cookie', async () => {
    const resolver: PublicUrlResolver = async (raw) => ({
      url: new URL(raw),
      ip: '93.184.216.34',
      family: 4,
      addresses: [{ address: '93.184.216.34', family: 4 }],
    });
    const executePinned = vi
      .fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: 'https://other.example/final' },
        body: Buffer.alloc(0),
        text: '',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: Buffer.from('ok'),
        text: 'ok',
      });

    await requestPublicHttp(
      'https://first.example/start',
      { headers: { Authorization: 'Bearer secret', Cookie: 'sid=secret', Accept: 'text/plain' } },
      { resolver, executePinned },
    );

    expect(executePinned.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer secret',
      Cookie: 'sid=secret',
      Accept: 'text/plain',
    });
    expect(executePinned.mock.calls[1][1].headers).toEqual({ Accept: 'text/plain' });
  });
});
