import { describe, expect, it } from 'vitest';
import { httpGetMaterializer } from './http-get.materializer';
import {
  encoded,
  manifestFor,
  streamed,
} from './materializer-fixtures.spec-helper';

const expected = Object.freeze({
  status: 200,
  ok: true,
  sanitizedUrl: 'https://example.com/final',
  blocked: null,
});

describe('httpGetMaterializer', () => {
  it('combines the verified raw text/plain body only with closed trusted facts', async () => {
    const bytes = encoded('hello 中');
    await expect(
      httpGetMaterializer.materialize(
        streamed(bytes, [1]),
        manifestFor('http-get/v1', 'text/plain', bytes),
        expected,
      ),
    ).resolves.toEqual({
      status: 200,
      ok: true,
      mediaType: 'text/plain',
      text: 'hello 中',
      finalUrl: 'https://example.com/final',
    });
  });

  it('treats JSON-looking text as raw body and never as a result envelope', async () => {
    const oldEnvelope = JSON.stringify({
      status: 500,
      ok: false,
      mediaType: 'text/plain',
      text: 'must not be decoded as metadata',
    });
    const bytes = encoded(oldEnvelope);
    await expect(
      httpGetMaterializer.materialize(
        streamed(bytes),
        manifestFor('http-get/v1', 'text/plain', bytes),
        expected,
      ),
    ).resolves.toMatchObject({
      status: 200,
      ok: true,
      text: oldEnvelope,
    });
  });

  it('rejects the prior JSON-envelope path when trusted facts are absent', async () => {
    const bytes = encoded(JSON.stringify({
      status: 200,
      ok: true,
      mediaType: 'text/plain',
      text: 'old envelope',
    }));
    await expect(
      httpGetMaterializer.materialize(
        streamed(bytes),
        manifestFor('http-get/v1', 'text/plain', bytes),
        undefined,
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('restores the existing blocked shape only from explicit blocked facts', async () => {
    const bytes = new Uint8Array();
    await expect(
      httpGetMaterializer.materialize(
        streamed(bytes),
        manifestFor('http-get/v1', 'text/plain', bytes),
        {
          status: 0,
          ok: false,
          sanitizedUrl: null,
          blocked: 'non_global_address',
        },
      ),
    ).resolves.toEqual({
      status: 0,
      ok: false,
      mediaType: 'text/plain',
      text: '',
      blocked: 'non_global_address',
    });

    const nonEmpty = encoded('must be empty when no wire occurred');
    await expect(
      httpGetMaterializer.materialize(
        streamed(nonEmpty),
        manifestFor('http-get/v1', 'text/plain', nonEmpty),
        {
          status: 0,
          ok: false,
          sanitizedUrl: null,
          blocked: 'non_global_address',
        },
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('rejects invalid UTF-8, media mismatch, and mismatched expected facts', async () => {
    const invalidUtf8 = Uint8Array.of(0xc3, 0x28);
    await expect(
      httpGetMaterializer.materialize(
        streamed(invalidUtf8),
        manifestFor('http-get/v1', 'text/plain', invalidUtf8),
        expected,
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');

    const valid = encoded('body');
    await expect(
      httpGetMaterializer.materialize(
        streamed(valid),
        manifestFor('http-get/v1', 'application/json', valid),
        expected,
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
    await expect(
      httpGetMaterializer.materialize(
        streamed(valid),
        manifestFor('http-get/v1', 'text/plain', valid),
        { ...expected, ok: false },
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });
});
