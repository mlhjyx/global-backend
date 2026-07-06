import Ajv, { ErrorObject } from 'ajv';

// 宽松模式：AI Task 的 outputSchema 允许携带说明性字段；只校验结构本身。
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const cache = new Map<string, ReturnType<typeof ajv.compile>>();

export interface SchemaCheck {
  valid: boolean;
  errors?: string[];
}

/** Validate structured model output against the AI Task Contract's JSON Schema (PRD 9.6). */
export function checkAgainstSchema(schema: Record<string, unknown>, data: unknown): SchemaCheck {
  const key = JSON.stringify(schema);
  let validate = cache.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(schema);
    } catch {
      return { valid: true }; // 契约 schema 本身不合法时不阻断调用（记录责任在注册表评审）
    }
    cache.set(key, validate);
  }
  const valid = validate(data) as boolean;
  if (valid) return { valid: true };
  const errors = ((validate.errors ?? []) as ErrorObject[])
    .slice(0, 10)
    .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
  return { valid: false, errors };
}
