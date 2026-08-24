import { DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { types } from 'node:util';
import { contentAddressedObjectKey } from './artifact-key';
import { isCanonicalArtifactObjectVersionId } from './generic-operation-artifact.object-contract';
import { isCanonicalArtifactSha256 } from './artifact.types';
import {
  PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE,
  type PrivilegedPersonalArtifactCleanupPort,
} from './personal-artifact-cleanup.contract';

export interface PersonalArtifactCleanupS3Client {
  send(command: object): Promise<unknown>;
}

export interface S3PersonalArtifactCleanupAdapterOptions {
  readonly bucket: string;
  readonly client: PersonalArtifactCleanupS3Client;
}

const INPUT_KEYS = Object.freeze(['sha256', 'versionId']);

function unavailable(): Error {
  return new Error(PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE);
}

function isNotFound(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const metadata =
    record.$metadata !== null && typeof record.$metadata === 'object'
      ? (record.$metadata as Record<string, unknown>)
      : null;
  return (
    metadata?.httpStatusCode === 404 ||
    record.name === 'NotFound' ||
    record.name === 'NoSuchKey' ||
    record.name === 'NoSuchVersion' ||
    record.name === '404'
  );
}

function parseInput(value: unknown): Readonly<{
  sha256: string;
  versionId: string;
}> {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      throw unavailable();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== INPUT_KEYS.length ||
      ownKeys.some((key) => typeof key !== 'string' || !INPUT_KEYS.includes(key)) ||
      INPUT_KEYS.some((key) => {
        const descriptor = descriptors[key];
        return !descriptor?.enumerable || !('value' in descriptor);
      })
    ) {
      throw unavailable();
    }
    const sha256 = descriptors.sha256.value as unknown;
    const versionId = descriptors.versionId.value as unknown;
    if (
      !isCanonicalArtifactSha256(sha256) ||
      !isCanonicalArtifactObjectVersionId(versionId)
    ) {
      throw unavailable();
    }
    return Object.freeze({ sha256, versionId });
  } catch {
    throw unavailable();
  }
}

export class S3PersonalArtifactCleanupAdapter
  implements PrivilegedPersonalArtifactCleanupPort
{
  private readonly bucket: string;
  private readonly client: PersonalArtifactCleanupS3Client;

  constructor(options: S3PersonalArtifactCleanupAdapterOptions) {
    if (
      options === null ||
      typeof options !== 'object' ||
      typeof options.bucket !== 'string' ||
      options.bucket.length < 3 ||
      options.bucket.length > 63 ||
      typeof options.client?.send !== 'function'
    ) {
      throw unavailable();
    }
    this.bucket = options.bucket;
    this.client = options.client;
  }

  async deleteFinalVersion(input: Readonly<{
    sha256: string;
    versionId: string;
  }>): Promise<'DELETED' | 'ABSENT'> {
    const exact = parseInput(input);
    const target = Object.freeze({
      Bucket: this.bucket,
      Key: contentAddressedObjectKey(exact.sha256),
      VersionId: exact.versionId,
    });
    try {
      const head = await this.client.send(new HeadObjectCommand(target));
      if (
        head === null ||
        typeof head !== 'object' ||
        (head as Record<string, unknown>).VersionId !== exact.versionId
      ) {
        throw unavailable();
      }
    } catch (error) {
      if (isNotFound(error)) return 'ABSENT';
      throw unavailable();
    }
    try {
      const deleted = await this.client.send(new DeleteObjectCommand(target));
      if (
        deleted === null ||
        typeof deleted !== 'object' ||
        (deleted as Record<string, unknown>).VersionId !== exact.versionId
      ) {
        throw unavailable();
      }
      return 'DELETED';
    } catch (error) {
      if (isNotFound(error)) return 'ABSENT';
      throw unavailable();
    }
  }
}
