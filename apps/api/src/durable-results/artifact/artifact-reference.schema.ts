import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRfc3339Time(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp);
}

/**
 * Validates a closed, body-free operation projection before a future reader
 * derives its internal object key from the reference digest.
 */
export function parseArtifactReference(
  value: unknown,
): GenericOperationArtifactReference {
  if (!isPlainRecord(value) || !artifactReferenceValidator(value)) {
    return invalidGenericOperationArtifact();
  }

  const candidate = value as GenericOperationArtifactReference;
  if (
    !isCanonicalArtifactUuid(candidate.artifactId) ||
    !isCanonicalArtifactUuid(candidate.operationId) ||
    !isCanonicalArtifactSha256(candidate.sha256) ||
    !isCanonicalArtifactSizeBytes(candidate.sizeBytes) ||
    !isRfc3339Time(candidate.expiresAt)
  ) {
    return invalidGenericOperationArtifact();
  }

  return Object.freeze({
    schemaVersion: GENERIC_OPERATION_ARTIFACT_REFERENCE_SCHEMA,
    artifactId: candidate.artifactId,
    operationId: candidate.operationId,
    resultSchema: candidate.resultSchema,
    sha256: candidate.sha256,
    sizeBytes: candidate.sizeBytes,
    mediaType: candidate.mediaType,
    expiresAt: candidate.expiresAt,
  });
}
