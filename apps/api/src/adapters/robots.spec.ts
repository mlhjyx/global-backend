import { describe, expect, it, vi } from 'vitest';
import { EgressBlockedError, ExternalHttpActionDeniedError, requestPublicHttp } from './guarded-http';
import { isAllowedByRobots, parseWildcardDisallow } from './robots';

describe('robots 合规与 SSRF 入口', () => {
  it('propagates an around-wrapper ACK failure and does not cache it as robots allow', async () => {
    const origin = 'https://robots-around-ack.example';
    const resolve = vi.fn(async (raw: string) => ({ url: new URL(raw), ip: '93.184.216.34', family: 4 as const,
      addresses: [{ address: '93.184.216.34', family: 4 as const }] }));
    const executePinned = vi.fn(async () => ({ status: 200, headers: {}, body: Buffer.from('User-agent: *\nDisallow:'), text: 'User-agent: *\nDisallow:' }));
    const request: typeof requestPublicHttp = (raw, options, dependencies) => requestPublicHttp(raw, options, { ...dependencies, resolver: resolve, executePinned });
    const dispatchPhysicalWire = async <T>(wire: () => Promise<T>): Promise<T> => { await wire(); throw new Error('ACK_UNKNOWN'); };
    await expect(isAllowedByRobots(`${origin}/about`, { resolve, request, dispatchPhysicalWire })).rejects.toThrow('ACK_UNKNOWN');
    expect(executePinned).toHaveBeenCalledOnce();
    await expect(isAllowedByRobots(`${origin}/about`, { resolve, request })).resolves.toBe(true);
    expect(executePinned).toHaveBeenCalledTimes(2);
  });
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

  it('never degrades a physical-wire fence rejection into robots allow', async () => {
    const physicalFence = Object.assign(new Error('wire denied'), {
      name: 'ExternalHttpPhysicalWireDeniedError',
    });
    const request = vi.fn(async () => Promise.reject(physicalFence));
    const resolve = vi.fn(async (raw: string) => ({
      url: new URL(raw),
      ip: '93.184.216.34',
      family: 4 as const,
      addresses: [{ address: '93.184.216.34', family: 4 as const }],
    }));

    await expect(isAllowedByRobots(
      'https://physical-fence.example/about',
      { request, resolve },
    )).rejects.toBe(physicalFence);
  });
});
