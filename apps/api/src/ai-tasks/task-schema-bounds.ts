export type OutputSchema = Record<string, unknown>;

export const boundedString = (maxLength: number, extra: OutputSchema = {}): OutputSchema => ({
  type: 'string', maxLength, ...extra,
});
export const boundedNumber = (
  minimum: number,
  maximum: number,
  integer = false,
): OutputSchema => ({ type: integer ? 'integer' : 'number', minimum, maximum });
export const boundedArray = (maxItems: number, items: OutputSchema): OutputSchema => ({
  type: 'array', maxItems, items,
});
export const closedObject = (
  properties: Record<string, OutputSchema>,
  required: readonly string[] = [],
  extra: OutputSchema = {},
): OutputSchema => ({
  type: 'object', additionalProperties: false,
  ...(required.length > 0 ? { required } : {}),
  properties,
  ...extra,
});
