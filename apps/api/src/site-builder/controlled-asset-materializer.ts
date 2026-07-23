import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  demoVisualPackV2Digest,
  validateDesignBriefV2,
  validateSiteSpecV1_1,
  type DesignBriefV2,
  type DesignCatalogV2,
  type AssetRefV1_1,
  type SiteSpecV1_1,
  type TenantAssetRefV1_1,
} from '@global/contracts';

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/avif': 'avif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};
const APPROVED_CATALOG_ASSET_DIRECTORY =
  'apps/site-renderer/fixtures/design-demo-visuals/';

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function beneath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  );
}

export interface TenantVariantBytes {
  data: Buffer;
  assetId: string;
  kind: string;
  contentHash: string;
  variantId: string;
  variantHash: string;
  mimeType: string;
}

export interface TenantVariantReader {
  /** Repository implementation must execute in the caller's RLS workspace. */
  readReadyVariant(input: {
    workspaceId: string;
    siteId: string;
    assetId: string;
    variantId: string;
  }): Promise<TenantVariantBytes | null>;
}

export interface MaterializedAssetOverlay {
  publicDir: string;
  urls: Record<string, string>;
  cleanup(): Promise<void>;
}

export class ControlledAssetMaterializationError extends Error {
  constructor(
    readonly code:
      | 'CONTROLLED_ASSET_TENANT_INVALID'
      | 'CONTROLLED_ASSET_CATALOG_INVALID'
      | 'CONTROLLED_ASSET_PATH_FORBIDDEN',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ControlledAssetMaterializationError';
  }
}

function extension(mimeType: string): string {
  const value = EXTENSION_BY_MIME[mimeType];
  if (!value) {
    throw new ControlledAssetMaterializationError(
      'CONTROLLED_ASSET_CATALOG_INVALID',
      `unsupported asset mime ${mimeType}`,
    );
  }
  return value;
}

export function controlledAssetUrl(ref: AssetRefV1_1): string {
  return ref.source === 'tenant'
    ? `/assets/tenant/${ref.assetId.toLowerCase()}/${ref.variantHash}.${extension(ref.mimeType)}`
    : `/assets/catalog/${ref.sha256}.${extension(ref.mimeType)}`;
}

export function controlledAssetUrls(
  assets: Readonly<Record<string, AssetRefV1_1>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(assets).map(([referenceId, ref]) => [
      referenceId,
      controlledAssetUrl(ref),
    ]),
  );
}

async function writeImmutable(
  root: string,
  relativePath: string,
  data: Buffer,
): Promise<void> {
  const target = path.join(root, relativePath);
  if (!beneath(root, target)) {
    throw new ControlledAssetMaterializationError(
      'CONTROLLED_ASSET_PATH_FORBIDDEN',
      relativePath,
    );
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, data, { flag: 'wx', mode: 0o600 });
}

async function readCatalogAsset(
  repositoryRoot: string,
  repositoryPath: string,
): Promise<Buffer> {
  if (!repositoryPath.startsWith(APPROVED_CATALOG_ASSET_DIRECTORY)) {
    throw new ControlledAssetMaterializationError(
      'CONTROLLED_ASSET_PATH_FORBIDDEN',
      repositoryPath,
    );
  }
  const root = await realpath(repositoryRoot);
  const candidate = path.resolve(root, repositoryPath);
  if (!beneath(root, candidate)) {
    throw new ControlledAssetMaterializationError(
      'CONTROLLED_ASSET_PATH_FORBIDDEN',
      repositoryPath,
    );
  }
  const relativeParts = path.relative(root, candidate).split(path.sep);
  let cursor = root;
  for (const part of relativeParts) {
    cursor = path.join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink()) {
      throw new ControlledAssetMaterializationError(
        'CONTROLLED_ASSET_PATH_FORBIDDEN',
        repositoryPath,
      );
    }
  }
  const resolved = await realpath(candidate);
  if (!beneath(root, resolved) || !(await lstat(resolved)).isFile()) {
    throw new ControlledAssetMaterializationError(
      'CONTROLLED_ASSET_PATH_FORBIDDEN',
      repositoryPath,
    );
  }
  return readFile(resolved);
}

