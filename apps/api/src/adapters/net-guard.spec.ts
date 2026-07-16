import { describe, expect, it, vi } from 'vitest';
import { isPrivateIp, resolvePublicIp, type HostResolver } from './net-guard';

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

    expect(result).toMatchObject({ safe: true, ip: '104.20.23.154', family: 4 });
    expect(dohLookup).toHaveBeenCalledOnce();
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

  it('DoH 回退若返回 metadata/私网仍拒绝', async () => {
    const result = await resolvePublicIp('poisoned.example', {
      systemLookup: async () => [{ address: '198.18.0.88', family: 4 }],
      dohLookup: async () => [{ address: '169.254.169.254', family: 4 }],
    });

    expect(result).toMatchObject({ safe: false, reason: 'non_global_address' });
  });
});
