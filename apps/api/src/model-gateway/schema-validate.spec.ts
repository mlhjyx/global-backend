import { describe, expect, it } from 'vitest';
import { checkAgainstSchema } from './schema-validate';

describe('schema-validate fail-closed + bounded cache', () => {
  it('validates matching objects and rejects schema violations', () => {
    const schema = {
      type: 'object',
      required: ['ok'],
      additionalProperties: false,
      properties: { ok: { type: 'boolean' } },
    };
    expect(checkAgainstSchema(schema, { ok: true })).toEqual({ valid: true });
    expect(checkAgainstSchema(schema, { ok: 'nope' }).valid).toBe(false);
  });

  it('fails closed when a schema fails AJV compilation or cannot be serialized', () => {
    const badSchema = { type: 'not-a-valid-json-schema-type' };
    const compiled = checkAgainstSchema(badSchema, { ok: true });
    expect(compiled.valid).toBe(false);
    expect(compiled.errors?.length).toBeGreaterThan(0);

    const cyclic: Record<string, unknown> = { type: 'object' };
    cyclic.self = cyclic;
    const serialized = checkAgainstSchema(cyclic, { ok: true });
    expect(serialized.valid).toBe(false);
    expect(serialized.errors?.length).toBeGreaterThan(0);
  });
});
