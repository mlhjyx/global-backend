import { createHash } from 'node:crypto';
import {
  parseArtifactExpectedFacts,
  type ArtifactExpectedFacts,
} from './artifact-expected-facts';
import type {
  ArtifactMaterializer,
  GenericOperationArtifactManifest,
} from './artifact.types';
import {
  GenericOperationArtifactError,
  invalidGenericOperationArtifact,
} from './artifact.types';
import { parseGenericOperationArtifactManifest } from './generic-operation-artifact.repository';

export const REQUIRED_ARTIFACT_RESULT_SCHEMAS = Object.freeze([
  'sanctions-download/v1',
  'http-get/v1',
  'crawl4ai-fetch/v1',
  'crawl4ai-render/v1',
] as const);

export type ArtifactResultSchema =
  (typeof REQUIRED_ARTIFACT_RESULT_SCHEMAS)[number];

export const ARTIFACT_RESULT_PRODUCERS = Object.freeze({
  'crawl4ai-fetch/v1': 'crawl4ai.fetch',
  'crawl4ai-render/v1': 'crawl4ai.render',
  'http-get/v1': 'http.get',
  'sanctions-download/v1': 'sanctions.download',
} as const satisfies Record<ArtifactResultSchema, string>);

export function artifactProducerIdForResultSchema(
  resultSchema: ArtifactResultSchema,
): string {
  return ARTIFACT_RESULT_PRODUCERS[resultSchema];
}

const REQUIRED_SCHEMA_SET = new Set<string>(REQUIRED_ARTIFACT_RESULT_SCHEMAS);
const MATERIALIZER_KEYS = new Set(['resultSchema', 'materialize']);
const MAX_STREAM_CHUNKS = 65_536;

export interface ArtifactPayloadContract {
  readonly resultSchema: ArtifactResultSchema;
  readonly mediaTypes: ReadonlySet<string>;
  readonly maxBytes: number;
}

function invalid(): never {
  return invalidGenericOperationArtifact();
}

function isClosedMaterializer(
  value: unknown,
): value is ArtifactMaterializer<unknown> {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== MATERIALIZER_KEYS.size ||
      keys.some((key) => typeof key !== 'string' || !MATERIALIZER_KEYS.has(key))
    ) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(
        descriptor?.enumerable &&
          Object.hasOwn(descriptor, 'value') &&
          (key !== 'materialize' || typeof descriptor.value === 'function'),
      );
    });
  } catch {
    return false;
  }
}

/** Complete fixed registry; expected facts are schema-parsed before dispatch. */
export class ArtifactMaterializerRegistry {
  readonly #materializers: ReadonlyMap<string, ArtifactMaterializer<unknown>>;

  constructor(definitions: readonly ArtifactMaterializer<unknown>[]) {
    const materializers = new Map<string, ArtifactMaterializer<unknown>>();
    for (const definition of definitions) {
      if (
        !isClosedMaterializer(definition) ||
        !REQUIRED_SCHEMA_SET.has(definition.resultSchema) ||
        materializers.has(definition.resultSchema)
      ) {
        invalid();
      }
      materializers.set(
        definition.resultSchema,
        Object.freeze({
          resultSchema: definition.resultSchema,
          materialize: definition.materialize,
        }),
      );
    }
    if (
      materializers.size !== REQUIRED_ARTIFACT_RESULT_SCHEMAS.length ||
      REQUIRED_ARTIFACT_RESULT_SCHEMAS.some(
        (schema) => !materializers.has(schema),
      )
    ) {
      invalid();
    }
    this.#materializers = materializers;
  }

  resultSchemas(): readonly ArtifactResultSchema[] {
    return REQUIRED_ARTIFACT_RESULT_SCHEMAS;
  }

  async materialize<T>(
    resultSchema: ArtifactResultSchema,
    input: AsyncIterable<Uint8Array>,
    manifest: GenericOperationArtifactManifest,
    expectedFacts: unknown,
  ): Promise<T> {
    let parsedManifest: GenericOperationArtifactManifest;
    try {
      parsedManifest = parseGenericOperationArtifactManifest(manifest);
    } catch {
      return invalid();
    }
    if (parsedManifest.resultSchema !== resultSchema) return invalid();
    const materializer = this.#materializers.get(resultSchema);
    if (!materializer) return invalid();
    const parsedFacts: ArtifactExpectedFacts | undefined =
      resultSchema === 'sanctions-download/v1'
        ? expectedFacts === undefined
          ? undefined
          : invalid()
        : parseArtifactExpectedFacts(resultSchema, expectedFacts);
    return (await materializer.materialize(
      input,
      parsedManifest,
      parsedFacts,
    )) as T;
  }
}

/**
 * Consume a Task 3 verified byte stream as the raw schema media body. This
 * edge repeats Task 2 manifest, size, digest and fatal UTF-8 checks without
 * interpreting text/plain, text/markdown or text/html as a JSON envelope.
 */
export async function readBoundedArtifactUtf8(
  input: AsyncIterable<Uint8Array>,
  manifest: GenericOperationArtifactManifest,
  contract: ArtifactPayloadContract,
): Promise<string> {
  try {
    const parsed = parseGenericOperationArtifactManifest(manifest);
    const declaredSize = BigInt(parsed.sizeBytes);
    if (
      parsed.resultSchema !== contract.resultSchema ||
      !contract.mediaTypes.has(parsed.mediaType) ||
      !Number.isSafeInteger(contract.maxBytes) ||
      contract.maxBytes < 0 ||
      declaredSize > BigInt(contract.maxBytes)
    ) {
      return invalid();
    }

    const decoder = new TextDecoder('utf-8', { fatal: true });
    const hash = createHash('sha256');
    const decoded: string[] = [];
    let size = 0n;
    let chunkCount = 0;
    for await (const chunk of input) {
      chunkCount += 1;
      if (
        !(chunk instanceof Uint8Array) ||
        chunk.byteLength === 0 ||
        chunkCount > MAX_STREAM_CHUNKS
      ) {
        return invalid();
      }
      size += BigInt(chunk.byteLength);
      if (size > declaredSize || size > BigInt(contract.maxBytes)) {
        return invalid();
      }
      hash.update(chunk);
      decoded.push(decoder.decode(chunk, { stream: true }));
    }
    decoded.push(decoder.decode());
    if (size !== declaredSize || hash.digest('hex') !== parsed.sha256) {
      return invalid();
    }
    const text = decoded.join('');
    if (text.includes('\0')) return invalid();
    return text;
  } catch (error) {
    if (error instanceof GenericOperationArtifactError) throw error;
    return invalid();
  }
}
