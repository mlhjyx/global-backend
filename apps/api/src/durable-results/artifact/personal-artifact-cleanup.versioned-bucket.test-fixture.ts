import {
  DeleteObjectCommand,
  GetBucketLocationCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import type { PersonalArtifactCleanupS3Client } from './personal-artifact-cleanup.store';

type Tag = Readonly<{ Key: string; Value: string }>;

interface Entry {
  readonly versionId: string;
  readonly kind: 'object' | 'marker';
  readonly tags: readonly Tag[];
}

export const PERSONAL_DATA_TAGS: readonly Tag[] = Object.freeze([
  Object.freeze({ Key: 'artifact-privacy', Value: 'PERSONAL_DATA' }),
]);

function s3Error(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode },
  });
}

/**
 * An in-memory versioned bucket with the S3/MinIO semantics the personal-data
 * cleanup adapter depends on: each key holds a stack of versions and delete
 * markers, the newest one is current, deleting the current version by
 * VersionId makes the next newer-than-the-rest entry current again (the
 * resurrection MinIO showed), and ListObjectVersions pages newest-first per
 * key with KeyMarker/VersionIdMarker continuation. `currentHistory` records,
 * after every mutation, the object version a plain GET would read (or null).
 */
export class VersionedBucketFixture implements PersonalArtifactCleanupS3Client {
  readonly commands: object[] = [];
  readonly currentHistory: Array<Readonly<{ key: string; current: string | null }>> = [];
  private readonly keys = new Map<string, Entry[]>();
  private sequence = 0;
  /** Runs before each command is served; may mutate the bucket or throw. */
  beforeCommand: ((command: object) => void) | null = null;

  constructor(readonly bucket: string) {}

  putVersion(
    key: string,
    options: Readonly<{ versionId?: string; tags?: readonly Tag[] }> = {},
  ): string {
    const versionId = options.versionId ?? this.nextVersionId();
    this.entries(key).push({
      versionId,
      kind: 'object',
      tags: options.tags ?? PERSONAL_DATA_TAGS,
    });
    this.recordCurrent(key);
    return versionId;
  }

  putDeleteMarker(key: string): string {
    const versionId = this.nextVersionId();
    this.entries(key).push({ versionId, kind: 'marker', tags: [] });
    this.recordCurrent(key);
    return versionId;
  }

  /** Removes one entry the way another principal or the lifecycle would, unseen by `commands`. */
  removeElsewhere(key: string, versionId: string): void {
    const stack = this.keys.get(key) ?? [];
    const index = stack.findIndex((entry) => entry.versionId === versionId);
    if (index < 0) return;
    stack.splice(index, 1);
    if (stack.length === 0) this.keys.delete(key);
    this.recordCurrent(key);
  }

  /** The object version a plain GET reads, or null for a marker or nothing. */
  current(key: string): string | null {
    const stack = this.keys.get(key) ?? [];
    const latest = stack[stack.length - 1];
    return latest?.kind === 'object' ? latest.versionId : null;
  }

  versionIds(key: string): Readonly<{ objects: string[]; markers: string[] }> {
    const stack = this.keys.get(key) ?? [];
    return {
      objects: stack.filter((entry) => entry.kind === 'object').map((entry) => entry.versionId),
      markers: stack.filter((entry) => entry.kind === 'marker').map((entry) => entry.versionId),
    };
  }

