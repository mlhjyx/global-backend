import { types as utilTypes } from 'node:util';
import { stagingObjectKey } from './artifact-key';
import {
  isCanonicalArtifactSha256,
  isCanonicalArtifactUuid,
  type ArtifactPrivacyClass,
} from './artifact.types';

const RESULT_SCHEMA_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,78}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,78}$/;
const PRIVACY_CLASSES = new Set<ArtifactPrivacyClass>([
  'PUBLIC_ORGANIZATION',
  'CONFIDENTIAL_TENANT',
  'PERSONAL_DATA',
]);
const STAGED_ARTIFACT_KEYS = [
  'artifactId',
  'stagingKey',
  'sha256',
  'sizeBytes',
  'mediaType',
  'sourceDigest',
  'resultSchema',
  'privacyClass',
] as const;

export interface StagedArtifactSnapshot {
  readonly artifactId: string;
  readonly stagingKey: string;
  readonly sha256: string;
  readonly sizeBytes: string;
  readonly mediaType: string;
  readonly sourceDigest: string | null;
  readonly resultSchema: string;
  readonly privacyClass: ArtifactPrivacyClass;
}

export function assertArtifactResultSchema(
  value: unknown,
  failInvalid: () => never,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 100 ||
    !RESULT_SCHEMA_PATTERN.test(value)
  ) {
    failInvalid();
  }
}

export function assertArtifactPrivacyClass(
  value: unknown,
  failInvalid: () => never,
): asserts value is ArtifactPrivacyClass {
  if (!PRIVACY_CLASSES.has(value as ArtifactPrivacyClass)) {
    failInvalid();
  }
}

export function assertArtifactMediaType(
  value: unknown,
  failInvalid: () => never,
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > 160 ||
    !MEDIA_TYPE_PATTERN.test(value)
  ) {
    failInvalid();
  }
}

export function parseStagedArtifactSnapshot(
  value: StagedArtifactSnapshot,
  failInvalid: () => never,
): StagedArtifactSnapshot {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      utilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      failInvalid();
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== STAGED_ARTIFACT_KEYS.length ||
      ownKeys.some(
        (key) =>
          typeof key !== 'string' ||
          !STAGED_ARTIFACT_KEYS.includes(
            key as (typeof STAGED_ARTIFACT_KEYS)[number],
          ),
      )
    ) {
      failInvalid();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of STAGED_ARTIFACT_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        failInvalid();
      }
    }
    const artifactId = descriptors.artifactId.value as unknown;
    const suppliedStagingKey = descriptors.stagingKey.value as unknown;
    const sha256 = descriptors.sha256.value as unknown;
    const sizeBytes = descriptors.sizeBytes.value as unknown;
    const mediaType = descriptors.mediaType.value as unknown;
    const sourceDigest = descriptors.sourceDigest.value as unknown;
    const resultSchema = descriptors.resultSchema.value as unknown;
    const privacyClass = descriptors.privacyClass.value as unknown;
    if (
      !isCanonicalArtifactUuid(artifactId) ||
      suppliedStagingKey !== stagingObjectKey(artifactId) ||
      !isCanonicalArtifactSha256(sha256) ||
      typeof sizeBytes !== 'string' ||
      !/^(?:0|[1-9][0-9]*)$/.test(sizeBytes) ||
      !Number.isSafeInteger(Number(sizeBytes)) ||
      (sourceDigest !== null && !isCanonicalArtifactSha256(sourceDigest))
    ) {
      failInvalid();
    }
    assertArtifactMediaType(mediaType, failInvalid);
    assertArtifactResultSchema(resultSchema, failInvalid);
    assertArtifactPrivacyClass(privacyClass, failInvalid);

    return Object.freeze({
      artifactId,
      stagingKey: stagingObjectKey(artifactId),
      sha256,
      sizeBytes,
      mediaType,
      sourceDigest,
      resultSchema,
      privacyClass,
    });
  } catch {
    failInvalid();
  }
}
