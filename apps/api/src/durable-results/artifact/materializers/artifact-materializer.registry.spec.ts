import { describe, expect, it } from 'vitest';
import {
  ArtifactMaterializerRegistry,
  REQUIRED_ARTIFACT_RESULT_SCHEMAS,
  readBoundedArtifactUtf8,
  type ArtifactPayloadContract,
} from '../artifact-materializer.registry';
import type { ArtifactMaterializer } from '../artifact.types';
import { crawl4aiMaterializers } from './crawl4ai.materializer';
import { httpGetMaterializer } from './http-get.materializer';
import { sanctionsDownloadMaterializer } from './sanctions-download.materializer';
import {
  encoded,
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
  it('registers exactly four schemas and dispatches raw body with trusted expected facts', async () => {
    const registry = new ArtifactMaterializerRegistry(definitions);
    expect(registry.resultSchemas()).toEqual(REQUIRED_ARTIFACT_RESULT_SCHEMAS);

    const bytes = encoded('bounded raw body');
    await expect(
      registry.materialize(
        'http-get/v1',
        streamed(bytes),
        manifestFor('http-get/v1', 'text/plain', bytes),
        {
          status: 200,
          ok: true,
          sanitizedUrl: 'https://example.com/',
          blocked: null,
        },
      ),
    ).resolves.toEqual({
      status: 200,
      ok: true,
      mediaType: 'text/plain',
      text: 'bounded raw body',
      finalUrl: 'https://example.com/',
    });
  });

  it('rejects missing expected facts instead of inventing HTTP result metadata', async () => {
    const registry = new ArtifactMaterializerRegistry(definitions);
    const bytes = encoded('raw body');
    await expect(
      registry.materialize(
        'http-get/v1',
        streamed(bytes),
        manifestFor('http-get/v1', 'text/plain', bytes),
        undefined,
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('rejects duplicate, missing, unapproved, and non-closed schema definitions', () => {
    expect(
      () => new ArtifactMaterializerRegistry([...definitions, httpGetMaterializer]),
    ).toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
    expect(
      () => new ArtifactMaterializerRegistry(definitions.slice(1)),
    ).toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
    const invalidDefinitions: unknown[] = [
      null,
      [],
      Object.create(null),
      { resultSchema: 'crawl4ai-render/v1', materialize: async () => ({}), extra: true },
      Object.freeze({
        resultSchema: 'caller-selected/v1',
        materialize: async () => ({}),
      }),
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

  it('snapshots trusted definitions and rejects manifest/schema mismatch', async () => {
    const mutable: ArtifactMaterializer<unknown>[] = definitions.map(
      (definition) => ({ ...definition }),
    );
    const registry = new ArtifactMaterializerRegistry(mutable);
    mutable[1]!.materialize = async () => ({ compromised: true });
    const bytes = encoded('<sdnList/>');
    await expect(
      registry.materialize(
        'http-get/v1',
        streamed(bytes),
        manifestFor('sanctions-download/v1', 'application/xml', bytes),
        {
          status: 200,
          ok: true,
          sanitizedUrl: 'https://example.com/',
          blocked: null,
        },
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('keeps byte type, length, digest, stream and NUL checks on the raw body', async () => {
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
    ];
    for (const run of cases) {
      await expect(run()).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
    }
  });
});
