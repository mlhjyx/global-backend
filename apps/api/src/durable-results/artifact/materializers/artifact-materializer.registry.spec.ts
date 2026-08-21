import { describe, expect, it } from 'vitest';
import {
  ArtifactMaterializerRegistry,
  REQUIRED_ARTIFACT_RESULT_SCHEMAS,
  closedJsonRecord,
  readBoundedArtifactJson,
  readBoundedArtifactUtf8,
  type ArtifactPayloadContract,
} from '../artifact-materializer.registry';
import type { ArtifactMaterializer } from '../artifact.types';
import { crawl4aiMaterializers } from './crawl4ai.materializer';
import { httpGetMaterializer } from './http-get.materializer';
import { sanctionsDownloadMaterializer } from './sanctions-download.materializer';
import {
  encoded,
  jsonBytes,
  manifestFor,
  streamed,
} from './materializer-fixtures.spec-helper';

const definitions = [
  sanctionsDownloadMaterializer,
  httpGetMaterializer,
  ...crawl4aiMaterializers,
] as const;
const HTTP_CONTRACT: ArtifactPayloadContract = Object.freeze({
  resultSchema: 'http-get/v1',
  mediaTypes: new Set(['text/plain']),
  maxBytes: 3_000_000,
});

describe('ArtifactMaterializerRegistry', () => {
  it('registers exactly the four approved schema IDs and dispatches by the bound manifest schema', async () => {
    const registry = new ArtifactMaterializerRegistry(definitions);
    expect(registry.resultSchemas()).toEqual(REQUIRED_ARTIFACT_RESULT_SCHEMAS);

    const bytes = jsonBytes({
      status: 200,
      ok: true,
      mediaType: 'text/plain',
      text: 'bounded',
    });
    await expect(
      registry.materialize(
        'http-get/v1',
        streamed(bytes),
        manifestFor('http-get/v1', 'text/plain', bytes),
      ),
    ).resolves.toEqual({
      status: 200,
      ok: true,
      mediaType: 'text/plain',
      text: 'bounded',
    });
  });

  it('rejects duplicate, missing, and unapproved schema definitions at startup', () => {
    expect(
      () => new ArtifactMaterializerRegistry([...definitions, httpGetMaterializer]),
    ).toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
    expect(
      () => new ArtifactMaterializerRegistry(definitions.slice(1)),
    ).toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
    expect(
      () =>
        new ArtifactMaterializerRegistry([
          ...definitions.slice(0, -1),
          Object.freeze({
            resultSchema: 'caller-selected/v1',
            materialize: async () => ({}),
          }),
        ]),
    ).toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('rejects non-closed, accessor-backed, and reflection-hostile definitions', () => {
    const invalidDefinitions: unknown[] = [
      null,
      [],
      Object.create(null),
      { resultSchema: 'crawl4ai-render/v1', materialize: async () => ({}), extra: true },
      Object.defineProperties({}, {
        resultSchema: { enumerable: true, get: () => 'crawl4ai-render/v1' },
        materialize: { enumerable: true, value: async () => ({}) },
      }),
      new Proxy({}, { ownKeys: () => { throw new Error('must be bounded'); } }),
    ];
    for (const definition of invalidDefinitions) {
      expect(
        () => new ArtifactMaterializerRegistry([
          ...definitions.slice(0, -1),
          definition as ArtifactMaterializer<unknown>,
        ]),
      ).toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
    }
  });

  it('snapshots trusted definition functions so post-startup mutation cannot replace dispatch', async () => {
    const mutable: ArtifactMaterializer<unknown>[] = definitions.map(
      (definition) => ({ ...definition }),
    );
    const original = mutable[1]!.materialize;
    const registry = new ArtifactMaterializerRegistry(mutable);
    mutable[1]!.materialize = async () => ({ compromised: true });

    const bytes = jsonBytes({
      status: 200,
      ok: true,
      mediaType: 'text/plain',
      text: 'original',
    });
    const result = await registry.materialize<Record<string, unknown>>(
      'http-get/v1',
      streamed(bytes),
      manifestFor('http-get/v1', 'text/plain', bytes),
    );
    expect(original).not.toBe(mutable[1]!.materialize);
    expect(result).toMatchObject({ text: 'original' });
    expect(result).not.toHaveProperty('compromised');
  });

  it('rejects a requested schema that differs from the closed manifest binding', async () => {
    const registry = new ArtifactMaterializerRegistry(definitions);
    const bytes = encoded('<sdnList/>');
    await expect(
      registry.materialize(
        'http-get/v1',
        streamed(bytes),
        manifestFor('sanctions-download/v1', 'application/xml', bytes),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('parses strict bounded JSON primitives, arrays, escapes, and null-prototype records', async () => {
    const bytes = encoded(
      ' { "empty": {}, "array": [true, false, null, 1.5e2], "escaped": "a\\\\b\\u4e2d" } ',
    );
    const parsed = await readBoundedArtifactJson(
      streamed(bytes),
      manifestFor('http-get/v1', 'text/plain', bytes),
      HTTP_CONTRACT,
    );
    const record = closedJsonRecord(parsed, ['empty', 'array', 'escaped']);
    expect(Object.getPrototypeOf(record)).toBeNull();
    expect(record.array).toEqual([true, false, null, 150]);
    expect(record.escaped).toBe('a\\b中');
  });

  it.each([
    ['duplicate key', '{"x":1,"x":2}'],
    ['reserved key', '{"__proto__":1}'],
    ['missing colon', '{"x" 1}'],
    ['missing comma', '{"x":1 "y":2}'],
    ['trailing object comma', '{"x":1,}'],
    ['trailing array comma', '[1,]'],
    ['invalid number', '{"x":-}'],
    ['negative zero', '{"x":-0}'],
    ['non-finite number', `{"x":${'9'.repeat(400)}}`],
    ['unterminated string', '{"x":"unterminated}'],
    ['raw control', '{"x":"line\nbreak"}'],
    ['NUL escape', '{"x":"\\u0000"}'],
    ['unpaired high surrogate', '{"x":"\\ud800"}'],
    ['unpaired low surrogate', '{"x":"\\udc00"}'],
  ])('rejects strict JSON violation: %s', async (_name, text) => {
    const bytes = encoded(text);
    await expect(
      readBoundedArtifactJson(
        streamed(bytes),
        manifestFor('http-get/v1', 'text/plain', bytes),
        HTTP_CONTRACT,
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('rejects byte type, length, digest, stream, NUL, and invalid contract failures with one code', async () => {
    const bytes = encoded('ok');
    const manifest = manifestFor('http-get/v1', 'text/plain', bytes);
    const cases: readonly (() => Promise<unknown>)[] = [
      () => readBoundedArtifactUtf8(
        (async function* () { yield 'not-bytes' as unknown as Uint8Array; })(),
        manifest,
        HTTP_CONTRACT,
      ),
      () => readBoundedArtifactUtf8(
        (async function* () { yield new Uint8Array(); })(),
        manifest,
        HTTP_CONTRACT,
      ),
      () => readBoundedArtifactUtf8(streamed(encoded('o')), manifest, HTTP_CONTRACT),
      () => readBoundedArtifactUtf8(streamed(encoded('no')), manifest, HTTP_CONTRACT),
      () => readBoundedArtifactUtf8(
        (async function* () {
          yield await Promise.reject<Uint8Array>(new Error('private transport'));
        })(),
        manifest,
        HTTP_CONTRACT,
      ),
      () => {
        const nul = encoded('a\0b');
        return readBoundedArtifactUtf8(
          streamed(nul),
          manifestFor('http-get/v1', 'text/plain', nul),
          HTTP_CONTRACT,
        );
      },
      () => readBoundedArtifactUtf8(streamed(bytes), manifest, {
        ...HTTP_CONTRACT,
        maxBytes: -1,
      }),
    ];
    for (const run of cases) {
      await expect(run()).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
    }
  });

  it('rejects non-record JSON and closed-record key mismatch', async () => {
    for (const value of [null, [], 'text', 1]) {
      expect(() => closedJsonRecord(value, [])).toThrow(
        'GENERIC_OPERATION_ARTIFACT_INVALID',
      );
    }
    const bytes = encoded('{"only":true}');
    const parsed = await readBoundedArtifactJson(
      streamed(bytes),
      manifestFor('http-get/v1', 'text/plain', bytes),
      HTTP_CONTRACT,
    );
    expect(() => closedJsonRecord(parsed, ['required'])).toThrow(
      'GENERIC_OPERATION_ARTIFACT_INVALID',
    );
  });
});
