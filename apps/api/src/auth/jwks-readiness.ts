const MAX_JWKS_BYTES = 64 * 1024;

export type JwksProbeFetch = (
  input: string,
  init: RequestInit,
) => Promise<Pick<Response, 'ok' | 'body'>>;

function acceptedKey(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  if (typeof key.kid !== 'string' || key.kid.length < 1 || key.kid.length > 128) return false;
  if (key.use !== undefined && key.use !== 'sig') return false;
  if (key.kty === 'RSA') return typeof key.n === 'string' && typeof key.e === 'string';
  if (key.kty === 'EC') return typeof key.crv === 'string' && typeof key.x === 'string' && typeof key.y === 'string';
  if (key.kty === 'OKP') return typeof key.crv === 'string' && typeof key.x === 'string';
  return false;
}

export function validJwksDocument(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = (value as Record<string, unknown>).keys;
  return Array.isArray(keys) && keys.length > 0 && keys.length <= 64 && keys.some(acceptedKey);
}

async function boundedJson(response: Pick<Response, 'body'>): Promise<unknown> {
  if (!response.body) throw new Error('JWKS_BODY_MISSING');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_JWKS_BYTES) throw new Error('JWKS_BODY_TOO_LARGE');
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
    await response.body.cancel().catch(() => undefined);
  }
  return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
}

/** Performs a bounded, redirect-free JWKS content probe without retaining keys. */
export async function probeJwksDocument(
  url: string,
  fetcher: JwksProbeFetch = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  timeout.unref();
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: { Accept: 'application/jwk-set+json, application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    return response.ok && validJwksDocument(await boundedJson(response));
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
