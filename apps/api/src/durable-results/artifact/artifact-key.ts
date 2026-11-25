import {
  invalidGenericOperationArtifact,
  isCanonicalArtifactSha256,
  isCanonicalArtifactUuid,
} from './artifact.types';
import type { ArtifactPrivacyClass } from './artifact.types';

export type ArtifactObjectScope =
  | {
      readonly scopeKind: 'workspace';
      readonly workspaceId: string;
    }
  | {
      readonly scopeKind: 'platform';
      readonly workspaceId: null;
    };

const ARTIFACT_KEY_PREFIX = 'generic-operation-results/v1' as const;
const PRIVACY_PATH: Readonly<Record<ArtifactPrivacyClass, string>> =
  Object.freeze({
    PUBLIC_ORGANIZATION: 'public-organization',
    CONFIDENTIAL_TENANT: 'confidential-tenant',
    PERSONAL_DATA: 'personal-data',
  });

/** Returns the legacy un-prefixed personal-data object key for pre-migration reads/cleanup. */
export function legacyPersonalDataObjectKey(sha256: string): string {
  if (!isCanonicalArtifactSha256(sha256)) {
    invalidGenericOperationArtifact();
  }
  return `${ARTIFACT_KEY_PREFIX}/final/personal-data/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

/** Returns whether `objectKey` matches the canonical (or optionally legacy) key for PERSONAL_DATA. */
export function isCanonicalPersonalDataObjectKey(
  objectKey: unknown,
  sha256: string,
  workspaceId: string | null,
  allowLegacy = false,
): boolean {
  if (typeof objectKey !== 'string' || !isCanonicalArtifactSha256(sha256)) {
    return false;
  }
  if (
    workspaceId !== null &&
    isCanonicalArtifactUuid(workspaceId) &&
    objectKey ===
      contentAddressedObjectKey(sha256, 'PERSONAL_DATA', {
        scopeKind: 'workspace',
        workspaceId,
      })
  ) {
    return true;
  }
  return allowLegacy && objectKey === legacyPersonalDataObjectKey(sha256);
}

/** Returns the only permitted immutable object key for a digest, privacy boundary, and scope. */
export function contentAddressedObjectKey(
  sha256: string,
  privacyClass: ArtifactPrivacyClass,
  scope?: ArtifactObjectScope,
): string {
  const privacyPath = PRIVACY_PATH[privacyClass];
  if (!isCanonicalArtifactSha256(sha256) || !privacyPath) {
    invalidGenericOperationArtifact();
  }
  if (scope !== undefined) {
    if (scope.scopeKind === 'workspace') {
      if (!isCanonicalArtifactUuid(scope.workspaceId)) {
        invalidGenericOperationArtifact();
      }
    } else if (scope.scopeKind === 'platform') {
      if (scope.workspaceId !== null) {
        invalidGenericOperationArtifact();
      }
    } else {
      invalidGenericOperationArtifact();
    }
  }
  if (privacyClass === 'PERSONAL_DATA') {
    if (
      !scope ||
      scope.scopeKind !== 'workspace' ||
      !isCanonicalArtifactUuid(scope.workspaceId)
    ) {
      invalidGenericOperationArtifact();
    }
    return `${ARTIFACT_KEY_PREFIX}/final/${privacyPath}/ws/${scope.workspaceId}/sha256/${sha256.slice(0, 2)}/${sha256}`;
  }
  return `${ARTIFACT_KEY_PREFIX}/final/${privacyPath}/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

/** Returns the only permitted staging object key for an artifact UUID. */
export function stagingObjectKey(artifactId: string): string {
  if (!isCanonicalArtifactUuid(artifactId)) invalidGenericOperationArtifact();
  return `${ARTIFACT_KEY_PREFIX}/staging/${artifactId}`;
}

export function parseArtifactObjectScope(
  scope: ArtifactObjectScope | undefined,
): ArtifactObjectScope | undefined {
  if (scope === undefined) return undefined;
  if (typeof scope !== 'object' || scope === null) {
    invalidGenericOperationArtifact();
  }
  if (scope.scopeKind === 'workspace' && isCanonicalArtifactUuid(scope.workspaceId)) {
    return { scopeKind: 'workspace', workspaceId: scope.workspaceId };
  }
  if (scope.scopeKind === 'platform' && scope.workspaceId === null) {
    return { scopeKind: 'platform', workspaceId: null };
  }
  invalidGenericOperationArtifact();
}

export function resolveArtifactObjectKey(
  sha256: string,
  privacyClass: ArtifactPrivacyClass,
  options?: Readonly<{ scope?: ArtifactObjectScope; objectKey?: string }>,
): string {
  const scope = parseArtifactObjectScope(options?.scope);
  if (options?.objectKey === undefined) {
    return contentAddressedObjectKey(sha256, privacyClass, scope);
  }
  if (privacyClass === 'PERSONAL_DATA') {
    const workspaceId = scope?.scopeKind === 'workspace' ? scope.workspaceId : null;
    if (!isCanonicalPersonalDataObjectKey(options.objectKey, sha256, workspaceId, true)) {
      invalidGenericOperationArtifact();
    }
    return options.objectKey;
  }
  const expected = contentAddressedObjectKey(sha256, privacyClass, scope);
  if (options.objectKey !== expected) invalidGenericOperationArtifact();
  return expected;
}
