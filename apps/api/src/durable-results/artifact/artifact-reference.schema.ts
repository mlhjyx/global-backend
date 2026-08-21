import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { types as nodeUtilTypes } from 'node:util';
import {
  GENERIC_OPERATION_ARTIFACT_REFERENCE_SCHEMA,
  invalidGenericOperationArtifact,
  isCanonicalArtifactSha256,
  isCanonicalArtifactSizeBytes,
  isCanonicalArtifactUuid,
  type GenericOperationArtifactReference,
} from './artifact.types';

const MAX_RESULT_SCHEMA_LENGTH = 100;
const MAX_MEDIA_TYPE_LENGTH = 160;
const UUID_PATTERN =
  '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const SHA256_PATTERN = '^[0-9a-f]{64}$';
const CANONICAL_SIZE_BYTES_PATTERN = '^(?:0|[1-9][0-9]*)$';
const RESULT_SCHEMA_PATTERN = '^[a-z0-9][a-z0-9._/-]*$';
const MEDIA_TYPE_PATTERN = '^[a-z0-9][a-z0-9!#$&^_.+-]{0,78}/[a-z0-9][a-z0-9!#$&^_.+-]{0,78}$';
const ARTIFACT_REFERENCE_KEYS = [
  'schemaVersion',
  'artifactId',
  'operationId',
  'resultSchema',
  'sha256',
  'sizeBytes',
  'mediaType',
  'expiresAt',
] as const satisfies readonly (keyof GenericOperationArtifactReference)[];
const ARTIFACT_REFERENCE_KEY_SET = new Set<string>(ARTIFACT_REFERENCE_KEYS);

const artifactReferenceValidator = addFormats(
  new Ajv2020({ allErrors: true, strict: true }),
).compile({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'artifactId',
    'operationId',
    'resultSchema',
    'sha256',
    'sizeBytes',
    'mediaType',
    'expiresAt',
  ],
  properties: {
    schemaVersion: { const: GENERIC_OPERATION_ARTIFACT_REFERENCE_SCHEMA },
    artifactId: { type: 'string', pattern: UUID_PATTERN },
    operationId: { type: 'string', pattern: UUID_PATTERN },
    resultSchema: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_RESULT_SCHEMA_LENGTH,
      pattern: RESULT_SCHEMA_PATTERN,
    },
    sha256: { type: 'string', pattern: SHA256_PATTERN },
    sizeBytes: {
      type: 'string',
      maxLength: 19,
      pattern: CANONICAL_SIZE_BYTES_PATTERN,
    },
    mediaType: {
      type: 'string',
      maxLength: MAX_MEDIA_TYPE_LENGTH,
      pattern: MEDIA_TYPE_PATTERN,
    },
    expiresAt: { type: 'string', format: 'date-time' },
  },
});

function snapshotArtifactReference(
  value: unknown,
): GenericOperationArtifactReference | null {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }

    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== ARTIFACT_REFERENCE_KEYS.length ||
      ownKeys.some(
        (key) => typeof key !== 'string' || !ARTIFACT_REFERENCE_KEY_SET.has(key),
      )
    ) {
      return null;
    }

    const snapshot: Record<string, unknown> = {};
    for (const key of ARTIFACT_REFERENCE_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }

    // The exact key loop above populates a fresh data-only snapshot. AJV and
    // semantic validation below establish the string-level contract.
    return snapshot as unknown as GenericOperationArtifactReference;
  } catch {
    return null;
  }
}

function isCanonicalUtcMillisecondsTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

/**
 * Validates a closed, body-free operation projection before a future reader
 * derives its internal object key from the reference digest.
 */
export function parseArtifactReference(
  value: unknown,
): GenericOperationArtifactReference {
  const snapshot = snapshotArtifactReference(value);
  if (!snapshot) return invalidGenericOperationArtifact();

  try {
    if (
      !artifactReferenceValidator(snapshot) ||
      !isCanonicalArtifactUuid(snapshot.artifactId) ||
      !isCanonicalArtifactUuid(snapshot.operationId) ||
      !isCanonicalArtifactSha256(snapshot.sha256) ||
      !isCanonicalArtifactSizeBytes(snapshot.sizeBytes) ||
      !isCanonicalUtcMillisecondsTimestamp(snapshot.expiresAt)
    ) {
      return invalidGenericOperationArtifact();
    }

    return Object.freeze(snapshot);
  } catch {
    return invalidGenericOperationArtifact();
  }
}
