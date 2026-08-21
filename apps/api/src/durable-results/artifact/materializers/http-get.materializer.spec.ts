import { describe, expect, it } from 'vitest';
import { httpGetMaterializer } from './http-get.materializer';
import {
  jsonBytes,
  manifestFor,
  streamed,
} from './materializer-fixtures.spec-helper';

describe('httpGetMaterializer', () => {
  it('restores only the existing closed HttpGetOutput shape from a streamed JSON envelope', async () => {
    const bytes = jsonBytes({
      status: 200,
      ok: true,
      mediaType: 'text/plain',
      text: 'hello 中',
      finalUrl: 'https://example.com/final',
    });
    const output = await httpGetMaterializer.materialize(
      streamed(bytes, [1]),
      manifestFor('http-get/v1', 'text/plain', bytes),
    );
    expect(output).toEqual({
      status: 200,
      ok: true,
      mediaType: 'text/plain',
      text: 'hello 中',
      finalUrl: 'https://example.com/final',
    });
    expect(Object.keys(output).sort()).toEqual([
      'finalUrl', 'mediaType', 'ok', 'status', 'text',
    ]);
  });

  it('restores the bounded blocked result variant without inventing response facts', async () => {
    const bytes = jsonBytes({
      status: 0,
      ok: false,
      mediaType: 'text/plain',
      text: '',
      blocked: 'non_global_address',
    });
    await expect(
      httpGetMaterializer.materialize(
        streamed(bytes),
        manifestFor('http-get/v1', 'text/plain', bytes),
      ),
    ).resolves.toEqual({
      status: 0,
      ok: false,
      mediaType: 'text/plain',
      text: '',
      blocked: 'non_global_address',
    });
  });

  it.each([
    ['missing required field', { status: 200, ok: true, mediaType: 'text/plain' }],
    ['unknown raw headers', { status: 200, ok: true, mediaType: 'text/plain', text: '', headers: { authorization: 'secret' } }],
    ['prompt field', { status: 200, ok: true, mediaType: 'text/plain', text: '', prompt: 'secret' }],
    ['token field', { status: 200, ok: true, mediaType: 'text/plain', text: '', token: 'secret' }],
    ['email field', { status: 200, ok: true, mediaType: 'text/plain', text: '', email: 'person@example.com' }],
    ['inconsistent status', { status: 500, ok: true, mediaType: 'text/plain', text: '' }],
    ['invalid final URL type', { status: 200, ok: true, mediaType: 'text/plain', text: '', finalUrl: 1 }],
    ['invalid final URL scheme', { status: 200, ok: true, mediaType: 'text/plain', text: '', finalUrl: 'file:///etc/passwd' }],
    ['status zero without block', { status: 0, ok: false, mediaType: 'text/plain', text: '' }],
    ['invalid block code', { status: 0, ok: false, mediaType: 'text/plain', text: '', blocked: 'NOT SAFE' }],
    ['blocked result with final URL', { status: 0, ok: false, mediaType: 'text/plain', text: '', blocked: 'invalid_url', finalUrl: 'https://example.com/' }],
  ])('rejects %s', async (_name, value) => {
    const bytes = jsonBytes(value);
    await expect(
      httpGetMaterializer.materialize(
        streamed(bytes),
        manifestFor('http-get/v1', 'text/plain', bytes),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('rejects invalid UTF-8, media mismatch, over-depth JSON, and trailing data', async () => {
    const invalidUtf8 = Uint8Array.of(0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d);
    await expect(
      httpGetMaterializer.materialize(
        streamed(invalidUtf8),
        manifestFor('http-get/v1', 'text/plain', invalidUtf8),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');

    const valid = jsonBytes({ status: 200, ok: true, mediaType: 'text/plain', text: '' });
    await expect(
      httpGetMaterializer.materialize(
        streamed(valid),
        manifestFor('http-get/v1', 'application/json', valid),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');

    const deep = new TextEncoder().encode(`${'['.repeat(33)}null${']'.repeat(33)}`);
    await expect(
      httpGetMaterializer.materialize(
        streamed(deep),
        manifestFor('http-get/v1', 'text/plain', deep),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');

    const trailing = new TextEncoder().encode(`${new TextDecoder().decode(valid)} {}`);
    await expect(
      httpGetMaterializer.materialize(
        streamed(trailing),
        manifestFor('http-get/v1', 'text/plain', trailing),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });
});
