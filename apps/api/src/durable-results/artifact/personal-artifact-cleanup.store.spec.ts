import {
  DeleteObjectCommand,
  GetBucketLocationCommand,
  GetObjectTaggingCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { contentAddressedObjectKey } from './artifact-key';
import {
  S3PersonalArtifactCleanupAdapter,
  type PersonalArtifactCleanupS3Client,
} from './personal-artifact-cleanup.store';
import { VersionedBucketFixture } from './personal-artifact-cleanup.versioned-bucket.test-fixture';

const BUCKET = 'personal-cleanup-test';
const SHA256 = 'ab'.repeat(32);
const KEY = contentAddressedObjectKey(SHA256, 'PERSONAL_DATA');
const VERSION_ID = '3LgKp9Q4-exact-version';

function adapterOver(client: PersonalArtifactCleanupS3Client): S3PersonalArtifactCleanupAdapter {
  return new S3PersonalArtifactCleanupAdapter({ bucket: BUCKET, client });
}

function deletedVersionIds(bucket: VersionedBucketFixture): string[] {
  return bucket.commands
    .filter((command): command is DeleteObjectCommand => command instanceof DeleteObjectCommand)
    .map((command) => String(command.input.VersionId));
}

function failure(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error('provider detail must stay bounded'), {
    name,
    $metadata: { httpStatusCode },
  });
}

