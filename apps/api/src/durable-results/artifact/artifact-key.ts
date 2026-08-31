import {
  invalidGenericOperationArtifact,
  isCanonicalArtifactSha256,
  isCanonicalArtifactUuid,
} from './artifact.types';
import type { ArtifactPrivacyClass } from './artifact.types';

const ARTIFACT_KEY_PREFIX = 'generic-operation-results/v1' as const;
const PRIVACY_PATH: Readonly<Record<ArtifactPrivacyClass, string>> =
  Object.freeze({
    PUBLIC_ORGANIZATION: 'public-organization',
    CONFIDENTIAL_TENANT: 'confidential-tenant',
    PERSONAL_DATA: 'personal-data',
  });

/** Returns the only permitted immutable object key for a digest and privacy boundary. */
export function contentAddressedObjectKey(
  sha256: string,
  privacyClass: ArtifactPrivacyClass,
): string {
  const privacyPath = PRIVACY_PATH[privacyClass];
  if (!isCanonicalArtifactSha256(sha256) || !privacyPath) {
    invalidGenericOperationArtifact();
  }
  return `${ARTIFACT_KEY_PREFIX}/final/${privacyPath}/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

/** Returns the only permitted staging object key for an artifact UUID. */
export function stagingObjectKey(artifactId: string): string {
  if (!isCanonicalArtifactUuid(artifactId)) invalidGenericOperationArtifact();
  return `${ARTIFACT_KEY_PREFIX}/staging/${artifactId}`;
}
