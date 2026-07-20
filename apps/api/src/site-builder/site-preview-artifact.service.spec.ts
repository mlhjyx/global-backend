import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../prisma/prisma.service';
import {
  releaseManifestDigest,
  type ReleaseManifestV1,
} from './release-artifact';
import { SitePreviewArtifactService } from './site-preview-artifact.service';

const bytes = Buffer.from('<h1>release preview</h1>');
const fileDigest = createHash('sha256').update(bytes).digest('hex');
const manifest: ReleaseManifestV1 = {
  schemaVersion: 'site-builder-release-manifest/v1',
  releaseId: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  siteId: '33333333-3333-4333-8333-333333333333',
  siteVersionId: '44444444-4444-4444-8444-444444444444',
  buildRunId: '55555555-5555-4555-8555-555555555555',
  producerToken: '66666666-6666-4666-8666-666666666666',
  artifactPrefix:
    'sites/33333333-3333-4333-8333-333333333333/releases/11111111-1111-4111-8111-111111111111',
  artifactDigest: 'a'.repeat(64),
  specVersion: '1.0.0',
  specDigest: 'b'.repeat(64),
  buildIdentity: 'site-renderer@1.0.0+sha.abc123',
  createdAt: '2026-07-20T00:00:00.000Z',
  componentTypes: ['HeroBanner'],
  files: [
    {
      path: 'index.html',
      objectKey:
        'sites/33333333-3333-4333-8333-333333333333/releases/11111111-1111-4111-8111-111111111111/attempts/66666666-6666-4666-8666-666666666666/files/index.html',
      size: bytes.length,
      sha256: fileDigest,
      contentType: 'text/html; charset=utf-8',
    },
  ],
};

function service(overrides?: { manifestDigest?: string; body?: Buffer }) {
  const query = vi.fn(async () => [
    {
      artifactKey: `release:${manifest.releaseId}`,
      releaseId: manifest.releaseId,
      artifactPrefix: manifest.artifactPrefix,
      artifactDigest: manifest.artifactDigest,
      manifest,
      manifestDigest:
        overrides?.manifestDigest ?? releaseManifestDigest(manifest),
    },
  ]);
  const getBufferBounded = vi.fn(
    async () => overrides?.body ?? Buffer.from(bytes),
  );
  return {
    query,
    getBufferBounded,
    previews: new SitePreviewArtifactService(
      { $queryRaw: query } as unknown as PrismaService,
      { getBufferBounded } as never,
    ),
  };
}

describe('SitePreviewArtifactService', () => {
  it('resolves the sole active pointer and verifies manifest plus object digest before serving', async () => {
    const fixture = service();
    await expect(fixture.previews.get('acme', '')).resolves.toEqual({
      body: bytes,
      contentType: 'text/html; charset=utf-8',
      etag: `"sha256:${fileDigest}"`,
    });
    expect(fixture.getBufferBounded).toHaveBeenCalledWith(
      manifest.files[0]?.objectKey,
      bytes.length,
    );
  });

  it('fails closed on DB manifest digest mismatch before reading an object', async () => {
    const fixture = service({ manifestDigest: '0'.repeat(64) });
    await expect(fixture.previews.get('acme', 'index.html')).rejects.toThrow(
      'SITE_PREVIEW_MANIFEST_DIGEST_MISMATCH',
    );
    expect(fixture.getBufferBounded).not.toHaveBeenCalled();
  });

  it('fails closed when the immutable object bytes no longer match the manifest', async () => {
    const fixture = service({ body: Buffer.from('tampered') });
    await expect(fixture.previews.get('acme', 'index.html')).rejects.toThrow(
      'SITE_PREVIEW_OBJECT_DIGEST_MISMATCH',
    );
  });

  it('rejects traversal before resolving any pointer', async () => {
    const fixture = service();
    await expect(fixture.previews.get('acme', '../secret')).rejects.toThrow(
      'SITE_PREVIEW_INVALID_PATH',
    );
    expect(fixture.query).not.toHaveBeenCalled();
  });
});
