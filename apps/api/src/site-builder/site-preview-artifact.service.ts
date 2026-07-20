import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import {
  RELEASE_MANIFEST_SCHEMA_VERSION,
  releaseManifestDigest,
  type ReleaseManifestFile,
  type ReleaseManifestV1,
} from './release-artifact';
import type { StorageService } from './storage.service';

const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PREVIEW_FILE_BYTES = 32 * 1024 * 1024;

interface PreviewPointerRow {
  artifactKey: string;
  releaseId: string | null;
  artifactPrefix: string | null;
  artifactDigest: string | null;
  manifest: unknown;
  manifestDigest: string | null;
}

export interface SitePreviewArtifact {
  body: Buffer;
  contentType: string;
  etag: string;
}

function previewPath(input: string): string {
  if (
    input.includes('\\') ||
    input.includes('\0') ||
    input.startsWith('/') ||
    input.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('SITE_PREVIEW_INVALID_PATH');
  }
  const candidate = input === '' ? 'index.html' : input.endsWith('/') ? `${input}index.html` : input;
  if (candidate.length > 1024) throw new Error('SITE_PREVIEW_INVALID_PATH');
  return candidate;
}

function manifestFile(value: unknown, requestedPath: string): ReleaseManifestFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('SITE_PREVIEW_MANIFEST_INVALID');
  }
  const manifest = value as Partial<ReleaseManifestV1>;
  if (
    manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION ||
    !Array.isArray(manifest.files) ||
    typeof manifest.releaseId !== 'string' ||
    typeof manifest.siteId !== 'string' ||
    typeof manifest.producerToken !== 'string' ||
    typeof manifest.artifactPrefix !== 'string' ||
    typeof manifest.artifactDigest !== 'string'
  ) {
    throw new Error('SITE_PREVIEW_MANIFEST_INVALID');
  }
  const file = manifest.files.find((candidate) => candidate.path === requestedPath);
  if (
    !file ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > MAX_PREVIEW_FILE_BYTES ||
    !SHA256.test(file.sha256) ||
    typeof file.contentType !== 'string' ||
    file.contentType.length === 0 ||
    file.objectKey !==
      `${manifest.artifactPrefix}/attempts/${manifest.producerToken}/files/${file.path}`
  ) {
    throw new NotFoundException('SITE_PREVIEW_ARTIFACT_NOT_FOUND');
  }
  return file;
}

@Injectable()
export class SitePreviewArtifactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: Pick<StorageService, 'getBufferBounded'>,
  ) {}

  async get(slug: string, assetPath: string): Promise<SitePreviewArtifact> {
    if (!SLUG.test(slug)) throw new Error('SITE_PREVIEW_INVALID_PATH');
    const requestedPath = previewPath(assetPath);
    const rows = await this.prisma.$queryRaw<PreviewPointerRow[]>`
      SELECT
        "artifactKey",
        "releaseId",
        "artifactPrefix",
        "artifactDigest",
        manifest,
        "manifestDigest"
      FROM resolve_site_preview_release(${slug})
    `;
    const row = rows[0];
    if (
      !row ||
      !row.artifactKey.startsWith('release:') ||
      !row.releaseId ||
      row.artifactKey !== `release:${row.releaseId}` ||
      !row.artifactPrefix ||
      !row.artifactDigest ||
      !row.manifestDigest ||
      !SHA256.test(row.artifactDigest) ||
      !SHA256.test(row.manifestDigest)
    ) {
      throw new NotFoundException('SITE_PREVIEW_RELEASE_NOT_FOUND');
    }
    const manifest = row.manifest as ReleaseManifestV1;
    if (releaseManifestDigest(manifest) !== row.manifestDigest) {
      throw new Error('SITE_PREVIEW_MANIFEST_DIGEST_MISMATCH');
    }
    if (
      manifest.releaseId !== row.releaseId ||
      manifest.artifactPrefix !== row.artifactPrefix ||
      manifest.artifactDigest !== row.artifactDigest
    ) {
      throw new Error('SITE_PREVIEW_MANIFEST_SCOPE_MISMATCH');
    }
    const file = manifestFile(manifest, requestedPath);
    const body = await this.storage.getBufferBounded(
      file.objectKey,
      Math.max(1, file.size),
    );
    const digest = createHash('sha256').update(body).digest('hex');
    if (body.length !== file.size || digest !== file.sha256) {
      throw new Error('SITE_PREVIEW_OBJECT_DIGEST_MISMATCH');
    }
    return {
      body,
      contentType: file.contentType,
      etag: `"sha256:${file.sha256}"`,
    };
  }
}