describe('S3PersonalArtifactCleanupAdapter', () => {
  it('lists the digest-derived key and erases every version: noncurrent first, the current one last', async () => {
    const bucket = new VersionedBucketFixture(BUCKET);
    const older = bucket.putVersion(KEY, { versionId: VERSION_ID });
    const current = bucket.putVersion(KEY);

    await expect(
      adapterOver(bucket).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).resolves.toBe('DELETED');

    expect(bucket.versionIds(KEY)).toEqual({ objects: [], markers: [] });
    expect(deletedVersionIds(bucket)).toEqual([older, current]);
    const listing = bucket.commands.find(
      (command): command is ListObjectVersionsCommand => command instanceof ListObjectVersionsCommand,
    );
    expect(listing?.input).toEqual({ Bucket: BUCKET, Prefix: KEY, MaxKeys: 1000 });
    for (const command of bucket.commands) {
      if (command instanceof DeleteObjectCommand || command instanceof GetObjectTaggingCommand) {
        expect(command.input).toEqual({
          Bucket: BUCKET,
          Key: KEY,
          VersionId: expect.any(String),
        });
      }
    }
  });

  it('erases a version no settlement recorded, and reports ABSENT for a commanded version already gone', async () => {
    const bucket = new VersionedBucketFixture(BUCKET);
    const unrecorded = bucket.putVersion(KEY, { versionId: 'refresh-copy-never-settled' });

    await expect(
      adapterOver(bucket).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).resolves.toBe('ABSENT');

    expect(deletedVersionIds(bucket)).toEqual([unrecorded]);
    expect(bucket.versionIds(KEY)).toEqual({ objects: [], markers: [] });
  });

  it('never makes an older version current on the way to an empty key', async () => {
    const bucket = new VersionedBucketFixture(BUCKET);
    bucket.putVersion(KEY, { versionId: VERSION_ID });
    bucket.putVersion(KEY);
    const current = bucket.putVersion(KEY);
    const seeded = bucket.currentHistory.length;

    await expect(
      adapterOver(bucket).eraseFinalObject({ sha256: SHA256, versionId: current }),
    ).resolves.toBe('DELETED');

    expect(bucket.currentHistory.slice(seeded).map((entry) => entry.current)).toEqual([
      current,
      current,
      null,
    ]);
  });

  it('deletes delete markers only after every object version beneath them', async () => {
    const bucket = new VersionedBucketFixture(BUCKET);
    bucket.putVersion(KEY, { versionId: VERSION_ID });
    const marker = bucket.putDeleteMarker(KEY);
    const seeded = bucket.currentHistory.length;

    await expect(
      adapterOver(bucket).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).resolves.toBe('DELETED');

    expect(deletedVersionIds(bucket)).toEqual([VERSION_ID, marker]);
    // A plain GET keeps reading nothing the whole time: the marker went last.
    expect(bucket.currentHistory.slice(seeded).map((entry) => entry.current)).toEqual([null, null]);
    expect(
      bucket.commands.some(
        (command) =>
          command instanceof GetObjectTaggingCommand && command.input.VersionId === marker,
      ),
    ).toBe(false);
  });

  it('pages through a key with more versions than one listing returns and still deletes the current one last', async () => {
    const bucket = new VersionedBucketFixture(BUCKET);
    for (let index = 0; index < 2_499; index += 1) bucket.putVersion(KEY);
    const current = bucket.putVersion(KEY);

    await expect(
      adapterOver(bucket).eraseFinalObject({ sha256: SHA256, versionId: current }),
    ).resolves.toBe('DELETED');

    const listings = bucket.commands.filter(
      (command): command is ListObjectVersionsCommand => command instanceof ListObjectVersionsCommand,
    );
    // Three pages for the sweep, one empty listing that proves the key is gone.
    expect(listings).toHaveLength(4);
    expect(listings[1]?.input).toMatchObject({
      Prefix: KEY,
      KeyMarker: KEY,
      VersionIdMarker: expect.any(String),
    });
    expect(deletedVersionIds(bucket)).toHaveLength(2_500);
    expect(deletedVersionIds(bucket).at(-1)).toBe(current);
    expect(bucket.versionIds(KEY)).toEqual({ objects: [], markers: [] });
  });

  it('touches only the exact key, never a longer key that shares its prefix', async () => {
    const bucket = new VersionedBucketFixture(BUCKET);
    bucket.putVersion(KEY, { versionId: VERSION_ID });
    const sibling = bucket.putVersion(`${KEY}-sibling`);

    await expect(
      adapterOver(bucket).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).resolves.toBe('DELETED');

    expect(bucket.versionIds(`${KEY}-sibling`)).toEqual({ objects: [sibling], markers: [] });
    expect(deletedVersionIds(bucket)).toEqual([VERSION_ID]);
  });

  it('sweeps again when a copy lands during the erasure', async () => {
    const bucket = new VersionedBucketFixture(BUCKET);
    bucket.putVersion(KEY, { versionId: VERSION_ID });
    let concurrent: string | null = null;
    bucket.beforeCommand = (command) => {
      if (command instanceof DeleteObjectCommand && concurrent === null) {
        concurrent = bucket.putVersion(KEY);
      }
    };

    await expect(
      adapterOver(bucket).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).resolves.toBe('DELETED');

    expect(concurrent).not.toBeNull();
    expect(deletedVersionIds(bucket)).toEqual([VERSION_ID, concurrent]);
    expect(bucket.versionIds(KEY)).toEqual({ objects: [], markers: [] });
  });

  it('stops after bounded passes when the key keeps acquiring versions, for the durable retry to resume', async () => {
    const bucket = new VersionedBucketFixture(BUCKET);
    bucket.putVersion(KEY, { versionId: VERSION_ID });
    bucket.beforeCommand = (command) => {
      if (command instanceof DeleteObjectCommand) bucket.putVersion(KEY);
    };

    await expect(
      adapterOver(bucket).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).rejects.toThrow('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE');
    const listings = bucket.commands.filter((command) => command instanceof ListObjectVersionsCommand);
    expect(listings).toHaveLength(4);
  });

  it.each([
    ['missing privacy tag', []],
    ['non-personal privacy tag', [{ Key: 'artifact-privacy', Value: 'CONFIDENTIAL_TENANT' }]],
    [
      'ambiguous privacy tags',
      [
        { Key: 'artifact-privacy', Value: 'PERSONAL_DATA' },
        { Key: 'artifact-privacy', Value: 'PUBLIC_ORGANIZATION' },
      ],
    ],
  ])('refuses the whole key when any version has a %s, before deleting anything', async (_label, tags) => {
    const bucket = new VersionedBucketFixture(BUCKET);
    bucket.putVersion(KEY, { versionId: VERSION_ID });
    const odd = bucket.putVersion(KEY, { tags });

    await expect(
      adapterOver(bucket).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).rejects.toThrow('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE');

    expect(deletedVersionIds(bucket)).toEqual([]);
    expect(bucket.versionIds(KEY)).toEqual({ objects: [VERSION_ID, odd], markers: [] });
  });

  it('treats a version that disappears between the listing and its tag read as gone', async () => {
    const bucket = new VersionedBucketFixture(BUCKET);
    bucket.putVersion(KEY, { versionId: VERSION_ID });
    const current = bucket.putVersion(KEY);
    bucket.beforeCommand = (command) => {
      if (command instanceof GetObjectTaggingCommand && command.input.VersionId === VERSION_ID) {
        // The lifecycle expires the noncurrent version in between.
        void bucket.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: KEY, VersionId: VERSION_ID }));
      }
    };

    await expect(
      adapterOver(bucket).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).resolves.toBe('DELETED');
    expect(bucket.versionIds(KEY)).toEqual({ objects: [], markers: [] });
    expect(deletedVersionIds(bucket)).toContain(current);
  });

  it('carries on when another sweep deleted a listed version before this delete reached it', async () => {
    const bucket = new VersionedBucketFixture(BUCKET);
    bucket.putVersion(KEY, { versionId: VERSION_ID });
    const current = bucket.putVersion(KEY);
    let raced = false;
    bucket.beforeCommand = (command) => {
      if (
        !raced &&
        command instanceof DeleteObjectCommand &&
        command.input.VersionId === VERSION_ID
      ) {
        raced = true;
        // A second deletion request sweeping the same shared digest got there first.
        bucket.removeElsewhere(KEY, VERSION_ID);
      }
    };
    const seeded = bucket.currentHistory.length;

    await expect(
      adapterOver(bucket).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).resolves.toBe('DELETED');

    expect(raced).toBe(true);
    expect(deletedVersionIds(bucket)).toEqual([VERSION_ID, current]);
    // The unacknowledged delete is confirmed by reading that exact version before the next delete.
    const afterRace = bucket.commands.slice(
      bucket.commands.findIndex(
        (command) => command instanceof DeleteObjectCommand && command.input.VersionId === VERSION_ID,
      ) + 1,
    );
    expect(afterRace[0]).toBeInstanceOf(GetObjectTaggingCommand);
    expect((afterRace[0] as GetObjectTaggingCommand).input.VersionId).toBe(VERSION_ID);
    expect(bucket.currentHistory.slice(seeded).map((entry) => entry.current)).toEqual([
      current,
      null,
    ]);
    expect(bucket.versionIds(KEY)).toEqual({ objects: [], markers: [] });
  });

  it('stops before the current version when a noncurrent delete is unacknowledged and the version is still stored', async () => {
    const bucket = new VersionedBucketFixture(BUCKET);
    bucket.putVersion(KEY, { versionId: VERSION_ID });
    const current = bucket.putVersion(KEY);
    const seeded = bucket.currentHistory.length;
    const client: PersonalArtifactCleanupS3Client = {
      send: async (command) =>
        command instanceof DeleteObjectCommand && command.input.VersionId === VERSION_ID
          ? {}
          : bucket.send(command),
    };

    await expect(
      adapterOver(client).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).rejects.toThrow('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE');

    // Deleting the current version now would make the older one current again.
    expect(deletedVersionIds(bucket)).toEqual([]);
    expect(bucket.versionIds(KEY)).toEqual({ objects: [VERSION_ID, current], markers: [] });
    expect(bucket.currentHistory.slice(seeded)).toEqual([]);
  });

  it('ends an attempt that has spent its time budget before the activity timeout, and the retry resumes', async () => {
    const bucket = new VersionedBucketFixture(BUCKET);
    bucket.putVersion(KEY, { versionId: VERSION_ID });
    bucket.putVersion(KEY);
    const current = bucket.putVersion(KEY);
    let now = 0;
    bucket.beforeCommand = () => {
      // Slow storage: every request takes ten seconds.
      now += 10_000;
    };
    const seeded = bucket.currentHistory.length;
    const slow = new S3PersonalArtifactCleanupAdapter({ bucket: BUCKET, client: bucket, now: () => now });

    await expect(
      slow.eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).rejects.toThrow('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE');

    // One listing, three tag reads and the two noncurrent deletes fit in 60 s;
    // the current version is never sent once the budget is spent.
    expect(bucket.commands).toHaveLength(6);
    expect(bucket.versionIds(KEY)).toEqual({ objects: [current], markers: [] });
    expect(bucket.currentHistory.slice(seeded).map((entry) => entry.current)).toEqual([
      current,
      current,
    ]);

    // The durable retry is a fresh attempt with a fresh budget.
    await expect(
      slow.eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).resolves.toBe('ABSENT');
    expect(bucket.versionIds(KEY)).toEqual({ objects: [], markers: [] });
  });

  it('confirms the bucket before treating an ambiguous tag 404 as a vanished version', async () => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof ListObjectVersionsCommand) {
        return send.mock.calls.filter(([sent]) => sent instanceof ListObjectVersionsCommand).length === 1
          ? { IsTruncated: false, Versions: [{ Key: KEY, VersionId: VERSION_ID, IsLatest: true }] }
          : { IsTruncated: false };
      }
      if (command instanceof GetObjectTaggingCommand) throw failure('NotFound', 404);
      if (command instanceof GetBucketLocationCommand) return { LocationConstraint: 'us-east-1' };
      if (command instanceof DeleteObjectCommand) return { VersionId: VERSION_ID };
      throw new Error('unexpected command');
    });

    await expect(
      adapterOver({ send }).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).resolves.toBe('DELETED');
    expect(send.mock.calls.some(([command]) => command instanceof GetBucketLocationCommand)).toBe(true);
  });

  it.each([
    ['missing bucket on the listing', failure('NoSuchBucket', 404)],
    ['a denied listing', failure('AccessDenied', 403)],
    ['an unreachable store', new Error('connect ECONNREFUSED')],
  ])('does not convert %s into ABSENT', async (_label, error) => {
    const send = vi.fn(async () => {
      throw error;
    });

    await expect(
      adapterOver({ send }).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).rejects.toThrow('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE');
    expect(send).toHaveBeenCalledOnce();
  });

  it('refuses a tag 404 when the bucket itself cannot be confirmed', async () => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof ListObjectVersionsCommand) {
        return { IsTruncated: false, Versions: [{ Key: KEY, VersionId: VERSION_ID, IsLatest: true }] };
      }
      if (command instanceof GetObjectTaggingCommand) throw failure('NotFound', 404);
      if (command instanceof GetBucketLocationCommand) throw failure('NoSuchBucket', 404);
      throw new Error('delete must not run');
    });

    await expect(
      adapterOver({ send }).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).rejects.toThrow('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE');
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(false);
  });

  it.each([
    ['a delete acknowledged for another version', { VersionId: 'someone-else' }],
    ['a delete without a version acknowledgement while the version is still stored', {}],
  ])('refuses %s', async (_label, acknowledgement) => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof ListObjectVersionsCommand) {
        return { IsTruncated: false, Versions: [{ Key: KEY, VersionId: VERSION_ID, IsLatest: true }] };
      }
      if (command instanceof GetObjectTaggingCommand) {
        return { VersionId: VERSION_ID, TagSet: [{ Key: 'artifact-privacy', Value: 'PERSONAL_DATA' }] };
      }
      if (command instanceof DeleteObjectCommand) return acknowledgement;
      throw new Error('unexpected command');
    });

    await expect(
      adapterOver({ send }).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).rejects.toThrow('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE');
  });

  it.each([
    ['a non-array version list', { IsTruncated: false, Versions: 'nope' }],
    ['a version without an id', { IsTruncated: false, Versions: [{ Key: KEY, IsLatest: true }] }],
    ['a truncated page without a continuation', { IsTruncated: true, Versions: [] }],
  ])('fails closed on a listing with %s', async (_label, listing) => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof ListObjectVersionsCommand) return listing;
      throw new Error('nothing else may run');
    });

    await expect(
      adapterOver({ send }).eraseFinalObject({ sha256: SHA256, versionId: VERSION_ID }),
    ).rejects.toThrow('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE');
    expect(send).toHaveBeenCalledOnce();
  });

  it('probes the version-listing grant on a personal-data key that holds nothing', async () => {
    const bucket = new VersionedBucketFixture(BUCKET);
    await expect(adapterOver(bucket).verifyVersionListing()).resolves.toBeUndefined();
    const [probe] = bucket.commands as ListObjectVersionsCommand[];
    expect(probe).toBeInstanceOf(ListObjectVersionsCommand);
    expect(probe?.input).toEqual({
      Bucket: BUCKET,
      Prefix: contentAddressedObjectKey('0'.repeat(64), 'PERSONAL_DATA'),
      MaxKeys: 1,
    });

    const denied = vi.fn(async () => {
      throw failure('AccessDenied', 403);
    });
    await expect(adapterOver({ send: denied }).verifyVersionListing()).rejects.toThrow(
      'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE',
    );
  });

  it.each([
    ['invalid digest', { sha256: 'caller/key', versionId: VERSION_ID }],
    ['missing version', { sha256: SHA256, versionId: '' }],
    ['extra caller key', { sha256: SHA256, versionId: VERSION_ID, objectKey: 'chosen' }],
  ])('rejects %s before S3', async (_case, input) => {
    const send = vi.fn();

    await expect(adapterOver({ send }).eraseFinalObject(input as never)).rejects.toThrow(
      'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE',
    );
    expect(send).not.toHaveBeenCalled();
  });
});
