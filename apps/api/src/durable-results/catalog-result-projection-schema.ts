export type JsonSchema = Readonly<Record<string, unknown>>;

export function stringSchema(maxLength: number, extra?: JsonSchema): JsonSchema {
  return { type: 'string', maxLength, ...extra };
}

export function numberSchema(minimum: number, maximum: number, integer = false): JsonSchema {
  return { type: integer ? 'integer' : 'number', minimum, maximum };
}

export function arraySchema(maxItems: number, items: JsonSchema): JsonSchema {
  return { type: 'array', maxItems, items };
}

export function objectSchema(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[],
): JsonSchema {
  return { type: 'object', additionalProperties: false, required, properties };
}

const provenanceSchema = objectSchema({
  sourceUrl: stringSchema(2048),
  fetchedAt: stringSchema(100),
  contentHash: stringSchema(128),
  parserVersion: stringSchema(120),
}, ['fetchedAt', 'parserVersion']);

export function toolResultSchema(data: JsonSchema, provenance = false): JsonSchema {
  return objectSchema({
    data,
    costCents: numberSchema(0, 1_000_000_000, true),
    degraded: { type: 'boolean' },
    ...(provenance ? { provenance: provenanceSchema } : {}),
  }, ['data', 'costCents']);
}
