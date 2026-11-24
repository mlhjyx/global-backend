import Ajv, { ErrorObject } from 'ajv';

// 宽松模式：AI Task 的 outputSchema 允许携带说明性字段；只校验结构本身。
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const MAX_SCHEMA_CACHE_ENTRIES = 256;
const cache = new Map<string, ReturnType<typeof ajv.compile>>();

function cacheSet(key: string, fn: ReturnType<typeof ajv.compile>): void {
  if (cache.size >= MAX_SCHEMA_CACHE_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, fn);
}

export interface SchemaCheck {
  valid: boolean;
  errors?: string[];
}

/**
 * Vision/MODEL-1 gates fail closed before a paid call.
 */
export function assertModelOutputSchemaCompiles(
  schema: Record<string, unknown>,
): void {
  let key: string;
  try {
    key = JSON.stringify(schema);
  } catch (error) {
    throw new Error('MODEL_OUTPUT_SCHEMA_INVALID', { cause: error });
  }
  if (cache.has(key)) return;
  try {
    cacheSet(key, ajv.compile(schema));
  } catch (error) {
    throw new Error('MODEL_OUTPUT_SCHEMA_INVALID', { cause: error });
  }
}

/** Validate structured model output against the AI Task Contract's JSON Schema (PRD 9.6). Fail-closed on invalid schema. */
export function checkAgainstSchema(schema: Record<string, unknown>, data: unknown): SchemaCheck {
  let key: string;
  try {
    key = JSON.stringify(schema);
  } catch (error) {
    return {
      valid: false,
      errors: [`schema serialization failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  let validate = cache.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
    } catch (error) {
      return {
        valid: false,
        errors: [`schema compilation failed: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
    cacheSet(key, validate);
  }
  const valid = validate(data) as boolean;
  if (valid) return { valid: true };
  const errors = ((validate.errors ?? []) as ErrorObject[])
    .slice(0, 10)
    .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
  return { valid: false, errors };
}
