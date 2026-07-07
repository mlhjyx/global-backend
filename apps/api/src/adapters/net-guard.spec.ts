import { describe, expect, it } from 'vitest';
import { isPrivateIp, resolvePublicIp } from './net-guard';

describe('SSRF 出网护栏', () => {
  it('isPrivateIp：私网/保留/链路本地/CGNAT/回环 → true', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.5.9', '172.31.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fd12::3', 'fe80::1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('isPrivateIp：公网 → false', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '52.10.20.30', '172.15.0.1', '172.32.0.1', '11.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });

  it('resolvePublicIp：IP 字面量直接拒（不接受直接给 IP 目标，防绕过 DNS 校验）', async () => {
    expect((await resolvePublicIp('169.254.169.254')).safe).toBe(false);
    expect((await resolvePublicIp('10.0.0.1')).reason).toBe('ip_literal_not_allowed');
    expect((await resolvePublicIp('::1')).safe).toBe(false);
  });
});
