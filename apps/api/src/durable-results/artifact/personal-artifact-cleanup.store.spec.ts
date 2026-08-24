import { DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
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
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  });
}

describe('S3PersonalArtifactCleanupAdapter', () => {
  it('derives the final key and deletes only the supplied exact immutable version', async () => {
    const send = vi.fn(async (command: object) => {
      if (command instanceof HeadObjectCommand) return { VersionId: VERSION_ID };
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

    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.mocked(send).mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect(vi.mocked(send).mock.calls[1]?.[0]).toBeInstanceOf(DeleteObjectCommand);
    for (const [command] of vi.mocked(send).mock.calls) {
      const input = (command as HeadObjectCommand | DeleteObjectCommand).input;
      expect(input).toEqual({
        Bucket: BUCKET,
        Key: contentAddressedObjectKey(SHA256),
        VersionId: VERSION_ID,
      });
      expect(input).not.toHaveProperty('Body');
    }
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
