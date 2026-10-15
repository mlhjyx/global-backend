import {
  DeleteObjectCommand,
  GetBucketLocationCommand,
  GetObjectTaggingCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
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
/** Listing-and-delete passes per command attempt before the durable retry takes over. */
const ERASE_PASSES = 3;
const LIST_PAGE_SIZE = 1_000;
/**
 * One key never legitimately holds this many entries: a reuse refreshes an
 * object at most about once a lifecycle day and noncurrent versions expire
 * after a day. Beyond it the attempt fails closed and retries.
 */
const MAX_LISTED_ENTRIES = 10_000;
/** A PERSONAL_DATA key no content can address in practice: the readiness probe lists it. */
const LISTING_PROBE_KEY = contentAddressedObjectKey('0'.repeat(64), 'PERSONAL_DATA');

type KeyEntry = Readonly<{ versionId: string; isLatest: boolean }>;
type KeyListing = Readonly<{
  versions: readonly KeyEntry[];
  deleteMarkers: readonly KeyEntry[];
}>;

function unavailable(): Error {
  return new Error(PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isExplicitObjectVersionAbsence(error: unknown): boolean {
  const record = asRecord(error);
  return record?.name === 'NoSuchKey' || record?.name === 'NoSuchVersion';
}

function isAmbiguousNotFound(error: unknown): boolean {
  const record = asRecord(error);
  if (!record) return false;
  const metadata = asRecord(record.$metadata);
  return (
    metadata?.httpStatusCode === 404 ||
    record.name === 'NotFound' ||
    record.name === '404' ||
    record.name === 'NoSuchBucket'
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

/** The entries of exactly `key` in one listing page; anything malformed fails closed. */
function keyEntries(value: unknown, key: string): KeyEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw unavailable();
  const entries: KeyEntry[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record || typeof record.Key !== 'string') throw unavailable();
    // The listing prefix is the exact key; a longer key sharing it is someone else's object.
    if (record.Key !== key) continue;
    if (!isCanonicalArtifactObjectVersionId(record.VersionId)) throw unavailable();
    entries.push(
      Object.freeze({ versionId: record.VersionId, isLatest: record.IsLatest === true }),
    );
  }
  return entries;
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

  /**
   * Erases the PERSONAL_DATA content object of `sha256`: every version and
   * every delete marker the bucket holds for that one key, whether or not a
   * settlement ever recorded the version. A reuse refresh copies the object
   * before its settlement commits, so the version ledger can miss a version;
   * the bucket's own listing cannot.
   *
   * Order matters on a versioned bucket: deleting the current version by
   * VersionId promotes the next one to current. Noncurrent versions go first,
   * the current version next, delete markers last, so no older version is
   * ever readable on the way and a crash mid-way leaves at most what was
   * already readable. Every object version must carry exactly the
   * PERSONAL_DATA tag before anything is deleted. The pass repeats while a
   * concurrent copy keeps landing; after a bounded number of passes the
   * attempt fails and the durable command retries.
   *
   * The result is the receipt for the commanded version: DELETED when the
   * erasure found it, ABSENT when it was already gone (an earlier command's
   * sweep of the same key, or the lifecycle).
   */
  async eraseFinalObject(input: Readonly<{
    sha256: string;
    versionId: string;
  }>): Promise<'DELETED' | 'ABSENT'> {
    const exact = parseInput(input);
    const key = contentAddressedObjectKey(exact.sha256, 'PERSONAL_DATA');
    let commandedFound = false;
    for (let pass = 0; ; pass += 1) {
      const listing = await this.listKey(key);
      if (listing.versions.length === 0 && listing.deleteMarkers.length === 0) {
        return commandedFound ? 'DELETED' : 'ABSENT';
      }
      if (pass === ERASE_PASSES) throw unavailable();
      if (listing.versions.some((entry) => entry.versionId === exact.versionId)) {
        commandedFound = true;
      }
      const present: KeyEntry[] = [];
      for (const version of listing.versions) {
        if (await this.hasPersonalTag(key, version.versionId)) present.push(version);
      }
      for (const entry of [
        ...present.filter((version) => !version.isLatest),
        ...present.filter((version) => version.isLatest),
        ...listing.deleteMarkers,
      ]) {
        await this.deleteVersion(key, entry.versionId);
      }
    }
  }

  /** Readiness: the cleanup principal may list the versions of a personal-data key. */
  async verifyVersionListing(): Promise<void> {
    try {
      const output = asRecord(
        await this.client.send(
          new ListObjectVersionsCommand({
            Bucket: this.bucket,
            Prefix: LISTING_PROBE_KEY,
            MaxKeys: 1,
          }),
        ),
      );
      if (!output) throw unavailable();
    } catch {
      throw unavailable();
    }
  }

  private async listKey(key: string): Promise<KeyListing> {
    const versions: KeyEntry[] = [];
    const deleteMarkers: KeyEntry[] = [];
    let continuation: Readonly<{ KeyMarker: string; VersionIdMarker: string }> | null = null;
    for (let listed = 0; listed < MAX_LISTED_ENTRIES; listed += LIST_PAGE_SIZE) {
      let output: Record<string, unknown> | null;
      try {
        output = asRecord(
          await this.client.send(
            new ListObjectVersionsCommand({
              Bucket: this.bucket,
              Prefix: key,
              MaxKeys: LIST_PAGE_SIZE,
              ...(continuation ?? {}),
            }),
          ),
        );
      } catch {
        throw unavailable();
      }
      if (!output) throw unavailable();
      versions.push(...keyEntries(output.Versions, key));
      deleteMarkers.push(...keyEntries(output.DeleteMarkers, key));
      if (output.IsTruncated !== true) {
        return Object.freeze({ versions, deleteMarkers });
      }
      if (
        typeof output.NextKeyMarker !== 'string' ||
        typeof output.NextVersionIdMarker !== 'string'
      ) {
        throw unavailable();
      }
      continuation = Object.freeze({
        KeyMarker: output.NextKeyMarker,
        VersionIdMarker: output.NextVersionIdMarker,
      });
    }
    throw unavailable();
  }

  /** True for a PERSONAL_DATA version, false for one already gone; anything else fails closed. */
  private async hasPersonalTag(key: string, versionId: string): Promise<boolean> {
    let tagging: Record<string, unknown> | null;
    try {
      tagging = asRecord(
        await this.client.send(
          new GetObjectTaggingCommand({
            Bucket: this.bucket,
            Key: key,
            VersionId: versionId,
          }),
        ),
      );
    } catch (error) {
      if (await this.isConfirmedAbsent(error)) return false;
      throw unavailable();
    }
    const tagSet = tagging?.TagSet;
    if (
      tagging?.VersionId !== versionId ||
      !Array.isArray(tagSet) ||
      tagSet.length !== 1 ||
      asRecord(tagSet[0])?.Key !== 'artifact-privacy' ||
      asRecord(tagSet[0])?.Value !== 'PERSONAL_DATA'
    ) {
      throw unavailable();
    }
    return true;
  }

  private async deleteVersion(key: string, versionId: string): Promise<void> {
    let deleted: Record<string, unknown> | null;
    try {
      deleted = asRecord(
        await this.client.send(
          new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: key,
            VersionId: versionId,
          }),
        ),
      );
    } catch (error) {
      if (await this.isConfirmedAbsent(error)) return;
      throw unavailable();
    }
    if (deleted?.VersionId !== versionId) throw unavailable();
  }

  private async isConfirmedAbsent(error: unknown): Promise<boolean> {
    if (isExplicitObjectVersionAbsence(error)) return true;
    if (!isAmbiguousNotFound(error)) return false;
    try {
      const location = await this.client.send(
        new GetBucketLocationCommand({ Bucket: this.bucket }),
      );
      return location !== null && typeof location === 'object';
    } catch {
      return false;
    }
  }
}
