import { describe, expect, it, vi } from 'vitest';
import { EgressBlockedError } from './guarded-http';
import { isAllowedByRobots, parseWildcardDisallow } from './robots';

describe('robots 合规与 SSRF 入口', () => {
  it('解析通配 UA 的 Disallow', () => {
    expect(
      parseWildcardDisallow('User-agent: *\nDisallow: /admin\nAllow: /admin/public\n'),
    ).toEqual(['/admin']);
  });

  it('目标为 loopback/metadata 时 fail-closed，且不尝试 robots 出网', async () => {
    const request = vi.fn();

    await expect(isAllowedByRobots('http://127.0.0.1/private', { request })).resolves.toBe(
      false,
    );
    await expect(
      isAllowedByRobots('http://169.254.169.254/latest/meta-data/', { request }),
    ).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('robots redirect 的安全拒绝不能降级为 allow', async () => {
    const request = vi.fn(async () => {
      throw new EgressBlockedError('non_global_address');
    });
    const resolve = vi.fn(async (raw: string) => ({
      url: new URL(raw),
      ip: '93.184.216.34',
      family: 4 as const,
      addresses: [{ address: '93.184.216.34', family: 4 as const }],
    }));

    await expect(
      isAllowedByRobots('https://robots-redirect.example/private', { request, resolve }),
    ).resolves.toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });
});
