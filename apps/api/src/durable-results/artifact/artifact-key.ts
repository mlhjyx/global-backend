import {
  invalidGenericOperationArtifact,
  isCanonicalArtifactSha256,
  isCanonicalArtifactUuid,
} from './artifact.types';

const ARTIFACT_KEY_PREFIX = 'generic-operation-results/v1' as const;

/** Returns the only permitted immutable object key for a result digest. */
export function contentAddressedObjectKey(sha256: string): string {
  if (!isCanonicalArtifactSha256(sha256)) invalidGenericOperationArtifact();
  return `${ARTIFACT_KEY_PREFIX}/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

/** Returns the only permitted staging object key for an artifact UUID. */
export function stagingObjectKey(artifactId: string): string {
  if (!isCanonicalArtifactUuid(artifactId)) invalidGenericOperationArtifact();
  return `${ARTIFACT_KEY_PREFIX}/staging/${artifactId}`;
}