  async send(command: object): Promise<unknown> {
    this.commands.push(command);
    this.beforeCommand?.(command);
    if (command instanceof GetBucketLocationCommand) {
      if (command.input.Bucket !== this.bucket) throw s3Error('NoSuchBucket', 404);
      return { LocationConstraint: 'us-east-1' };
    }
    if (command instanceof ListObjectVersionsCommand) {
      return this.list(command.input);
    }
    if (command instanceof HeadObjectCommand) {
      this.assertBucket(command.input.Bucket);
      const key = String(command.input.Key);
      const entry =
        command.input.VersionId === undefined
          ? (this.keys.get(key) ?? []).at(-1)
          : this.find(key, command.input.VersionId);
      if (!entry) throw s3Error('NotFound', 404);
      if (entry.kind === 'marker') throw s3Error('MethodNotAllowed', 405);
      return { VersionId: entry.versionId };
    }
    if (command instanceof GetObjectTaggingCommand) {
      this.assertBucket(command.input.Bucket);
      const entry = this.find(String(command.input.Key), command.input.VersionId);
      if (!entry) throw s3Error('NoSuchVersion', 404);
      if (entry.kind === 'marker') throw s3Error('MethodNotAllowed', 405);
      return { VersionId: entry.versionId, TagSet: entry.tags.map((tag) => ({ ...tag })) };
    }
    if (command instanceof DeleteObjectCommand) {
      this.assertBucket(command.input.Bucket);
      const key = String(command.input.Key);
      const versionId = command.input.VersionId;
      if (versionId === undefined) {
        return { VersionId: this.putDeleteMarker(key), DeleteMarker: true };
      }
      const stack = this.keys.get(key) ?? [];
      const index = stack.findIndex((entry) => entry.versionId === versionId);
      // MinIO answers a delete of a version that no longer exists with 204 and
      // no x-amz-version-id (real-MinIO spec pins this).
      if (index < 0) return {};
      const [removed] = stack.splice(index, 1);
      if (stack.length === 0) this.keys.delete(key);
      this.recordCurrent(key);
      return removed?.kind === 'marker'
        ? { VersionId: versionId, DeleteMarker: true }
        : { VersionId: versionId };
    }
    throw new Error('VERSIONED_BUCKET_FIXTURE_UNSUPPORTED_COMMAND');
  }

  private list(input: ListObjectVersionsCommand['input']): unknown {
    this.assertBucket(input.Bucket);
    const prefix = input.Prefix ?? '';
    const maxKeys = input.MaxKeys ?? 1000;
    const ordered = [...this.keys.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .flatMap((key) =>
        [...(this.keys.get(key) ?? [])]
          .map((entry, index, stack) => ({
            key,
            entry,
            isLatest: index === stack.length - 1,
          }))
          .reverse(),
      );
    let start = 0;
    if (input.KeyMarker !== undefined) {
      const marker = ordered.findIndex(
        (item) =>
          item.key === input.KeyMarker &&
          item.entry.versionId === input.VersionIdMarker,
      );
      start =
        marker >= 0
          ? marker + 1
          : ordered.findIndex((item) => item.key > String(input.KeyMarker));
      if (start < 0) start = ordered.length;
    }
    const page = ordered.slice(start, start + maxKeys);
    const truncated = start + maxKeys < ordered.length;
    const last = page[page.length - 1];
    const view = (item: (typeof page)[number]) => ({
      Key: item.key,
      VersionId: item.entry.versionId,
      IsLatest: item.isLatest,
    });
    return {
      IsTruncated: truncated,
      ...(truncated && last
        ? { NextKeyMarker: last.key, NextVersionIdMarker: last.entry.versionId }
        : {}),
      Versions: page.filter((item) => item.entry.kind === 'object').map(view),
      DeleteMarkers: page.filter((item) => item.entry.kind === 'marker').map(view),
    };
  }

  private find(key: string, versionId: string | undefined): Entry | undefined {
    return (this.keys.get(key) ?? []).find((entry) => entry.versionId === versionId);
  }

  private assertBucket(bucket: string | undefined): void {
    if (bucket !== this.bucket) throw s3Error('NoSuchBucket', 404);
  }

  private entries(key: string): Entry[] {
    let stack = this.keys.get(key);
    if (!stack) {
      stack = [];
      this.keys.set(key, stack);
    }
    return stack;
  }

  private recordCurrent(key: string): void {
    this.currentHistory.push({ key, current: this.current(key) });
  }

  private nextVersionId(): string {
    this.sequence += 1;
    return `fixture-version-${String(this.sequence).padStart(6, '0')}`;
  }
}
