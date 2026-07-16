import { describe, expect, it } from 'vitest';
import { httpGetTool } from './source-tools';

describe('http.get 复用统一 egress gate', () => {
  it.each([
    ['http://127.0.0.1/admin', 'ip_literal_not_allowed'],
    ['http://169.254.169.254/latest/meta-data/', 'ip_literal_not_allowed'],
    ['file:///etc/passwd', 'invalid_scheme'],
  ])('不出网并结构化拒绝 %s', async (url, reason) => {
    const result = await httpGetTool.execute(
      { url },
      { workspaceId: 'test', purpose: ['discovery'] },
    );

    expect(result.data).toMatchObject({ status: 0, ok: false, text: '', blocked: reason });
    expect(result.costCents).toBe(0);
  });
});
