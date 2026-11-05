import { describe, expect, it } from 'vitest';
import {
  PlatformCrawlGrantClient,
  channelCrawlRequestSha256,
} from './platform-crawl-grant.client';

describe('渠道抓取 Grant 客户端（P4-P4c）', () => {
  it('锁定与 gain-saas 共享的 request 规范摘要向量', () => {
    expect(channelCrawlRequestSha256('55555555-5555-4555-8555-555555555555', 'preview', '1')).toBe(
      '870844370d9ae83fd096ab4c199376a53cda2cb5e87e32fc092dec00c4cae17d',
    );
  });

  it('未配置端点或证书时 configured=false，请求报不可用', async () => {
    const client = new PlatformCrawlGrantClient({});
    expect(client.configured).toBe(false);
    await expect(
      client.requestChannelCrawlGrant({} as never),
    ).rejects.toMatchObject({ code: 'PLATFORM_GRANT_UNAVAILABLE' });
  });

  it('端点必须是目标路径的 https URL', () => {
    for (const endpoint of [
      'http://172.20.0.1:18448/api/internal/v1/platform-channel-crawl-grants',
      'https://172.20.0.1:18448/other',
      'https://user:pass@172.20.0.1:18448/api/internal/v1/platform-channel-crawl-grants',
    ]) {
      expect(
        new PlatformCrawlGrantClient({
          PLATFORM_CHANNEL_CRAWL_GRANT_ENDPOINT: endpoint,
          MACHINE_BOOTSTRAP_CA_FILE: '/nonexistent',
          MACHINE_BOOTSTRAP_CERT_FILE: '/nonexistent',
          MACHINE_BOOTSTRAP_KEY_FILE: '/nonexistent',
        }).configured,
      ).toBe(false);
    }
  });
});
