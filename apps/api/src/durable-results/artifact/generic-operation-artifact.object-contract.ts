import { contentAddressedObjectKey } from './artifact-key';
import type { ArtifactPrivacyClass } from './artifact.types';

export const GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA =
  'generic-operation-artifact-object/v1' as const;

const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,78}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,78}$/;
const RESULT_SCHEMA_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;
const PRIVACY_CLASSES = new Set<ArtifactPrivacyClass>([
  'PUBLIC_ORGANIZATION',
  'CONFIDENTIAL_TENANT',
  'PERSONAL_DATA',
]);
const METADATA_KEYS = new Set([
  'privacy-class',
  'result-schema',
  'schema',
  'sha256',
  'size-bytes',
]);

export interface ArtifactDescriptor {
  readonly sha256: string;
  readonly sizeBytes: string;
  readonly mediaType: string;
  readonly resultSchema: string;
  readonly privacyClass: ArtifactPrivacyClass;
}

export interface StoredArtifactContract extends ArtifactDescriptor {
  readonly objectKey: string;
  /** Internal immutable S3 identity. Never enters public manifests/references. */
  readonly versionId: string;
}

const VERSION_ID_PATTERN = /^[A-Za-z0-9._~+/=-]{1,1024}$/;

export function isCanonicalArtifactObjectVersionId(
  value: unknown,
): value is string {
  return typeof value === 'string' && VERSION_ID_PATTERN.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asMetadata(value: unknown): Readonly<Record<string, string>> | null {
  const record = asRecord(value);
  if (!record || Object.keys(record).length !== METADATA_KEYS.size) return null;
  for (const [key, item] of Object.entries(record)) {
    if (!METADATA_KEYS.has(key) || typeof item !== 'string') return null;
  }
  return record as Readonly<Record<string, string>>;
}

export function parseStoredArtifactContract(
  sha256: string,
  headOutput: unknown,
  taggingOutput: unknown,
): StoredArtifactContract | null {
  const head = asRecord(headOutput);
  const metadata = asMetadata(head?.Metadata);
  const contentLength = head?.ContentLength;
  const contentType = head?.ContentType;
  const versionId = head?.VersionId;
  const resultSchema = metadata?.['result-schema'];
  const privacyClass = metadata?.['privacy-class'];
  const tags = asRecord(taggingOutput)?.TagSet;
  if (
    !head ||
    !metadata ||
    typeof contentLength !== 'number' ||
    !Number.isSafeInteger(contentLength) ||
    contentLength < 0 ||
    typeof contentType !== 'string' ||
    contentType.length > 160 ||
    !MEDIA_TYPE_PATTERN.test(contentType) ||
    typeof resultSchema !== 'string' ||
    resultSchema.length > 100 ||
    !RESULT_SCHEMA_PATTERN.test(resultSchema) ||
    !PRIVACY_CLASSES.has(privacyClass as ArtifactPrivacyClass) ||
    !isCanonicalArtifactObjectVersionId(versionId) ||
    metadata.schema !== GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA ||
    metadata.sha256 !== sha256 ||
    metadata['size-bytes'] !== String(contentLength) ||
    head.ServerSideEncryption !== 'AES256' ||
    !Array.isArray(tags) ||
    tags.length !== 1
  ) {
    return null;
  }
  const tag = asRecord(tags[0]);
  if (tag?.Key !== 'artifact-privacy' || tag.Value !== privacyClass) {
    return null;
  }
  return Object.freeze({
    objectKey: contentAddressedObjectKey(
      sha256,
      privacyClass as ArtifactPrivacyClass,
    ),
    versionId,
    sha256,
    sizeBytes: metadata['size-bytes'],
    mediaType: contentType,
    resultSchema,
    privacyClass: privacyClass as ArtifactPrivacyClass,
  });
}

const EXPIRATION_HEADER_PATTERN = /expiry-date="([^"]{1,64})"/u;

/**
 * The lifecycle expiry S3 and MinIO announce on HEAD/GET as
 * `x-amz-expiration: expiry-date="<RFC 1123>", rule-id="..."` when an
 * expiration rule matches the object. MinIO derives it from the object's
 * LastModified (midnight UTC after LastModified + Days + 1 day), so it is the
 * one authoritative statement of when the bucket lifecycle will delete the
 * current version. Null when no rule applies or the header is unreadable.
 */
export function parseLifecycleExpiration(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length > 512) return null;
  const match = EXPIRATION_HEADER_PATTERN.exec(value);
  if (!match?.[1]) return null;
  const date = new Date(match[1]);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function objectMetadata(
  artifact: ArtifactDescriptor,
): Readonly<Record<string, string>> {
  return Object.freeze({
    sha256: artifact.sha256,
    'size-bytes': artifact.sizeBytes,
    schema: GENERIC_OPERATION_ARTIFACT_OBJECT_SCHEMA,
    'result-schema': artifact.resultSchema,
    'privacy-class': artifact.privacyClass,
  });
}

/**
 * Whether a stored object is the artifact a caller expects. A final object is
 * addressed by its bytes inside one privacy boundary, so two operations whose
 * results are byte-identical share it even when their result schemas or media
 * types differ: an empty HEAD probe (http-get/v1, text/plain) and an empty
 * crawl (crawl4ai-fetch/v1, text/markdown) are the same empty object. The
 * object's own metadata records the first writer's contract; each artifact
 * manifest carries its own, and materializers read the manifest.
 */
export function sameArtifact(
  stored: ArtifactDescriptor,
  expected: ArtifactDescriptor,
): boolean {
  return (
    stored.sha256 === expected.sha256 &&
    stored.sizeBytes === expected.sizeBytes &&
    stored.privacyClass === expected.privacyClass
  );
}

/**
 * Whether two descriptors carry the identical object contract: bytes, privacy
 * boundary, media type and result schema. Reuse compares only the bytes
 * (sameArtifact); a write to an existing object, such as the retention refresh
 * copy, must leave the first writer's whole contract exactly as it found it.
 */
export function sameObjectContract(
  stored: ArtifactDescriptor,
  expected: ArtifactDescriptor,
): boolean {
  return (
    sameArtifact(stored, expected) &&
    stored.mediaType === expected.mediaType &&
    stored.resultSchema === expected.resultSchema
  );
}
