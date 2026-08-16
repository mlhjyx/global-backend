import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EgressBlockedError,
  requestPublicHttp,
  type PinnedPublicUrl,
  type PublicUrlResolver } from './guarded-http';

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
  it('pins a POST connection, writes the exact body, and gates the physical request once', async () => {
    let receivedMethod = '';
    let receivedBody = '';
    let executeContentLength = 0;
    const server = createServer((req, res) => {
      receivedMethod = req.method ?? '';
      executeContentLength = Number(req.headers['content-length'] ?? 0);
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        receivedBody += chunk;
      });
      req.on('end', () => res.end('accepted'));
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const resolver: PublicUrlResolver = vi.fn(async (raw) => ({
      url: new URL(raw),
      ip: '127.0.0.1',
      family: 4,
      addresses: [{ address: '127.0.0.1', family: 4 }],
    }));
    const beforeRequest = vi.fn(async () => undefined);
    const onRequestStarted = vi.fn();
    const body = JSON.stringify({ filters: { keywords: ['pump'] } });

    const response = await requestPublicHttp(
      `http://post.example:${address.port}/api/search`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      { resolver, beforeRequest, onRequestStarted },
    );

    expect(response.text).toBe('accepted');
    expect(receivedMethod).toBe('POST');
    expect(receivedBody).toBe(body);
    expect(executeContentLength).toBe(Buffer.byteLength(body));
    expect(resolver).toHaveBeenCalledOnce();
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(onRequestStarted).toHaveBeenCalledOnce();
  });

  it('rejects an oversized POST body before DNS resolution or a physical request', async () => {
    const resolver: PublicUrlResolver = vi.fn();
    const executePinned = vi.fn();
    const onRequestStarted = vi.fn();

    await expect(requestPublicHttp(
      'https://api.example/upload',
      { method: 'POST', body: Buffer.alloc(1_000_001) },
      { resolver, executePinned, onRequestStarted },
    )).rejects.toMatchObject({ code: 'request_body_too_large' });

    expect(resolver).not.toHaveBeenCalled();
    expect(executePinned).not.toHaveBeenCalled();
    expect(onRequestStarted).not.toHaveBeenCalled();
  });

  it('re-resolves, re-pins, and re-gates every physical request across a 307 redirect', async () => {
    const resolver: PublicUrlResolver = vi.fn(async (raw) => ({
      url: new URL(raw),
      ip: '93.184.216.34',
      family: 4,
      addresses: [{ address: '93.184.216.34', family: 4 }],
    }));
    const executePinned = vi.fn()
      .mockResolvedValueOnce({
        status: 307,
        headers: { location: 'https://api.example/final' },
        body: Buffer.alloc(0),
        text: '',
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: Buffer.from('ok'),
        text: 'ok',
      });
    const beforeRequest = vi.fn(async () => undefined);
    const onRequestStarted = vi.fn();
    const body = '{"query":"pump"}';

    await requestPublicHttp(
      'https://api.example/start',
      { method: 'POST', body },
      { resolver, executePinned, beforeRequest, onRequestStarted },
    );

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(executePinned).toHaveBeenCalledTimes(2);
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(onRequestStarted).toHaveBeenCalledTimes(2);
    expect(executePinned.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ method: 'POST', body: Buffer.from(body) }),
      expect.objectContaining({ method: 'POST', body: Buffer.from(body) }),
    ]);
  });

  it('converts POST to GET on a 302 redirect without forwarding body headers', async () => {
    const resolver: PublicUrlResolver = vi.fn(async (raw) => ({
      url: new URL(raw),
      ip: '93.184.216.34',
      family: 4,
      addresses: [{ address: '93.184.216.34', family: 4 }],
    }));
    const executePinned = vi.fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: { location: 'https://api.example/final' },
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
      'https://api.example/start',
      {
        method: 'POST',
        body: '{"query":"pump"}',
        headers: { 'content-type': 'application/json', authorization: 'Bearer retained-same-origin' },
      },
      { resolver, executePinned },
    );

    expect(executePinned.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: 'GET',
      body: undefined,
      headers: { authorization: 'Bearer retained-same-origin' },
    }));
  });

  it('rechecks acquisition authorization before every redirect hop and starts no second wire after denial', async () => {
    const authorizeExternalAction = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const resolver: PublicUrlResolver = vi.fn(async (raw) => ({
      url: new URL(raw),
      ip: '93.184.216.34',
      family: 4,
      addresses: [{ address: '93.184.216.34', family: 4 }],
    }));
    const executePinned = vi.fn(async () => ({
      status: 302,
      headers: { location: 'https://second.example/final' },
      body: Buffer.alloc(0),
      text: '',
    }));

    await expect(
      requestPublicHttp(
        'https://first.example/start',
        { maxRedirects: 3 },
        { resolver, executePinned, authorizeExternalAction },
      ),
    ).rejects.toThrow(/external action denied|suppression_action_gate/i);

    expect(authorizeExternalAction).toHaveBeenCalledTimes(3);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(executePinned).toHaveBeenCalledTimes(1);
  });

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
        { resolver, executePinned }),
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
      { headers: { Authorization: 'Bearer secret', Cookie: 'sid=secret', Accept: 'text/plain',
        },
      },
      { resolver, executePinned },
    );

    expect(executePinned.mock.calls[0][1].headers).toMatchObject({
      Authorization: 'Bearer secret',
      Cookie: 'sid=secret',
      Accept: 'text/plain',
    });
    expect(executePinned.mock.calls[1][1].headers).toEqual({ Accept: 'text/plain',
    });
  });
});
