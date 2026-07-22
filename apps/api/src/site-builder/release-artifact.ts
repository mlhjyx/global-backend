import { createHash } from 'node:crypto';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  SITE_SPEC_VERSION,
  SITE_SPEC_RELEASE_COMPONENT_TYPES,
  assertReleaseComponentEligible,
  validateBlock,
  type SiteSpec,
} from '@global/contracts';

export const RELEASE_MANIFEST_SCHEMA_VERSION =
  'site-builder-release-manifest/v1' as const;

/** @deprecated Use the shared release-eligible registry from @global/contracts. */
export const R1_RENDERER_COMPONENT_TYPES =
  SITE_SPEC_RELEASE_COMPONENT_TYPES;

const MAX_RELEASE_FILES = 4096;
const MAX_RELEASE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_RELEASE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_RELEASE_DEPTH = 32;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUILD_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._+@:/-]{0,127}$/;

export interface ReleaseArtifactFile {
  path: string;
  objectKey: string;
  size: number;
  sha256: string;
  contentType: string;
  data: Buffer;
}

export interface ReleaseManifestFile {
  path: string;
  objectKey: string;
  size: number;
  sha256: string;
  contentType: string;
}

export interface ReleaseManifestV1 {
  schemaVersion: typeof RELEASE_MANIFEST_SCHEMA_VERSION;
  releaseId: string;
  workspaceId: string;
  siteId: string;
  siteVersionId: string;
  buildRunId: string;
  producerToken: string;
  artifactPrefix: string;
  artifactDigest: string;
  specVersion: string;
  specDigest: string;
  buildIdentity: string;
  createdAt: string;
  componentTypes: string[];
  files: ReleaseManifestFile[];
}

export interface PreparedReleaseArtifact {
  files: ReleaseArtifactFile[];
  manifest: ReleaseManifestV1;
  manifestBytes: Buffer;
  manifestDigest: string;
  manifestObjectKey: string;
  artifactDigest: string;
}

