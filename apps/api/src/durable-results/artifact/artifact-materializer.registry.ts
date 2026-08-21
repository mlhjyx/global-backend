import { createHash } from 'node:crypto';
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

const REQUIRED_SCHEMA_SET = new Set<string>(REQUIRED_ARTIFACT_RESULT_SCHEMAS);
const MATERIALIZER_KEYS = new Set(['resultSchema', 'materialize']);
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ARRAY_ITEMS = 4_096;
const MAX_JSON_OBJECT_PROPERTIES = 64;
const MAX_JSON_KEY_LENGTH = 128;
const MAX_STREAM_CHUNKS = 65_536;
const RESERVED_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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

/**
 * Immutable, complete schema registry. Construction is the startup gate: a
 * runtime cannot start with a missing, duplicate, or caller-invented schema.
 */
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
    return (await materializer.materialize(input, parsedManifest)) as T;
  }
}

/**
 * Decode a Task 3 verified byte stream defensively again at the schema edge.
 * This preserves streaming input, enforces the Task 2 manifest binding and
 * never exposes decoder/hash/transport diagnostics to callers.
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

class StrictJsonParser {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.offset !== this.source.length) return invalid();
    return value;
  }

  private parseValue(depth: number): unknown {
    if (depth > MAX_JSON_DEPTH) return invalid();
    this.skipWhitespace();
    const current = this.source[this.offset];
    if (current === '{') return this.parseObject(depth + 1);
    if (current === '[') return this.parseArray(depth + 1);
    if (current === '"') return this.parseString();
    if (this.source.startsWith('true', this.offset)) {
      this.offset += 4;
      return true;
    }
    if (this.source.startsWith('false', this.offset)) {
      this.offset += 5;
      return false;
    }
    if (this.source.startsWith('null', this.offset)) {
      this.offset += 4;
      return null;
    }
    return this.parseNumber();
  }

  private parseObject(depth: number): Readonly<Record<string, unknown>> {
    this.offset += 1;
    this.skipWhitespace();
    const result = Object.create(null) as Record<string, unknown>;
    let properties = 0;
    if (this.source[this.offset] === '}') {
      this.offset += 1;
      return Object.freeze(result);
    }
    for (;;) {
      if (this.source[this.offset] !== '"') return invalid();
      const key = this.parseString();
      if (
        key.length > MAX_JSON_KEY_LENGTH ||
        RESERVED_JSON_KEYS.has(key) ||
        Object.hasOwn(result, key)
      ) {
        return invalid();
      }
      this.skipWhitespace();
      if (this.source[this.offset] !== ':') return invalid();
      this.offset += 1;
      const value = this.parseValue(depth);
      Object.defineProperty(result, key, {
        configurable: false,
        enumerable: true,
        value,
        writable: false,
      });
      properties += 1;
      if (properties > MAX_JSON_OBJECT_PROPERTIES) return invalid();
      this.skipWhitespace();
      const delimiter = this.source[this.offset];
      if (delimiter === '}') {
        this.offset += 1;
        return Object.freeze(result);
      }
      if (delimiter !== ',') return invalid();
      this.offset += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): readonly unknown[] {
    this.offset += 1;
    this.skipWhitespace();
    const result: unknown[] = [];
    if (this.source[this.offset] === ']') {
      this.offset += 1;
      return Object.freeze(result);
    }
    for (;;) {
      result.push(this.parseValue(depth));
      if (result.length > MAX_JSON_ARRAY_ITEMS) return invalid();
      this.skipWhitespace();
      const delimiter = this.source[this.offset];
      if (delimiter === ']') {
        this.offset += 1;
        return Object.freeze(result);
      }
      if (delimiter !== ',') return invalid();
      this.offset += 1;
    }
  }

  private parseString(): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    for (; this.offset < this.source.length; this.offset += 1) {
      const character = this.source[this.offset]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') {
        this.offset += 1;
        const value = JSON.parse(this.source.slice(start, this.offset)) as unknown;
        if (typeof value !== 'string') return invalid();
        assertJsonUnicode(value);
        return value;
      }
      if (character.charCodeAt(0) < 0x20) return invalid();
    }
    return invalid();
  }

  private parseNumber(): number {
    const match = this.source
      .slice(this.offset)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match) return invalid();
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value) || Object.is(value, -0)) return invalid();
    return value;
  }

  private skipWhitespace(): void {
    while (this.offset < this.source.length) {
      const code = this.source.charCodeAt(this.offset);
      if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) {
        return;
      }
      this.offset += 1;
    }
  }
}

function assertJsonUnicode(value: string): void {
  if (value.includes('\0')) return invalid();
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return invalid();
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return invalid();
    }
  }
}

export async function readBoundedArtifactJson(
  input: AsyncIterable<Uint8Array>,
  manifest: GenericOperationArtifactManifest,
  contract: ArtifactPayloadContract,
): Promise<unknown> {
  const text = await readBoundedArtifactUtf8(input, manifest, contract);
  try {
    return new StrictJsonParser(text).parse();
  } catch (error) {
    if (error instanceof GenericOperationArtifactError) throw error;
    return invalid();
  }
}

export function closedJsonRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== null
  ) {
    return invalid();
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  if (
    requiredKeys.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key)) ||
    keys.length < requiredKeys.length ||
    keys.length > allowed.size
  ) {
    return invalid();
  }
  return value as Readonly<Record<string, unknown>>;
}
