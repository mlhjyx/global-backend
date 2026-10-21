import { createServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isExecutionControlError } from '../execution-budget/execution-control-error';
import {
  EgressBlockedError,
  PUBLIC_HTTP_OPERATOR_TIMEOUT_MAX_MS,
  PUBLIC_HTTP_TIMEOUT_MAX_MS,
  isPublicHttpTransportFailure,
  requestPublicHttp,
  type PinnedHttpExecutor,
  type PinnedPublicUrl,
  type PublicUrlResolver } from './guarded-http';

const servers: NetServer[] = [];

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
  it('wraps each real loopback redirect wire after DNS and gates, and refuses the second before it reaches the server', async () => {
    const events: string[] = [];
    const server = createServer((req, res) => {
      events.push(`wire:${req.url}`);
      if (req.url === '/start') { res.writeHead(302, { location: '/final' }); res.end('first-body'); }
      else res.end('second-body');
    });
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('bind failed');
    const resolver: PublicUrlResolver = async raw => {
      events.push('dns'); return { url: new URL(raw), ip: '127.0.0.1', family: 4, addresses: [{ address: '127.0.0.1', family: 4 }] };
    };
    let count = 0;
    const dispatchPhysicalWire = async <T>(execute: () => Promise<T>): Promise<T> => {
      events.push(`around:${++count}`); if (count === 2) throw new Error('SECOND_WIRE_DENIED');
      const result = await execute();
      expect((result as { body: Buffer }).body.toString()).toBe('first-body');
      events.push('completed:first'); return result;
    };
    await expect(requestPublicHttp(`http://loopback-wire.example:${address.port}/start`, {}, {
      resolver, authorizeExternalAction: async () => { events.push('auth'); return true; },
      beforePhysicalWire: async () => { events.push('counter'); }, dispatchPhysicalWire,
    })).rejects.toThrow('SECOND_WIRE_DENIED');
    expect(events).toEqual(['auth','dns','auth','counter','around:1','wire:/start','completed:first','auth','dns','auth','counter','around:2']);
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

  it('runs the physical-wire fence exactly once immediately before each redirect wire', async () => {
    const beforePhysicalWire = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('wire counter exhausted'));
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

    await expect(requestPublicHttp(
      'https://first.example/start',
      { maxRedirects: 3 },
      { resolver, executePinned, beforePhysicalWire },
    )).rejects.toMatchObject({
      name: 'ExternalHttpPhysicalWireDeniedError',
      decision: 'physical_wire_gate',
      cause: expect.objectContaining({ message: 'wire counter exhausted' }),
    });

    expect(beforePhysicalWire).toHaveBeenCalledTimes(2);
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

describe('requestPublicHttp — per-hop deadline ceilings', () => {
  const resolver: PublicUrlResolver = async (raw) => ({
    url: new URL(raw),
    ip: '93.184.216.34',
    family: 4,
    addresses: [{ address: '93.184.216.34', family: 4 }],
  });
  const answered = () =>
    vi.fn<PinnedHttpExecutor>(async () => ({ status: 200, headers: {}, body: Buffer.from('ok'), text: 'ok' }));

  it('holds every runtime caller to 30 seconds per hop, however long a timeout it asks for', async () => {
    const executePinned = answered();
    await requestPublicHttp('https://list.example/file.xml', { timeoutMs: 600_000 }, { resolver, executePinned });

    expect(PUBLIC_HTTP_TIMEOUT_MAX_MS).toBe(30_000);
    expect(executePinned.mock.calls[0]![1].timeoutMs).toBe(PUBLIC_HTTP_TIMEOUT_MAX_MS);
  });

  it('lets an owner-run operator download wait longer per hop, up to its own ceiling', async () => {
    const executePinned = answered();
    await requestPublicHttp(
      'https://list.example/file.xml',
      { timeoutMs: 1_000, operatorTimeoutMs: 600_000 },
      { resolver, executePinned },
    );
    expect(executePinned.mock.calls[0]![1].timeoutMs).toBe(600_000);

    const capped = answered();
    await requestPublicHttp(
      'https://list.example/file.xml',
      { operatorTimeoutMs: 10 * PUBLIC_HTTP_OPERATOR_TIMEOUT_MAX_MS },
      { resolver, executePinned: capped },
    );
    expect(capped.mock.calls[0]![1].timeoutMs).toBe(PUBLIC_HTTP_OPERATOR_TIMEOUT_MAX_MS);
    expect(PUBLIC_HTTP_OPERATOR_TIMEOUT_MAX_MS).toBe(1_800_000);
  });
});

describe('requestPublicHttp — a site\'s own transport failure is marked, nothing else is', () => {
  const loopback: PublicUrlResolver = async (raw) => ({
    url: new URL(raw),
    ip: '127.0.0.1',
    family: 4,
    addresses: [{ address: '127.0.0.1', family: 4 }],
  });

  async function listen(server: NetServer): Promise<number> {
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    return address.port;
  }

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => { throw new Error('expected the request to fail'); },
      (error: unknown) => error,
    );
  }

  it('marks a TLS handshake the site resets, and leaves the classifier\'s verdict on it unchanged', async () => {
    const port = await listen(createNetServer((socket) => socket.destroy()));

    const error = await rejection(
      requestPublicHttp(`https://reset.example:${port}/sitemap.xml`, { timeoutMs: 5_000 }, { resolver: loopback }),
    );

    expect(error).toBeInstanceOf(Error);
    expect(isPublicHttpTransportFailure(error)).toBe(true);
    // Only the consumer that opts in treats it as a site's miss; everyone else still fails closed.
    expect(isExecutionControlError(error)).toBe(true);
  });

  it('marks a response socket the site hangs up', async () => {
    const port = await listen(createServer((req) => req.socket.destroy()));

    const error = await rejection(
      requestPublicHttp(`http://hangup.example:${port}/`, { timeoutMs: 5_000 }, { resolver: loopback }),
    );

    expect(isPublicHttpTransportFailure(error)).toBe(true);
  });

  it('does not mark the wall-clock deadline, which is a plain failure already', async () => {
    const port = await listen(createServer(() => undefined));

    const error = await rejection(
      requestPublicHttp(`http://slow.example:${port}/`, { timeoutMs: 100 }, { resolver: loopback }),
    );

    expect(error).toMatchObject({ message: 'public_http_timeout' });
    expect(isPublicHttpTransportFailure(error)).toBe(false);
    expect(isExecutionControlError(error)).toBe(false);
  });

  it('never marks a gate, an egress refusal or an oversized body', async () => {
    const port = await listen(createServer((_req, res) => res.end('x'.repeat(64))));
    const url = `http://gated.example:${port}/`;

    const denied = await rejection(
      requestPublicHttp(url, {}, { resolver: loopback, authorizeExternalAction: async () => false }),
    );
    const fenced = await rejection(
      requestPublicHttp(url, {}, {
        resolver: loopback,
        beforePhysicalWire: async () => { throw new Error('wire counter exhausted'); },
      }),
    );
    const blocked = await rejection(
      requestPublicHttp(url, {}, {
        resolver: async () => { throw new EgressBlockedError('non_global_address'); },
      }),
    );
    const oversized = await rejection(requestPublicHttp(url, { maxBytes: 8 }, { resolver: loopback }));

    for (const error of [denied, fenced, blocked, oversized]) {
      expect(isPublicHttpTransportFailure(error)).toBe(false);
    }
    expect(oversized).toMatchObject({ name: 'EgressBlockedError', code: 'response_too_large' });
  });

  it('marks by identity only, so an error built to look like a socket failure is not marked', () => {
    const lookalike = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
      host: 'reset.example',
      port: 443,
    });

    expect(isPublicHttpTransportFailure(lookalike)).toBe(false);
    expect(isPublicHttpTransportFailure(undefined)).toBe(false);
    expect(isPublicHttpTransportFailure('ECONNRESET')).toBe(false);
  });
});
