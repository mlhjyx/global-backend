import { describe, expect, it } from 'vitest';
import { PlatformGrantClient, PlatformGrantClientError } from './platform-grant.client';

const request = {
  scheduleId: 'acq-sweep',
  purpose: 'platform.acquisition',
  workflowId: 'acq-sweep-workflow',
  workflowRunId: '33333333-3333-4333-8333-333333333333',
  scheduleRequestSha256: 'a'.repeat(64),
  technicalPolicyRevision: 'b'.repeat(64),
  capPerRunMicrousd: '1',
  campaignCapMicrousd: '1',
};

describe('平台 Grant 客户端配置', () => {
  it('未配置端点或证书时 configured=false，issue 报不可用（不发起请求）', async () => {
    const client = new PlatformGrantClient({});
    expect(client.configured).toBe(false);
    await expect(client.issue(request as never)).rejects.toMatchObject({
      code: 'PLATFORM_GRANT_UNAVAILABLE',
    });
  });

  it('端点必须是目标路径的 https URL', () => {
    for (const endpoint of [
      'http://172.20.0.1:18448/api/internal/v1/platform-schedule-grants',
      'https://172.20.0.1:18448/other',
      'https://user:pass@172.20.0.1:18448/api/internal/v1/platform-schedule-grants',
    ]) {
      expect(
        new PlatformGrantClient({
          PLATFORM_GRANT_ENDPOINT: endpoint,
          MACHINE_BOOTSTRAP_CA_FILE: '/nonexistent',
          MACHINE_BOOTSTRAP_CERT_FILE: '/nonexistent',
          MACHINE_BOOTSTRAP_KEY_FILE: '/nonexistent',
        }).configured,
      ).toBe(false);
    }
  });
});
