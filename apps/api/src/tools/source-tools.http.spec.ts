import { gzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestPublicHttp: vi.fn() }));

vi.mock('../adapters/guarded-http', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/guarded-http')>();
  return { ...original, requestPublicHttp: mocks.requestPublicHttp };
});

import { EgressBlockedError } from '../adapters/guarded-http';
import { httpGetTool } from './source-tools';

describe('http.get governed wrapper', () => {
  beforeEach(() => mocks.requestPublicHttp.mockReset());

  it('uses stable default/explicit method identities', () => {
    expect(httpGetTool.idempotencyKey({ url: 'https://example.test/x' })).toBe(
      httpGetTool.idempotencyKey({ url: 'https://example.test/x', method: 'GET' }),
    );
    expect(httpGetTool.idempotencyKey({ url: 'https://example.test/x', method: 'HEAD' })).not.toBe(
      httpGetTool.idempotencyKey({ url: 'https://example.test/x' }),
    );
  });

  it('returns bounded plain text with caller headers and transport provenance', async () => {
    mocks.requestPublicHttp.mockResolvedValue({
      status: 200,
      ok: true,
      body: Buffer.from('hello'),
      finalUrl: 'https://example.test/final',
    });
    await expect(
      httpGetTool.execute(
        { url: 'https://example.test/x', headers: { Accept: 'text/plain' }, timeoutMs: 1234 },
        { workspaceId: 'ws' },
      ),
    ).resolves.toEqual({
      data: { status: 200, ok: true, text: 'hello', finalUrl: 'https://example.test/final' },
      costCents: 0,
    });
    expect(mocks.requestPublicHttp).toHaveBeenCalledWith(
      'https://example.test/x',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Accept: 'text/plain', 'User-Agent': expect.any(String) }),
        timeoutMs: 1234,
        maxRedirects: 3,
      }),
      expect.objectContaining({ authorizeExternalAction: undefined }),
    );
  });

  it('decodes valid gzip, retains damaged gzip fail-safe, and emits no HEAD body', async () => {
    mocks.requestPublicHttp
      .mockResolvedValueOnce({ status: 200, ok: true, body: gzipSync(Buffer.from('sitemap')), finalUrl: 'https://example.test/sitemap.xml.gz' })
      .mockResolvedValueOnce({ status: 200, ok: true, body: Buffer.from([0x1f, 0x8b, 0x00]), finalUrl: 'https://example.test/bad.gz' })
      .mockResolvedValueOnce({ status: 204, ok: true, body: Buffer.from('must-not-leak'), finalUrl: 'https://example.test/' });
    await expect(httpGetTool.execute({ url: 'https://example.test/good' }, { workspaceId: 'ws' })).resolves.toMatchObject({
      data: { text: 'sitemap' },
    });
    const damaged = await httpGetTool.execute({ url: 'https://example.test/bad' }, { workspaceId: 'ws' });
    expect(damaged.data.text.length).toBeGreaterThan(0);
    await expect(httpGetTool.execute({ url: 'https://example.test/', method: 'HEAD' }, { workspaceId: 'ws' })).resolves.toMatchObject({
      data: { status: 204, text: '' },
    });
  });

  it('converts only guarded egress denials and rethrows unrelated failures', async () => {
    mocks.requestPublicHttp.mockRejectedValueOnce(new EgressBlockedError('dns_private_ip'));
    await expect(httpGetTool.execute({ url: 'https://example.test/' }, { workspaceId: 'ws' })).resolves.toEqual({
      data: { status: 0, ok: false, text: '', blocked: 'dns_private_ip' },
      costCents: 0,
    });
    mocks.requestPublicHttp.mockRejectedValueOnce(new Error('transport down'));
    await expect(httpGetTool.execute({ url: 'https://example.test/' }, { workspaceId: 'ws' })).rejects.toThrow('transport down');
  });
});
