export const GENERIC_OPERATION_ARTIFACT_REFERENCE_SCHEMA =
  'generic-operation-artifact-ref/v1' as const;
export const GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA =
  'generic-operation-artifact/v1' as const;

export type ArtifactPrivacyClass =
  | 'PUBLIC_ORGANIZATION'
  | 'CONFIDENTIAL_TENANT'
  | 'PERSONAL_DATA';

export type ArtifactScopeKind = 'workspace' | 'platform';

export interface ArtifactSource {
  readonly body: AsyncIterable<Uint8Array>;
  readonly mediaType: string;
  readonly sourceDigest?: string;
}

export interface GenericOperationArtifactManifest {
  readonly schemaVersion: typeof GENERIC_OPERATION_ARTIFACT_MANIFEST_SCHEMA;
  readonly artifactId: string;
  readonly scopeKind: ArtifactScopeKind;
  readonly workspaceId: string | null;
  readonly authorityId: string;
  readonly operationId: string;
  readonly resultSchema: string;
  /** Internal metadata only; never included in the small operation projection. */
  readonly objectKey: string;
  readonly sha256: string;
  readonly sizeBytes: string;
  readonly mediaType: string;
  readonly privacyClass: ArtifactPrivacyClass;
  readonly sourceDigest: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * The complete durable-operation result projection for a large artifact.
 * It deliberately carries no body, object key, credentials, headers, prompts,
 * tokens, or personal data.
 */
export interface GenericOperationArtifactReference {
  readonly schemaVersion: typeof GENERIC_OPERATION_ARTIFACT_REFERENCE_SCHEMA;
  readonly artifactId: string;
  readonly operationId: string;
  readonly resultSchema: string;
  readonly sha256: string;
  readonly sizeBytes: string;
  readonly mediaType: string;
  readonly expiresAt: string;
}

export interface ArtifactMaterializer<T> {
  readonly resultSchema: string;
  materialize(
    input: AsyncIterable<Uint8Array>,
    manifest: GenericOperationArtifactManifest,
    /** Closed facts loaded with the manifest; never caller/provider metadata. */
    expectedFacts: unknown,
  ): Promise<T>;
}

export type GenericOperationArtifactErrorCode =
  'GENERIC_OPERATION_ARTIFACT_INVALID';

export class GenericOperationArtifactError extends Error {
  constructor(public readonly code: GenericOperationArtifactErrorCode) {
    super(code);
    this.name = 'GenericOperationArtifactError';
  }
}

const ARTIFACT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANONICAL_SIZE_BYTES_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const MAX_SIGNED_64_BIT = 9_223_372_036_854_775_807n;

export function isCanonicalArtifactUuid(value: unknown): value is string {
  return typeof value === 'string' && ARTIFACT_UUID_PATTERN.test(value);
}

export function isCanonicalArtifactSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

export function isCanonicalArtifactSizeBytes(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !CANONICAL_SIZE_BYTES_PATTERN.test(value) ||
    value.length > 19
  ) {
    return false;
  }

  return BigInt(value) <= MAX_SIGNED_64_BIT;
}

export function invalidGenericOperationArtifact(): never {
  throw new GenericOperationArtifactError('GENERIC_OPERATION_ARTIFACT_INVALID');
}
