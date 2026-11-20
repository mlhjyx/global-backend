import { describe, expect, it, vi } from 'vitest';
import { EgressBlockedError, ExternalHttpActionDeniedError, requestPublicHttp } from './guarded-http';
import { isAllowedByRobots, parseWildcardDisallow } from './robots';

describe('robots 合规与 SSRF 入口', () => {
  const resolvePublic = async (raw: string) => ({
    url: new URL(raw), ip: '93.184.216.34', family: 4 as const,
    addresses: [{ address: '93.184.216.34', family: 4 as const }],
  });

  for (const failure of ['network', 'http-500', 'http-503'] as const) {
    for (const paths of [['/', '/products/pump'], ['/products/pump', '/']] as const) {
      it(`${failure}: homepage-only fallback survives cache reuse in order ${paths.join(' then ')}`, async () => {
        const origin = `https://${failure}-${paths[0] === '/' ? 'home' : 'deep'}-fallback.example`;
        const request = vi.fn(async () => {
          if (failure === 'network') throw new Error('connection reset');
          return { ok: false, status: failure === 'http-500' ? 500 : 503, text: '' };
        });
        for (const path of paths) {
          await expect(isAllowedByRobots(`${origin}${path}`, {
            resolve: resolvePublic, request: request as never,
          })).resolves.toBe(path === '/');
        }
        expect(request).toHaveBeenCalledOnce();
      });
    }
  }

  it.each([
    [200, '', '/products/pump', true],
    [200, '<html>homepage</html>', '/products/pump', true],
    [404, '', '/products/pump', true],
    [403, '', '/products/pump', true],
    [200, 'User-agent: *\nDisallow: /products', '/products/pump', false],
    [200, 'User-agent: *\nDisallow: /products', '/', true],
  ])('preserves status %s rules %s for path %s', async (status, text, path, allowed) => {
    const origin = `https://success-${status}-${allowed}-${text.length}-${path.length}.example`;
    const request = vi.fn(async () => ({ ok: status === 200, status, text }));
    await expect(isAllowedByRobots(`${origin}${path}`, {
      resolve: resolvePublic, request: request as never,
    })).resolves.toBe(allowed);
  });

  it('checks workspace authorization and target resolution even when fallback is cached', async () => {
    const origin = 'https://fallback-admission.example';
    const request = vi.fn(async () => { throw new Error('timeout'); });
    await expect(isAllowedByRobots(origin, { resolve: resolvePublic, request })).resolves.toBe(true);
    await expect(isAllowedByRobots(origin, {
      resolve: resolvePublic, request, authorizeExternalAction: async () => false,
    })).resolves.toBe(false);
    await expect(isAllowedByRobots(origin, {
      resolve: async () => { throw new EgressBlockedError('non_global_address'); }, request,
    })).resolves.toBe(false);
    await expect(isAllowedByRobots(`${origin}/products`, {
      resolve: resolvePublic, request, authorizeExternalAction: async () => true,
    })).resolves.toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(['non_global_address', 'response_too_large'])('security rejection %s blocks even homepage and caches denial', async (reason) => {
    const origin = `https://security-${reason}.example`;
    const request = vi.fn(async () => { throw new EgressBlockedError(reason); });
    for (const path of ['/', '/products']) {
      await expect(isAllowedByRobots(`${origin}${path}`, {
        resolve: resolvePublic, request,
      })).resolves.toBe(false);
    }
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not cache physical fence rejection across requests', async () => {
    const origin = 'https://physical-fence-retry.example';
    const error = Object.assign(new Error('wire denied'), { name: 'ExternalHttpPhysicalWireDeniedError' });
    await expect(isAllowedByRobots(origin, {
      resolve: resolvePublic, request: async () => { throw error; },
    })).rejects.toBe(error);
    await expect(isAllowedByRobots(`${origin}/products`, {
      resolve: resolvePublic, request: (async () => ({ ok: true, status: 200, text: '' })) as never,
    })).resolves.toBe(true);
  });

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
