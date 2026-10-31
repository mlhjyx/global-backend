import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPrivateIp, parseDohEndpoints, resolvePublicIp, type HostResolver } from './net-guard';

describe('SSRF 出网护栏', () => {
  it('isPrivateIp：所有非全局地址与 IPv6 过渡形态均拒绝', () => {
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '172.16.5.9',
      '172.31.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '192.0.2.1',
      '198.18.0.25',
      '224.0.0.1',
      '::1',
      'fc00::1',
      'fd12::3',
      'fe80::1',
      '::ffff:127.0.0.1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('isPrivateIp：公网 → false', () => {
    for (const ip of [
      '8.8.8.8',
      '1.1.1.1',
      '52.10.20.30',
      '172.15.0.1',
      '172.32.0.1',
      '11.0.0.1',
      '2001:4860:4860::8888',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('resolvePublicIp：IP 字面量直接拒（不接受直接给 IP 目标，防绕过 DNS 校验）', async () => {
    expect((await resolvePublicIp('169.254.169.254')).safe).toBe(false);
    expect((await resolvePublicIp('10.0.0.1')).reason).toBe('ip_literal_not_allowed');
    expect((await resolvePublicIp('::1')).safe).toBe(false);
  });

  it('mihomo 的全部 fake-IP 答案触发固定 DoH 回退，并返回真实公网 pin', async () => {
    const systemLookup: HostResolver = vi.fn(async () => [
      { address: '198.18.0.25', family: 4 },
    ]);
    const dohLookup: HostResolver = vi.fn(async () => [
      { address: '104.20.23.154', family: 4 },
      { address: '2606:4700:10::6814:179a', family: 6 },
    ]);

    const result = await resolvePublicIp('example.com', { systemLookup, dohLookup });

    expect(result).toMatchObject({
      safe: true,
      ip: '104.20.23.154',
      family: 4,
      addresses: [
        { address: '104.20.23.154', family: 4 },
        { address: '2606:4700:10::6814:179a', family: 6 },
      ],
    });
    expect(dohLookup).toHaveBeenCalledOnce();
  });

  it('保留全部已验证的双栈地址供连接层安全回退', async () => {
    const result = await resolvePublicIp('dual-stack.example', {
      systemLookup: async () => [
        { address: '2606:4700:10::6814:179a', family: 6 },
        { address: '104.20.23.154', family: 4 },
      ],
    });

    expect(result.addresses).toEqual([
      { address: '2606:4700:10::6814:179a', family: 6 },
      { address: '104.20.23.154', family: 4 },
    ]);
  });

  it('真实私网或公私混合答案不借 DoH 洗白，直接 fail-closed', async () => {
    const dohLookup: HostResolver = vi.fn(async () => [
      { address: '104.20.23.154', family: 4 },
    ]);
    const privateResult = await resolvePublicIp('private.example', {
      systemLookup: async () => [{ address: '10.0.0.5', family: 4 }],
      dohLookup,
    });
    const mixedResult = await resolvePublicIp('mixed.example', {
      systemLookup: async () => [
        { address: '198.18.0.25', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      dohLookup,
    });

    expect(privateResult).toMatchObject({ safe: false, reason: 'non_global_address' });
    expect(mixedResult).toMatchObject({ safe: false, reason: 'non_global_address' });
    expect(dohLookup).not.toHaveBeenCalled();
  });

  it('mihomo 开 IPv6 时 A/AAAA 全是 fake-IP（198.18/15 + fdfe:dcba:9876::/64）同样触发 DoH 回退', async () => {
    const systemLookup: HostResolver = vi.fn(async () => [
      { address: 'fdfe:dcba:9876::26', family: 6 },
      { address: '198.18.0.38', family: 4 },
    ]);
    const dohLookup: HostResolver = vi.fn(async () => [
      { address: '104.20.23.154', family: 4 },
    ]);

    const result = await resolvePublicIp('example.com', { systemLookup, dohLookup });

    expect(result).toMatchObject({ safe: true, ip: '104.20.23.154', family: 4 });
    expect(dohLookup).toHaveBeenCalledOnce();
  });

  it('只有 IPv6 fake-IP 答案时也触发 DoH 回退', async () => {
    const dohLookup: HostResolver = vi.fn(async () => [
      { address: '2606:4700:10::6814:179a', family: 6 },
    ]);

    const result = await resolvePublicIp('v6-only.example', {
      systemLookup: async () => [{ address: 'fdfe:dcba:9876::1e', family: 6 }],
      dohLookup,
    });

    expect(result).toMatchObject({ safe: true, ip: '2606:4700:10::6814:179a', family: 6 });
    expect(dohLookup).toHaveBeenCalledOnce();
  });

  it('IPv6 fake-IP 段之外的 ULA、或 IPv6 fake-IP 混入真实私网，都不借 DoH 洗白', async () => {
    const dohLookup: HostResolver = vi.fn(async () => [
      { address: '104.20.23.154', family: 4 },
    ]);
    const neighbourUla = await resolvePublicIp('ula.example', {
      systemLookup: async () => [{ address: 'fdfe:dcba:9876:1::1e', family: 6 }],
      dohLookup,
    });
    const mixed = await resolvePublicIp('mixed-v6.example', {
      systemLookup: async () => [
        { address: 'fdfe:dcba:9876::26', family: 6 },
        { address: 'fd12::3', family: 6 },
      ],
      dohLookup,
    });

    expect(neighbourUla).toMatchObject({ safe: false, reason: 'non_global_address' });
    expect(mixed).toMatchObject({ safe: false, reason: 'non_global_address' });
    expect(dohLookup).not.toHaveBeenCalled();
  });

  it('isPrivateIp：IPv6 fake-IP 地址本身仍按非全局地址拒绝', () => {
    expect(isPrivateIp('fdfe:dcba:9876::26')).toBe(true);
  });

  it('DoH 回退若返回 metadata/私网仍拒绝', async () => {
    const result = await resolvePublicIp('poisoned.example', {
      systemLookup: async () => [{ address: '198.18.0.88', family: 4 }],
      dohLookup: async () => [{ address: '169.254.169.254', family: 4 }],
    });

    expect(result).toMatchObject({ safe: false, reason: 'non_global_address' });
  });
});


describe('DoH 端点：可配置与顺序回退', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const DEFAULTS = [
    'https://cloudflare-dns.com/dns-query',
    'https://dns.google/resolve',
  ];

  it('parseDohEndpoints：缺省两个端点；空串回落缺省；非法项剔除；去重保序', () => {
    expect(parseDohEndpoints(undefined)).toEqual(DEFAULTS);
    expect(parseDohEndpoints('   ')).toEqual(DEFAULTS);
    expect(
      parseDohEndpoints(
        ' https://a.example/q , http://insecure.example/q, not-a-url, https://a.example/q, https://b.example/q ',
      ),
    ).toEqual(['https://a.example/q', 'https://b.example/q']);
    // 全部非法 → 回落缺省，而不是空列表（防一处配错误伤全部出网解析）
    expect(parseDohEndpoints('http://insecure.example/q, ://bad')).toEqual(DEFAULTS);
  });

  it('第一个端点失败时按配置顺序回退到下一个', async () => {
    vi.stubEnv('NET_GUARD_DOH_ENDPOINTS', 'https://broken.example/q,https://working.example/q');
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith('https://broken.example/')) throw new Error('econnreset');
        const type = new URL(url).searchParams.get('type');
        const answer =
          type === 'A'
            ? [{ type: 1, data: '104.20.23.154' }]
            : [{ type: 28, data: '2606:4700:10::6814:179a' }];
        return { ok: true, json: async () => ({ Status: 0, Answer: answer }) } as unknown as Response;
      }),
    );

    const result = await resolvePublicIp('example.com', {
      systemLookup: async () => [{ address: '198.18.0.25', family: 4 }],
    });

    expect(result).toMatchObject({ safe: true, ip: '104.20.23.154', family: 4 });
    expect(calls.some((u) => u.startsWith('https://broken.example/'))).toBe(true);
    expect(calls.some((u) => u.startsWith('https://working.example/'))).toBe(true);
  });

  it('所有端点都失败 → dns_lookup_failed（fail-closed）', async () => {
    vi.stubEnv('NET_GUARD_DOH_ENDPOINTS', 'https://a.example/q,https://b.example/q');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('blocked'); }));

    const result = await resolvePublicIp('example.com', {
      systemLookup: async () => [{ address: '198.18.0.25', family: 4 }],
    });

    expect(result).toMatchObject({ safe: false, reason: 'dns_lookup_failed' });
  });

  it('未配置时按缺省顺序先 Cloudflare 再 Google', async () => {
    const hosts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string) => {
        const url = new URL(String(input));
        hosts.push(url.host);
        if (url.host === 'cloudflare-dns.com') throw new Error('blocked');
        const type = url.searchParams.get('type');
        const answer = type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [];
        return { ok: true, json: async () => ({ Status: 0, Answer: answer }) } as unknown as Response;
      }),
    );

    const result = await resolvePublicIp('example.com', {
      systemLookup: async () => [{ address: '198.18.0.25', family: 4 }],
    });

    expect(result).toMatchObject({ safe: true, ip: '93.184.216.34' });
    expect(hosts[0]).toBe('cloudflare-dns.com');
    expect(hosts).toContain('dns.google');
  });
});
