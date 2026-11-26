import { types } from 'node:util';
import { isValidEuVat } from '../discovery/website-profile/eu-vat';
import type { TypedProjectionDefinition } from './typed-projection.types';

const RESULT_KEYS = ['data', 'costCents', 'degraded'] as const;
const VIES_DATA_KEYS = [
  'status',
  'countryCode',
  'isoCountry',
  'vatNumber',
  'vatId',
  'requestDate',
  'legalName',
  'registeredCity',
  'nameRedacted',
] as const;
const VIES_REQUIRED_KEYS = [
  'status',
  'countryCode',
  'isoCountry',
  'vatNumber',
  'vatId',
  'nameRedacted',
] as const;

function projectionInvalid(): never {
  throw new Error('CATALOG_RESULT_PROJECTION_INVALID');
}

function ownClosedRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): Record<string, unknown> {
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
}

function projectViesData(value: unknown): Record<string, unknown> {
  const data = ownClosedRecord(value, VIES_DATA_KEYS, VIES_REQUIRED_KEYS);
  const vatId = Object.getOwnPropertyDescriptor(data, 'vatId')?.value;
  if (typeof vatId !== 'string' || !isValidEuVat(vatId)) {
    projectionInvalid();
  }
  const out: Record<string, unknown> = {};
  for (const key of VIES_DATA_KEYS) {
    const desc = Object.getOwnPropertyDescriptor(data, key);
    if (desc && desc.value !== undefined) {
      out[key] = desc.value;
    }
  }
  return out;
}

function projectViesToolResult(raw: unknown): Record<string, unknown> {
  const source = ownClosedRecord(raw, RESULT_KEYS, ['data', 'costCents']);
  const costCents = Object.getOwnPropertyDescriptor(source, 'costCents')?.value;
  const degradedDesc = Object.getOwnPropertyDescriptor(source, 'degraded');
  return {
    data: projectViesData(Object.getOwnPropertyDescriptor(source, 'data')?.value),
    costCents,
    ...(degradedDesc && degradedDesc.value !== undefined ? { degraded: degradedDesc.value } : {}),
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

/** Closed, address-free typed projection for `vies.check` (`vies-check/v1`). */
export const viesCheckResultProjection: TypedProjectionDefinition<unknown, unknown> = deepFreeze({
  schema: 'vies-check/v1',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['data', 'costCents'],
    properties: {
      data: {
        type: 'object',
        additionalProperties: false,
        required: [...VIES_REQUIRED_KEYS],
        properties: {
          status: { type: 'string', maxLength: 16, enum: ['VALID', 'INVALID'] },
          countryCode: { type: 'string', maxLength: 2 },
          isoCountry: { type: 'string', maxLength: 2 },
          vatNumber: { type: 'string', maxLength: 14 },
          vatId: { type: 'string', maxLength: 16 },
          requestDate: { type: 'string', maxLength: 32 },
          legalName: { type: 'string', maxLength: 300 },
          registeredCity: { type: 'string', maxLength: 120 },
          nameRedacted: { type: 'boolean' },
        },
      },
      costCents: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
      degraded: { type: 'boolean' },
    },
  },
  project: projectViesToolResult,
  restore: projectViesToolResult,
});
