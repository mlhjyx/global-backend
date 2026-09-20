import {
  DeleteObjectCommand,
  GetBucketLocationCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { contentAddressedObjectKey } from './artifact-key';
import {
  S3PersonalArtifactCleanupAdapter,
  type PersonalArtifactCleanupS3Client,
} from './personal-artifact-cleanup.store';

const BUCKET = 'personal-cleanup-test';
const SHA256 = 'ab'.repeat(32);
const VERSION_ID = '3LgKp9Q4-exact-version';

function notFound(): Error {
  return Object.assign(new Error('provider detail must stay bounded'), {
    name: 'NoSuchVersion',
    $metadata: { httpStatusCode: 404 },
  });
}

function ambiguousNotFound(name = 'NotFound'): Error {
  return Object.assign(new Error('ambiguous provider 404'), {
    name,
    $metadata: { httpStatusCode: 404 },
  });
}

describe('S3PersonalArtifactCleanupAdapter', () => {
  it('derives the final key and deletes only the supplied exact immutable version', async () => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof HeadObjectCommand) return { VersionId: VERSION_ID };
      if (command instanceof GetObjectTaggingCommand) {
        return {
          VersionId: VERSION_ID,
          TagSet: [{ Key: 'artifact-privacy', Value: 'PERSONAL_DATA' }],
        };
      }
      if (command instanceof DeleteObjectCommand) return { VersionId: VERSION_ID };
      throw new Error('unexpected command');
    });
    const adapter = new S3PersonalArtifactCleanupAdapter({
      bucket: BUCKET,
      client: { send } as PersonalArtifactCleanupS3Client,
    });

    await expect(
      adapter.deleteFinalVersion({ sha256: SHA256, versionId: VERSION_ID }),
    ).resolves.toBe('DELETED');

    expect(send).toHaveBeenCalledTimes(3);
    expect(vi.mocked(send).mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(vi.mocked(send).mock.calls[1]?.[0]).toBeInstanceOf(
      GetObjectTaggingCommand,
    );
    expect(vi.mocked(send).mock.calls[2]?.[0]).toBeInstanceOf(DeleteObjectCommand);
    for (const [command] of vi.mocked(send).mock.calls) {
      const input = (command as HeadObjectCommand | DeleteObjectCommand).input;
      expect(input).toEqual({
        Bucket: BUCKET,
        Key: contentAddressedObjectKey(SHA256, 'PERSONAL_DATA'),
        VersionId: VERSION_ID,
      });
      expect(input).not.toHaveProperty('Body');
    }
  });

  it.each([
    ['missing privacy tag', []],
    [
      'non-personal privacy tag',
      [{ Key: 'artifact-privacy', Value: 'CONFIDENTIAL_TENANT' }],
    ],
    [
      'ambiguous privacy tags',
      [
        { Key: 'artifact-privacy', Value: 'PERSONAL_DATA' },
        { Key: 'artifact-privacy', Value: 'PUBLIC_ORGANIZATION' },
      ],
    ],
  ])('refuses %s before exact-version deletion', async (_label, tagSet) => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof HeadObjectCommand) return { VersionId: VERSION_ID };
      if (command instanceof GetObjectTaggingCommand) {
        return { VersionId: VERSION_ID, TagSet: tagSet };
      }
      throw new Error('delete must not run without one PERSONAL_DATA tag');
    });
    const adapter = new S3PersonalArtifactCleanupAdapter({
      bucket: BUCKET,
      client: { send } as PersonalArtifactCleanupS3Client,
    });

    await expect(
      adapter.deleteFinalVersion({ sha256: SHA256, versionId: VERSION_ID }),
    ).rejects.toThrow('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE');
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(send).mock.calls.some(
        ([command]) => command instanceof DeleteObjectCommand,
      ),
    ).toBe(false);
  });

  it('treats a missing exact version as idempotent ABSENT without creating a delete marker', async () => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof HeadObjectCommand) throw notFound();
      throw new Error('delete must not run for an absent exact version');
    });
    const adapter = new S3PersonalArtifactCleanupAdapter({
      bucket: BUCKET,
      client: { send } as PersonalArtifactCleanupS3Client,
    });

    await expect(
      adapter.deleteFinalVersion({ sha256: SHA256, versionId: VERSION_ID }),
    ).resolves.toBe('ABSENT');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('confirms the bucket before treating an ambiguous object 404 as ABSENT', async () => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof HeadObjectCommand) throw ambiguousNotFound();
      if (command instanceof GetBucketLocationCommand) {
        return { LocationConstraint: 'us-east-1' };
      }
      throw new Error('unexpected command');
    });
    const adapter = new S3PersonalArtifactCleanupAdapter({
      bucket: BUCKET,
      client: { send } as PersonalArtifactCleanupS3Client,
    });

    await expect(
      adapter.deleteFinalVersion({ sha256: SHA256, versionId: VERSION_ID }),
    ).resolves.toBe('ABSENT');
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(send).mock.calls[1]?.[0]).toBeInstanceOf(
      GetBucketLocationCommand,
    );
  });

  it.each([
    ['missing bucket', ambiguousNotFound('NoSuchBucket')],
    ['gateway 404', ambiguousNotFound('404')],
  ])('does not convert %s into ABSENT', async (_label, failure) => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof HeadObjectCommand) throw failure;
      if (command instanceof GetBucketLocationCommand) throw failure;
      throw new Error('unexpected command');
    });
    const adapter = new S3PersonalArtifactCleanupAdapter({
      bucket: BUCKET,
      client: { send } as PersonalArtifactCleanupS3Client,
    });

    await expect(
      adapter.deleteFinalVersion({ sha256: SHA256, versionId: VERSION_ID }),
    ).rejects.toThrow('PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['invalid digest', { sha256: 'caller/key', versionId: VERSION_ID }],
    ['missing version', { sha256: SHA256, versionId: '' }],
    ['extra caller key', { sha256: SHA256, versionId: VERSION_ID, objectKey: 'chosen' }],
  ])('rejects %s before S3', async (_case, input) => {
    const send = vi.fn();
    const adapter = new S3PersonalArtifactCleanupAdapter({
      bucket: BUCKET,
      client: { send } as PersonalArtifactCleanupS3Client,
    });

    await expect(adapter.deleteFinalVersion(input as never)).rejects.toThrow(
      'PERSONAL_ARTIFACT_CLEANUP_STORE_UNAVAILABLE',
    );
    expect(send).not.toHaveBeenCalled();
  });
});
