import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolvePublicIp: vi.fn() }));
vi.mock('./net-guard', () => ({ resolvePublicIp: mocks.resolvePublicIp }));

import { BadRequestException } from '@nestjs/common';
import { assertPublicHttpUrl, resolvePublicHttpUrl } from './url-guard';

beforeEach(() => mocks.resolvePublicIp.mockReset());

describe('resolvePublicHttpUrl pinned public URL admission', () => {
  it.each([
    ['', 'invalid_url'],
    ['not a url', 'invalid_url'],
    ['x'.repeat(2001), 'invalid_url'],
    ['file:///etc/passwd', 'invalid_scheme'],
    ['https://user:pass@example.test/', 'url_credentials_forbidden'],
  ])('rejects %s with stable code %s before DNS', async (raw, code) => {
    await expect(resolvePublicHttpUrl(raw)).rejects.toEqual(expect.objectContaining({ name: 'EgressBlockedError', code }));
    expect(mocks.resolvePublicIp).not.toHaveBeenCalled();
  });

  it('returns the exact pinned IP family and full resolver evidence', async () => {
    mocks.resolvePublicIp.mockResolvedValue({
      safe: true,
      ip: '203.0.113.10',
      family: 4,
      addresses: [{ address: '203.0.113.10', family: 4 }],
    });
    await expect(resolvePublicHttpUrl('https://example.test/path', { timeoutMs: 10 })).resolves.toEqual({
      url: new URL('https://example.test/path'),
      ip: '203.0.113.10',
      family: 4,
      addresses: [{ address: '203.0.113.10', family: 4 }],
    });
    expect(mocks.resolvePublicIp).toHaveBeenCalledWith('example.test', { timeoutMs: 10 });
  });

  it.each([
    [{ safe: false, reason: 'private_ip' }, 'private_ip'],
    [{ safe: false }, 'url_blocked'],
    [{ safe: true, ip: '', family: 4, addresses: [] }, 'url_blocked'],
  ])('fails closed for incomplete or unsafe resolver output %#', async (resolution, code) => {
    mocks.resolvePublicIp.mockResolvedValue(resolution);
    await expect(resolvePublicHttpUrl('https://example.test')).rejects.toEqual(expect.objectContaining({ code }));
  });

  it('controller compatibility maps every internal resolver failure to one non-leaking INVALID_URL envelope', async () => {
    mocks.resolvePublicIp.mockResolvedValue({ safe: false, reason: 'dns_private_ip' });
    const error = await assertPublicHttpUrl('https://example.test').catch((failure) => failure);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toEqual({
      error: { code: 'INVALID_URL', message: 'URL 必须是可解析的公网 http/https 地址' },
    });
    expect(JSON.stringify(error.getResponse())).not.toContain('dns_private_ip');
  });
});
