import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedJwksFetch } from './jwks-token-verifier';

function stubFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn(async () => response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('boundedJwksFetch', () => {
  it('rejects documents with an oversized content-length before reading the body', async () => {
    stubFetch(
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(64 * 1024 + 1) },
      }),
    );
    await expect(boundedJwksFetch('https://issuer.test/jwks')).rejects.toThrow(
      /exceeds size limit/,
    );
  });

  it('rejects documents whose body exceeds the limit without a content-length', async () => {
    stubFetch(new Response('x'.repeat(64 * 1024 + 1), { status: 200 }));
    await expect(boundedJwksFetch('https://issuer.test/jwks')).rejects.toThrow(
      /exceeds size limit/,
    );
  });

  it('passes through a normal JWKS document', async () => {
    stubFetch(
      new Response('{"keys":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const response = await boundedJwksFetch('https://issuer.test/jwks');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"keys":[]}');
  });
});
