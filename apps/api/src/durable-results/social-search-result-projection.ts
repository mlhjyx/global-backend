import { types } from 'node:util';
import {
  redactSocialSearchText,
  SOCIAL_CONTEXT_MAX_CHARS,
  SOCIAL_MAX_HIGHLIGHTS,
} from '../tools/social-search-retention';
import type { TypedProjectionSchema } from './durable-result-strategy';
import type { TypedProjectionDefinition } from './typed-projection.types';

const RESULT_KEYS = ['data', 'costCents', 'degraded'] as const;
const SOCIAL_PERSON_ITEM_KEYS = ['url', 'title', 'snippet', 'highlights'] as const;

function projectionInvalid(): never {
  throw new Error('CATALOG_RESULT_PROJECTION_INVALID');
}

function ownClosedRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
      projectionInvalid();
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) projectionInvalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
      projectionInvalid();
    }
    for (const key of keys as string[]) {
      const desc = descriptors[key];
      if (!desc?.enumerable || !('value' in desc)) projectionInvalid();
    }
    if (requiredKeys.some((key) => !Object.hasOwn(descriptors, key))) {
      projectionInvalid();
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === 'CATALOG_RESULT_PROJECTION_INVALID') {
      throw error;
    }
    projectionInvalid();
  }
}

function denseArray(value: unknown): unknown[] {
  try {
    if (
      !Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype
    ) {
      projectionInvalid();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) projectionInvalid();
    for (const key of keys as string[]) {
      if (key === 'length') continue;
      const desc = descriptors[key];
      if (!/^(0|[1-9][0-9]*)$/u.test(key) || !desc?.enumerable || !('value' in desc)) {
        projectionInvalid();
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(descriptors, String(index))) projectionInvalid();
    }
    if (keys.length !== value.length + 1) projectionInvalid();
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === 'CATALOG_RESULT_PROJECTION_INVALID') {
      throw error;
    }
    projectionInvalid();
  }
}

function field(record: Record<string, unknown>, name: string): unknown {
  return Object.getOwnPropertyDescriptor(record, name)?.value;
}

function hasDefinedField(record: Record<string, unknown>, name: string): boolean {
  return Object.hasOwn(record, name) && field(record, name) !== undefined;
}

function projectRedactedContext(value: unknown): string {
  if (typeof value !== 'string' || redactSocialSearchText(value) !== value) projectionInvalid();
  return value;
}

function projectSocialPersonHit(raw: unknown): Record<string, unknown> {
  const source = ownClosedRecord(raw, SOCIAL_PERSON_ITEM_KEYS, ['url']);
  const out: Record<string, unknown> = { url: field(source, 'url') };
  if (hasDefinedField(source, 'title')) out.title = field(source, 'title');
  // Keep legacy URL/title readback exact so existing receipts keep their digest.
  if (hasDefinedField(source, 'snippet')) out.snippet = projectRedactedContext(field(source, 'snippet'));
  if (hasDefinedField(source, 'highlights')) {
    out.highlights = denseArray(field(source, 'highlights')).map(projectRedactedContext);
  }
  return out;
}

function projectSocialSearchData(raw: unknown): Record<string, unknown> {
  const source = ownClosedRecord(raw, ['results'], ['results']);
  return {
    results: denseArray(field(source, 'results')).map(projectSocialPersonHit),
  };
}

function projectSocialSearchResult(raw: unknown): Record<string, unknown> {
  const source = ownClosedRecord(raw, RESULT_KEYS, ['data', 'costCents']);
  const costCents = field(source, 'costCents');
  return {
    data: projectSocialSearchData(field(source, 'data')),
    costCents,
    ...(hasDefinedField(source, 'degraded') ? { degraded: field(source, 'degraded') } : {}),
  };
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function buildSocialSearchProjection(
  schema: TypedProjectionSchema,
): TypedProjectionDefinition<unknown, unknown> {
  return deepFreeze({
    schema,
    jsonSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['data', 'costCents'],
      properties: {
        data: {
          type: 'object',
          additionalProperties: false,
          required: ['results'],
          properties: {
            results: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['url'],
                properties: {
                  url: { type: 'string', maxLength: 2048 },
                  title: { type: 'string', maxLength: 2000 },
                  snippet: { type: 'string', maxLength: SOCIAL_CONTEXT_MAX_CHARS },
                  highlights: {
                    type: 'array',
                    maxItems: SOCIAL_MAX_HIGHLIGHTS,
                    items: { type: 'string', maxLength: SOCIAL_CONTEXT_MAX_CHARS },
                  },
                },
              },
            },
          },
        },
        costCents: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
        degraded: { type: 'boolean' },
      },
    },
    project: projectSocialSearchResult,
    restore: projectSocialSearchResult,
  });
}

export const socialSearchSerperProjection = buildSocialSearchProjection('social-search-serper/v1');
export const socialSearchExaPeopleProjection = buildSocialSearchProjection(
  'social-search-exa-people/v1',
);