export interface ReleaseArtifactStorage {
  putBufferImmutable(
    key: string,
    data: Buffer,
    contentType: string,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<'created' | 'exists'>;
  hashObject(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ sha256: string; head: Buffer; size: number }>;
}

export interface BuildReleaseArtifactInput {
  root: string;
  spec: SiteSpec;
  storedSpecVersion: string;
  releaseId: string;
  workspaceId: string;
  siteId: string;
  siteVersionId: string;
  buildRunId: string;
  producerToken: string;
  artifactPrefix: string;
  releaseCreatedAt: Date;
  buildIdentity: string;
}

export function assertReleaseContract(
  spec: SiteSpec,
  storedSpecVersion: string,
): void {
  if (
    storedSpecVersion !== SITE_SPEC_VERSION ||
    spec.specVersion !== SITE_SPEC_VERSION ||
    spec.specVersion !== storedSpecVersion
  ) {
    throw new Error(
      `SITE_RELEASE_UNSUPPORTED_SPEC_VERSION: stored=${storedSpecVersion} embedded=${spec.specVersion} supported=${SITE_SPEC_VERSION}`,
    );
  }
  const pageIds = new Set(spec.pages.map((page) => page.id));
  for (const page of spec.pages) {
    for (const block of page.puck.content) {
      validateBlock(block);
      assertReleaseComponentEligible(block.type);
      const props = block.props as Record<string, unknown>;
      const ctaFields =
        block.type === 'PricingTable'
          ? ['primaryCta', 'secondaryCta']
          : block.type === 'CtaCenter'
            ? ['primaryCta', 'secondaryCta']
            : block.type === 'ServicesDark'
              ? ['allCta']
              : block.type === 'ServiceRows'
                ? ['cta']
                : [];
      for (const field of ctaFields) {
        const cta = props[field] as { pageId?: string; url?: string } | undefined;
        if (cta && !cta.url && !pageIds.has(cta.pageId ?? '')) {
          throw new Error(
            `SITE_RELEASE_PAGE_REFERENCE_UNKNOWN: ${block.type}.${field}.pageId=${cta.pageId ?? ''}`,
          );
        }
      }
    }
  }
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SITE_RELEASE_NON_JSON_VALUE');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        const item = record[key];
        if (item === undefined) throw new Error('SITE_RELEASE_NON_JSON_VALUE');
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      })
      .join(',')}}`;
  }
  throw new Error('SITE_RELEASE_NON_JSON_VALUE');
}

export function releaseManifestDigest(manifest: ReleaseManifestV1): string {
  return sha256(canonicalJson(manifest));
}

function contentTypeFor(relativePath: string): string {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return (
    {
      '.avif': 'image/avif',
      '.css': 'text/css; charset=utf-8',
      '.gif': 'image/gif',
      '.htm': 'text/html; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.ico': 'image/x-icon',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.otf': 'font/otf',
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ttf': 'font/ttf',
      '.txt': 'text/plain; charset=utf-8',
      '.webp': 'image/webp',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.xml': 'application/xml; charset=utf-8',
    } as Record<string, string>
  )[extension] ?? 'application/octet-stream';
}

function validateIdentity(input: BuildReleaseArtifactInput): void {
  for (const value of [
    input.releaseId,
    input.workspaceId,
    input.siteId,
    input.siteVersionId,
    input.buildRunId,
    input.producerToken,
  ]) {
    if (!UUID.test(value)) throw new Error('SITE_RELEASE_INVALID_IDENTITY');
  }
  const expectedPrefix = `sites/${input.siteId}/releases/${input.releaseId}`;
  if (input.artifactPrefix !== expectedPrefix) {
    throw new Error('SITE_RELEASE_INVALID_ARTIFACT_PREFIX');
  }
  if (!BUILD_IDENTITY.test(input.buildIdentity)) {
    throw new Error('SITE_RELEASE_INVALID_BUILD_IDENTITY');
  }
  if (!Number.isFinite(input.releaseCreatedAt.getTime())) {
    throw new Error('SITE_RELEASE_INVALID_CREATED_AT');
  }
}

async function collectFiles(
  root: string,
  objectRoot: string,
): Promise<ReleaseArtifactFile[]> {
  const files: ReleaseArtifactFile[] = [];
  let totalBytes = 0;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_RELEASE_DEPTH) {
      throw new Error('SITE_RELEASE_DIRECTORY_DEPTH_EXCEEDED');
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error('SITE_RELEASE_SYMLINK_FORBIDDEN');
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new Error('SITE_RELEASE_NON_REGULAR_FILE');
      const relativePath = path
        .relative(root, absolute)
        .split(path.sep)
        .join('/');
      if (
        relativePath.length === 0 ||
        relativePath.startsWith('../') ||
        relativePath.includes('/../') ||
        relativePath.includes('\\') ||
        relativePath.includes('\0')
      ) {
        throw new Error('SITE_RELEASE_INVALID_FILE_PATH');
      }
      const handle = await open(absolute, 'r');
      try {
        const fileStat = await handle.stat();
        if (!fileStat.isFile()) throw new Error('SITE_RELEASE_NON_REGULAR_FILE');
        if (fileStat.size > MAX_RELEASE_FILE_BYTES) {
          throw new Error('SITE_RELEASE_FILE_SIZE_EXCEEDED');
        }
        totalBytes += fileStat.size;
        if (totalBytes > MAX_RELEASE_TOTAL_BYTES) {
          throw new Error('SITE_RELEASE_TOTAL_SIZE_EXCEEDED');
        }
        const data = await handle.readFile();
        if (data.length !== fileStat.size) {
          throw new Error('SITE_RELEASE_FILE_CHANGED_DURING_READ');
        }
        files.push({
          path: relativePath,
          objectKey: `${objectRoot}/files/${relativePath}`,
          size: data.length,
          sha256: sha256(data),
          contentType: contentTypeFor(relativePath),
          data,
        });
        if (files.length > MAX_RELEASE_FILES) {
          throw new Error('SITE_RELEASE_FILE_COUNT_EXCEEDED');
        }
      } finally {
        await handle.close();
      }
    }
  };

  await visit(root, 0);
  if (files.length === 0) throw new Error('SITE_RELEASE_EMPTY_ARTIFACT');
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function buildReleaseArtifact(
  input: BuildReleaseArtifactInput,
): Promise<PreparedReleaseArtifact> {
  assertReleaseContract(input.spec, input.storedSpecVersion);
  validateIdentity(input);
  const objectRoot = `${input.artifactPrefix}/attempts/${input.producerToken}`;
  const files = await collectFiles(input.root, objectRoot);
  const manifestFiles = files.map(({ data: _data, ...file }) => file);
  const artifactDigest = sha256(canonicalJson(manifestFiles));
  const manifest: ReleaseManifestV1 = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    releaseId: input.releaseId,
    workspaceId: input.workspaceId,
    siteId: input.siteId,
    siteVersionId: input.siteVersionId,
    buildRunId: input.buildRunId,
    producerToken: input.producerToken,
    artifactPrefix: input.artifactPrefix,
    artifactDigest,
    specVersion: input.storedSpecVersion,
    specDigest: sha256(canonicalJson(input.spec)),
    buildIdentity: input.buildIdentity,
    createdAt: input.releaseCreatedAt.toISOString(),
    componentTypes: [
      ...new Set(
        input.spec.pages.flatMap((page) =>
          page.puck.content.map((block) => block.type),
        ),
      ),
    ].sort(),
    files: manifestFiles,
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  return {
    files,
    manifest,
    manifestBytes,
    manifestDigest: releaseManifestDigest(manifest),
    manifestObjectKey: `${objectRoot}/release-manifest.json`,
    artifactDigest,
  };
}

async function putAndVerify(
  storage: ReleaseArtifactStorage,
  input: {
    key: string;
    data: Buffer;
    contentType: string;
    sha256: string;
  },
  signal?: AbortSignal,
): Promise<void> {
  await storage.putBufferImmutable(
    input.key,
    input.data,
    input.contentType,
    input.sha256,
    signal,
  );
  const observed = await storage.hashObject(input.key, signal);
  if (observed.size !== input.data.length || observed.sha256 !== input.sha256) {
    throw new Error(`SITE_RELEASE_OBJECT_INTEGRITY_MISMATCH: ${input.key}`);
  }
}

export async function uploadReleaseArtifact(
  release: PreparedReleaseArtifact,
  storage: ReleaseArtifactStorage,
  signal?: AbortSignal,
): Promise<void> {
  for (const file of release.files) {
    await putAndVerify(
      storage,
      {
        key: file.objectKey,
        data: file.data,
        contentType: file.contentType,
        sha256: file.sha256,
      },
      signal,
    );
  }
  await putAndVerify(
    storage,
    {
      key: release.manifestObjectKey,
      data: release.manifestBytes,
      contentType: 'application/json; charset=utf-8',
      sha256: release.manifestDigest,
    },
    signal,
  );
}