function assertTenantBytes(
  ref: TenantAssetRefV1_1,
  observed: TenantVariantBytes | null,
): asserts observed is TenantVariantBytes {
  if (
    !observed ||
    observed.assetId.toLowerCase() !== ref.assetId.toLowerCase() ||
    observed.kind !== ref.kind ||
    observed.variantId.toLowerCase() !== ref.variantId.toLowerCase() ||
    observed.contentHash !== ref.contentHash ||
    observed.variantHash !== ref.variantHash ||
    observed.mimeType !== ref.mimeType ||
    sha256(observed.data) !== ref.variantHash
  ) {
    throw new ControlledAssetMaterializationError(
      'CONTROLLED_ASSET_TENANT_INVALID',
      ref.assetId,
    );
  }
}

/**
 * Builds a one-shot public overlay. The resulting URLs are logical-root paths;
 * ControlledAssetPicture applies the renderer BASE_PATH exactly once.
 */
export async function materializeControlledAssetOverlay(input: {
  workspaceId: string;
  siteId: string;
  spec: SiteSpecV1_1;
  designBrief: DesignBriefV2;
  catalog: DesignCatalogV2;
  repositoryRoot: string;
  tenantReader: TenantVariantReader;
  temporaryParent?: string;
}): Promise<MaterializedAssetOverlay> {
  const spec = validateSiteSpecV1_1(input.spec);
  const brief = validateDesignBriefV2(input.designBrief);
  const pack = input.catalog.demoVisualPacks.find(
    (candidate) =>
      candidate.id === brief.assetStrategy.demoVisualPackId &&
      candidate.version === brief.assetStrategy.demoVisualPackVersion,
  );
  if (
    brief.assetStrategy.demoVisualPackId &&
    (!pack ||
      pack.status !== 'approved' ||
      demoVisualPackV2Digest(pack) !== brief.assetStrategy.demoVisualPackDigest)
  ) {
    throw new ControlledAssetMaterializationError(
      'CONTROLLED_ASSET_CATALOG_INVALID',
      'DesignBrief pack is unavailable or its digest changed',
    );
  }
  const parent = input.temporaryParent ?? tmpdir();
  const publicDir = await mkdtemp(path.join(parent, 'global-site-assets-'));
  await chmod(publicDir, 0o700);
  const urls: Record<string, string> = {};
  const written = new Set<string>();
  try {
    for (const [referenceId, ref] of Object.entries(spec.assets).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (ref.source === 'tenant') {
        const observed = await input.tenantReader.readReadyVariant({
          workspaceId: input.workspaceId,
          siteId: input.siteId,
          assetId: ref.assetId,
          variantId: ref.variantId,
        });
        assertTenantBytes(ref, observed);
        const logicalUrl = controlledAssetUrl(ref);
        const relative = logicalUrl.slice(1);
        if (!written.has(relative)) {
          await writeImmutable(publicDir, relative, observed.data);
          written.add(relative);
        }
        urls[referenceId] = logicalUrl;
        continue;
      }
      const catalogAsset = pack?.assets.find(
        (candidate) => candidate.id === ref.catalogAssetId,
      );
      if (
        !catalogAsset ||
        catalogAsset.sha256 !== ref.sha256 ||
        catalogAsset.mimeType !== ref.mimeType
      ) {
        throw new ControlledAssetMaterializationError(
          'CONTROLLED_ASSET_CATALOG_INVALID',
          ref.catalogAssetId,
        );
      }
      const data = await readCatalogAsset(
        input.repositoryRoot,
        catalogAsset.repositoryPath,
      );
      if (sha256(data) !== ref.sha256) {
        throw new ControlledAssetMaterializationError(
          'CONTROLLED_ASSET_CATALOG_INVALID',
          `${ref.catalogAssetId} hash mismatch`,
        );
      }
      const logicalUrl = controlledAssetUrl(ref);
      const relative = logicalUrl.slice(1);
      if (!written.has(relative)) {
        await writeImmutable(publicDir, relative, data);
        written.add(relative);
      }
      urls[referenceId] = logicalUrl;
    }
    return {
      publicDir,
      urls,
      cleanup: () => rm(publicDir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(publicDir, { recursive: true, force: true });
    throw error;
  }
}
