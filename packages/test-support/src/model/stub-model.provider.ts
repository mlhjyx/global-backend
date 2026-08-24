export type StubModelOperation =
  | 'generateText'
  | 'generateStructured'
  | 'reviewVision'
  | 'embed';

export interface StubModelInput {
  task: string;
}

export interface StubStructuredModelInput extends StubModelInput {
  prompt: string;
  schema: Record<string, unknown>;
}

export interface StubTextModelInput extends StubModelInput {
  prompt: string;
}

export interface StubEmbedModelInput extends StubModelInput {
  input: string[];
}

export interface StubModelResult<Output> {
  data: Output;
  provider: 'stub';
  model: string;
  usage: { costUsd: 0 };
}

export interface StubModelProviderOptions {
  generateStructured?: (
    input: StubStructuredModelInput,
  ) => unknown | Promise<unknown>;
  generateText?: (input: StubTextModelInput) => string | Promise<string>;
  embed?: (input: StubEmbedModelInput) => number[][] | Promise<number[][]>;
}

/**
 * Test-only provider fixture. It never infers business output from a schema:
 * each test must inject the exact artifact it intends to exercise.
 */
export class StubModelProvider {
  readonly id = 'stub';

  constructor(private readonly options: StubModelProviderOptions = {}) {}

  supports(op: StubModelOperation): boolean {
    return op !== 'reviewVision';
  }

  async health(): Promise<{ healthy: true; detail: 'test-stub' }> {
    return { healthy: true, detail: 'test-stub' };
  }

  async generateText(
    input: StubTextModelInput,
    _context?: unknown,
  ): Promise<StubModelResult<string>> {
    if (!this.options.generateText) {
      throw new Error('TEST_STUB_TEXT_RESULT_REQUIRED');
    }
    return {
      data: await this.options.generateText(input),
      provider: 'stub',
      model: 'stub-v0',
      usage: { costUsd: 0 },
    };
  }

  async generateStructured<Output = unknown>(
    input: StubStructuredModelInput,
    _context?: unknown,
  ): Promise<StubModelResult<Output>> {
    if (!this.options.generateStructured) {
      throw new Error('TEST_STUB_STRUCTURED_RESULT_REQUIRED');
    }
    return {
      data: (await this.options.generateStructured(input)) as Output,
      provider: 'stub',
      model: 'stub-v0',
      usage: { costUsd: 0 },
    };
  }

  async reviewVision(): Promise<never> {
    throw new Error('TEST_STUB_VISION_REVIEW_FORBIDDEN');
  }

  async embed(
    input: StubEmbedModelInput,
    _context?: unknown,
  ): Promise<StubModelResult<number[][]>> {
    if (!this.options.embed) {
      throw new Error('TEST_STUB_EMBED_RESULT_REQUIRED');
    }
    return {
      data: await this.options.embed(input),
      provider: 'stub',
      model: 'stub-embed-v0',
      usage: { costUsd: 0 },
    };
  }
}

function schemaFixture(
  schema: Record<string, unknown>,
  depth = 0,
): unknown {
  if (depth > 16) throw new Error('TEST_SCHEMA_FIXTURE_MAX_DEPTH');
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  for (const alternativeKey of ['oneOf', 'anyOf'] as const) {
    const alternatives = schema[alternativeKey];
    if (Array.isArray(alternatives) && alternatives.length > 0) {
      const first = alternatives[0];
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        return schemaFixture(first as Record<string, unknown>, depth + 1);
      }
    }
  }

  const declaredType = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== 'null')
    : schema.type;
  if (declaredType === 'object' || schema.properties) {
    const properties =
      schema.properties && typeof schema.properties === 'object'
        ? (schema.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [];
    return Object.fromEntries(
      required.map((key) => {
        const property = properties[key];
        return [
          key,
          property && typeof property === 'object' && !Array.isArray(property)
            ? schemaFixture(property as Record<string, unknown>, depth + 1)
            : null,
        ];
      }),
    );
  }
  if (declaredType === 'array') {
    const minItems =
      typeof schema.minItems === 'number' && schema.minItems > 0
        ? Math.ceil(schema.minItems)
        : 0;
    const itemSchema =
      schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)
        ? (schema.items as Record<string, unknown>)
        : {};
    return Array.from({ length: minItems }, () =>
      schemaFixture(itemSchema, depth + 1),
    );
  }
  if (declaredType === 'integer' || declaredType === 'number') {
    return typeof schema.minimum === 'number' ? schema.minimum : 0;
  }
  if (declaredType === 'boolean') return false;
  if (declaredType === 'null') return null;
  if (declaredType === 'string') {
    const minLength =
      typeof schema.minLength === 'number' && schema.minLength > 0
        ? Math.ceil(schema.minLength)
        : 1;
    return 'fixture'.padEnd(minLength, 'x');
  }
  throw new Error('TEST_SCHEMA_FIXTURE_UNSUPPORTED_SCHEMA');
}

/**
 * Explicit opt-in for non-production verification entrypoints that need a
 * deterministic schema-shaped response. Runtime product modules never import
 * this package, and the real schema/task validators still decide acceptance.
 */
export function createSchemaFixtureStubModelProvider(): StubModelProvider {
  return new StubModelProvider({
    generateStructured: (input) => schemaFixture(input.schema),
    generateText: (input) => `[test-stub:${input.task}]`,
    embed: (input) => input.input.map(() => Array.from({ length: 8 }, () => 0)),
  });
}
