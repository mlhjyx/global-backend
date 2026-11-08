import { describe, expect, it, vi } from 'vitest';
import { EgressBlockedError } from '../../adapters/guarded-http';
import { GuardedChannelHttpClient } from './http-transport';
import type { PublicUrlResolver } from '../../adapters/url-guard';

/** 假的公网解析（不触网）：把任意 host 提升为固定 pin。 */
const resolver: PublicUrlResolver = async (raw) => ({
  url: new URL(raw),
  ip: '93.184.216.34',
  family: 4,
  addresses: [{ address: '93.184.216.34', family: 4 }],
});

function pinnedResult(status: number, headers: Record<string, string> = {}, text = '') {
  return { status, headers, body: Buffer.from(text, 'utf8'), text };
}

describe('渠道物理请求面（失败闭合的出网边界）', () => {
  it('未注入平台围栏绑定时一律拒绝（不存在未治理出网路径）', async () => {
    const client = new GuardedChannelHttpClient({});
    await expect(
      client.request({ url: 'https://api.example.com/x', method: 'GET', headers: {}, allowedHosts: ['api.example.com'] }),
    ).rejects.toMatchObject({ code: 'CHANNEL_EGRESS_DENIED' });
  });

  it('非 https / 主机不在 allowedHosts → 出网前拒绝（零物理请求）', async () => {
    const executePinned = vi.fn();
    const client = new GuardedChannelHttpClient({ beforePhysicalWire: async () => undefined, executePinned, resolver });
    await expect(
      client.request({ url: 'http://api.example.com/x', method: 'GET', headers: {}, allowedHosts: ['api.example.com'] }),
    ).rejects.toMatchObject({ code: 'CHANNEL_EGRESS_DENIED' });
    await expect(
      client.request({ url: 'https://evil.example.org/x', method: 'GET', headers: {}, allowedHosts: ['api.example.com'] }),
    ).rejects.toMatchObject({ code: 'CHANNEL_HOST_NOT_ALLOWED' });
    expect(executePinned).not.toHaveBeenCalled();
  });

  it('重定向逐跳复验：跳到白名单外的主机被拒', async () => {
    const executePinned = vi.fn(async () => pinnedResult(302, { location: 'https://evil.example.org/x' }));
    const client = new GuardedChannelHttpClient({ beforePhysicalWire: async () => undefined, executePinned, resolver });
    await expect(
      client.request({ url: 'https://api.example.com/x', method: 'GET', headers: {}, allowedHosts: ['api.example.com'] }),
    ).rejects.toMatchObject({ code: 'CHANNEL_HOST_NOT_ALLOWED' });
    expect(executePinned).toHaveBeenCalledTimes(1);
  });

  it('响应超限映射 CHANNEL_RESPONSE_TOO_LARGE；超时映射 CHANNEL_TIMEOUT', async () => {
    const tooLarge = new GuardedChannelHttpClient({
      beforePhysicalWire: async () => undefined,
      executePinned: async () => {
        throw new EgressBlockedError('response_too_large');
      },
      resolver,
    });
    await expect(
      tooLarge.request({ url: 'https://api.example.com/x', method: 'GET', headers: {}, allowedHosts: ['api.example.com'] }),
    ).rejects.toMatchObject({ code: 'CHANNEL_RESPONSE_TOO_LARGE' });

    const timeout = new GuardedChannelHttpClient({
      beforePhysicalWire: async () => undefined,
      executePinned: async () => {
        throw new Error('public_http_timeout');
      },
      resolver,
    });
    await expect(
      timeout.request({ url: 'https://api.example.com/x', method: 'GET', headers: {}, allowedHosts: ['api.example.com'] }),
    ).rejects.toMatchObject({ code: 'CHANNEL_TIMEOUT' });
  });

  it('正常 2xx：返回状态/正文/finalUrl，且每跳都过 beforePhysicalWire', async () => {
    const beforePhysicalWire = vi.fn(async () => undefined);
    const executePinned = vi.fn(async () => pinnedResult(200, {}, '{"ok":true}'));
    const client = new GuardedChannelHttpClient({ beforePhysicalWire, executePinned, resolver });
    const response = await client.request({
      url: 'https://api.example.com/items?page=1',
      method: 'GET',
      headers: { Authorization: 'Bearer x' },
      allowedHosts: ['api.example.com'],
    });
    expect(response).toMatchObject({ status: 200, bodyText: '{"ok":true}', finalUrl: 'https://api.example.com/items?page=1' });
    expect(beforePhysicalWire).toHaveBeenCalled();
  });
});
