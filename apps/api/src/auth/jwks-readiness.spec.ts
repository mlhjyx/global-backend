import { describe, expect, it, vi } from 'vitest';
import { probeJwksDocument, validJwksDocument } from './jwks-readiness';

const valid = {
  keys: [{ kty: 'RSA', kid: 'signing-key-1', n: 'modulus', e: 'AQAB', use: 'sig' }],
};

describe('JWKS readiness probe', () => {
  it('accepts only a bounded document with at least one usable signing key', async () => {
    expect(validJwksDocument(valid)).toBe(true);
    expect(validJwksDocument({ keys: [] })).toBe(false);
    expect(validJwksDocument({ keys: [{ kty: 'RSA', kid: 'x' }] })).toBe(false);
    await expect(probeJwksDocument('https://identity.example.test/jwks', vi.fn(async () => new Response(JSON.stringify(valid), { status: 200 })))).resolves.toBe(true);
  });

  it('fails closed for HTTP-success HTML and never permits redirects', async () => {
    const fetcher = vi.fn(async () => new Response('<html>proxy error</html>', { status: 200 }));
    await expect(probeJwksDocument('https://identity.example.test/jwks', fetcher)).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledWith(
      'https://identity.example.test/jwks',
      expect.objectContaining({ redirect: 'error' }),
    );
  });
});
