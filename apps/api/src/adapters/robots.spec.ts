import { describe, expect, it, vi } from 'vitest';
import { EgressBlockedError, ExternalHttpActionDeniedError } from './guarded-http';
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
    const beforeRequest = vi.fn(async () => undefined);
    const onRequestStarted = vi.fn();
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
      isAllowedByRobots('https://robots-redirect.example/private', {
        request,
        resolve,
        beforeRequest,
        onRequestStarted,
      }),
    ).resolves.toBe(false);
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(onRequestStarted).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
  });

  it('在每次真实 robots 请求前重新授权，拒绝时不触发请求', async () => {
    const request = vi.fn();
    const resolve = vi.fn(async (raw: string) => ({
      url: new URL(raw),
      ip: '93.184.216.34',
      family: 4 as const,
      addresses: [{ address: '93.184.216.34', family: 4 as const }],
    }));
    const beforeRequest = vi.fn(async () => {
      throw new Error('provider_disabled');
    });
    const onRequestStarted = vi.fn();

    await expect(
      isAllowedByRobots('https://robots-provider-disabled.example/about', {
        request,
        resolve,
        beforeRequest,
        onRequestStarted,
      }),
    ).rejects.toThrow('provider_disabled');

    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(onRequestStarted).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('workspace-specific action denial is request-local and never poisons the shared origin cache', async () => {
    const origin = 'https://workspace-local-denial.example';
    const resolve = vi.fn(async (raw: string) => ({
      url: new URL(raw),
      ip: '93.184.216.34',
      family: 4 as const,
      addresses: [{ address: '93.184.216.34', family: 4 as const }],
    }));
    const deniedRequest = vi.fn(async () => {
      throw new ExternalHttpActionDeniedError();
    });

    await expect(
      isAllowedByRobots(`${origin}/about`, {
        request: deniedRequest,
        resolve,
      }),
    ).resolves.toBe(false);

    const otherWorkspaceRequest = vi.fn(async () => ({
      ok: true,
      text: 'User-agent: *\nDisallow:',
    }));
    await expect(
      isAllowedByRobots(`${origin}/about`, {
        request: otherWorkspaceRequest as never,
        resolve,
      }),
    ).resolves.toBe(true);
    expect(otherWorkspaceRequest).toHaveBeenCalledOnce();
  });
});
