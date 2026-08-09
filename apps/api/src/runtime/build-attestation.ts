import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import {
  open,
  readdir,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RuntimeMode } from './runtime-environment';

export const BUILD_ATTESTATION_SCHEMA = 'global-runtime-build-attestation/v1' as const;
const MAX_ATTESTATION_BYTES = 16 * 1024;
const MAX_SCHEMA_BYTES = 16 * 1024 * 1024;
const MAX_ARTIFACT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_ARTIFACT_ENTRIES = 20_000;
const MAX_ARTIFACT_DEPTH = 64;
const RECEIPT_FILENAME = 'build-attestation.json';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BUILD_SHA_PATTERN = /^[0-9a-f]{40}$/;
const MIGRATION_REVISION_PATTERN = /^\d{14}_[a-z0-9_]+$/;

export interface BuildAttestation {
  schema_version: typeof BUILD_ATTESTATION_SCHEMA;
  build_sha: string;
  built_at: string;
  artifact_digest: string;
  migration_revision: string;
  schema_digest: string;
}

export type BuildIdentity =
  | ({ attested: true } & BuildAttestation)
  | { attested: false; schema_version: typeof BUILD_ATTESTATION_SCHEMA };

export class BuildIdentityService {
  constructor(private readonly identity: BuildIdentity) {}

  current(): BuildIdentity {
    return this.identity;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`build attestation ${key} must be a string`);
  return value;
}

export function parseBuildAttestation(value: unknown): BuildAttestation {
  if (!isRecord(value)) throw new Error('build attestation must be a JSON object');
  const expectedKeys = [
    'schema_version',
    'build_sha',
    'built_at',
    'artifact_digest',
    'migration_revision',
    'schema_digest',
  ];
  const unexpected = Object.keys(value).filter((key) => !expectedKeys.includes(key));
  const missing = expectedKeys.filter((key) => !(key in value));
  if (unexpected.length) throw new Error(`build attestation contains unexpected keys: ${unexpected.join(', ')}`);
  if (missing.length) throw new Error(`build attestation is missing keys: ${missing.join(', ')}`);

  const schemaVersion = requireString(value, 'schema_version');
  const buildSha = requireString(value, 'build_sha');
  const builtAt = requireString(value, 'built_at');
  const artifactDigest = requireString(value, 'artifact_digest');
  const migrationRevision = requireString(value, 'migration_revision');
  const schemaDigest = requireString(value, 'schema_digest');
  if (schemaVersion !== BUILD_ATTESTATION_SCHEMA) throw new Error('build attestation schema_version is unsupported');
  if (!BUILD_SHA_PATTERN.test(buildSha)) throw new Error('build attestation build_sha must be 40 lowercase hex');
  if (!SHA256_PATTERN.test(artifactDigest)) throw new Error('build attestation artifact_digest must be sha256 lowercase hex');
  if (!SHA256_PATTERN.test(schemaDigest)) throw new Error('build attestation schema_digest must be sha256 lowercase hex');
  if (!MIGRATION_REVISION_PATTERN.test(migrationRevision)) throw new Error('build attestation migration_revision is invalid');
  const parsedTimestamp = new Date(builtAt);
  if (!Number.isFinite(parsedTimestamp.getTime()) || parsedTimestamp.toISOString() !== builtAt) {
    throw new Error('build attestation built_at must be canonical RFC3339 UTC');
  }
  return Object.freeze({
    schema_version: BUILD_ATTESTATION_SCHEMA,
    build_sha: buildSha,
    built_at: builtAt,
    artifact_digest: artifactDigest,
    migration_revision: migrationRevision,
    schema_digest: schemaDigest,
  });
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function noFollowMessage(label: string): string {
  return `${label} rejected by O_NOFOLLOW: symlinks are forbidden`;
}

async function openNoFollow(
  path: string,
  flags: number,
  label: string,
): Promise<FileHandle> {
  try {
    return await open(path, flags | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(noFollowMessage(label), { cause: error });
    }
    throw error;
  }
}

async function readBoundedRegularHandle(
  handle: FileHandle,
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) throw new Error(`${label} must be a regular file`);
  if (before.size > BigInt(maximumBytes)) {
    throw new Error(`${label} exceeds the byte limit`);
  }
  const expectedSize = Number(before.size);
  const buffer = Buffer.alloc(expectedSize + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (!sameFile(before, after) || offset !== expectedSize) {
    throw new Error(`${label} changed while it was being read`);
  }
  return buffer.subarray(0, offset);
}

async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  const handle = await openNoFollow(path, fsConstants.O_RDONLY, label);
  try {
    return await readBoundedRegularHandle(handle, maximumBytes, label);
  } finally {
    await handle.close();
  }
}

interface ArtifactFile {
  path: string;
  contents: Buffer;
}

interface ArtifactInventory {
  entries: number;
  totalBytes: number;
  files: ArtifactFile[];
}

function descriptorPath(handle: FileHandle, name?: string): string {
  const root = `/proc/self/fd/${handle.fd}`;
  return name === undefined ? root : `${root}/${name}`;
}

async function openStableDirectory(path: string, label: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await openNoFollow(
      path,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
      label,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new Error(`${label} rejected: symlink or non-directory`, { cause: error });
    }
    throw error;
  }
  const stat = await handle.stat({ bigint: true });
  if (!stat.isDirectory()) {
    await handle.close();
    throw new Error(`${label} must be a directory`);
  }
  return handle;
}

async function collectArtifactFiles(
  directory: FileHandle,
  prefix: string,
  depth: number,
  inventory: ArtifactInventory,
): Promise<void> {
  if (depth > MAX_ARTIFACT_DEPTH) {
    throw new Error('artifact tree exceeds the directory depth limit');
  }
  const before = await directory.stat({ bigint: true });
  if (!before.isDirectory()) throw new Error('artifact tree contains a non-directory ancestor');
  const entries = await readdir(descriptorPath(directory), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const artifactPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (artifactPath === RECEIPT_FILENAME) continue;
    inventory.entries += 1;
    if (inventory.entries > MAX_ARTIFACT_ENTRIES) {
      throw new Error('artifact tree exceeds the entry count limit');
    }
    const child = await openNoFollow(
      descriptorPath(directory, entry.name),
      fsConstants.O_RDONLY,
      `artifact tree entry ${artifactPath}`,
    );
    try {
      const childStat = await child.stat({ bigint: true });
      if (childStat.isDirectory()) {
        await collectArtifactFiles(child, artifactPath, depth + 1, inventory);
        continue;
      }
      if (!childStat.isFile()) {
        throw new Error(`artifact tree contains a non-regular file: ${artifactPath}`);
      }
      if (childStat.size > BigInt(MAX_ARTIFACT_FILE_BYTES)) {
        throw new Error(`artifact tree entry ${artifactPath} exceeds the byte limit`);
      }
      inventory.totalBytes += Number(childStat.size);
      if (inventory.totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
        throw new Error('artifact tree exceeds the total byte limit');
      }
      inventory.files.push({
        path: artifactPath,
        contents: await readBoundedRegularHandle(
          child,
          MAX_ARTIFACT_FILE_BYTES,
          `artifact tree entry ${artifactPath}`,
        ),
      });
    } finally {
      await child.close();
    }
  }
  const after = await directory.stat({ bigint: true });
  if (!sameFile(before, after)) {
    throw new Error('artifact tree directory changed while it was being enumerated');
  }
}

async function computeArtifactDigestFromDirectory(
  directory: FileHandle,
): Promise<string> {
  const inventory: ArtifactInventory = { entries: 0, totalBytes: 0, files: [] };
  await collectArtifactFiles(directory, '', 0, inventory);
  const digest = createHash('sha256');
  for (const artifact of inventory.files.sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    digest.update(
      `${Buffer.byteLength(artifact.path)}:${artifact.path}:${artifact.contents.length}:`,
    );
    digest.update(artifact.contents);
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
}

export async function computeArtifactDigest(root: string): Promise<string> {
  const directory = await openStableDirectory(root, 'artifact tree root');
  try {
    return await computeArtifactDigestFromDirectory(directory);
  } finally {
    await directory.close();
  }
}

export async function loadBuildIdentity(input: {
  mode: RuntimeMode;
  path: string;
  artifactRoot: string;
}): Promise<BuildIdentity> {
  const receiptPath = resolve(input.path);
  const artifactRoot = resolve(input.artifactRoot);
  if (receiptPath !== resolve(artifactRoot, RECEIPT_FILENAME)) {
    throw new Error('build attestation receipt path does not match the executable artifact root');
  }
  const artifactDirectory = await openStableDirectory(
    artifactRoot,
    'executable artifact root',
  );
  try {
    let contents: Buffer;
    try {
      contents = await readBoundedRegularFile(
        descriptorPath(artifactDirectory, RECEIPT_FILENAME),
        MAX_ATTESTATION_BYTES,
        'build attestation',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (input.mode === 'development' || input.mode === 'test') {
          return Object.freeze({
            attested: false,
            schema_version: BUILD_ATTESTATION_SCHEMA,
          });
        }
        throw new Error(`build attestation is required in ${input.mode}`, {
          cause: error,
        });
      }
      throw error;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(contents.toString('utf8')) as unknown;
    } catch {
      throw new Error('build attestation JSON is malformed');
    }
    const attestation = parseBuildAttestation(decoded);
    const actualDigest = await computeArtifactDigestFromDirectory(artifactDirectory);
    if (actualDigest !== attestation.artifact_digest) {
      throw new Error('build attestation artifact digest mismatch');
    }
    return Object.freeze({ attested: true, ...attestation });
  } finally {
    await artifactDirectory.close();
  }
}

function sha256(contents: Buffer | string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

async function latestMigrationRevision(root: string): Promise<string> {
  const directory = await openStableDirectory(root, 'migration inventory root');
  try {
    const before = await directory.stat({ bigint: true });
    const entries = await readdir(descriptorPath(directory), { withFileTypes: true });
    const revisions: string[] = [];
    for (const entry of entries) {
      if (!MIGRATION_REVISION_PATTERN.test(entry.name)) continue;
      const child = await openNoFollow(
        descriptorPath(directory, entry.name),
        fsConstants.O_RDONLY,
        `migration revision ${entry.name}`,
      );
      try {
        if (!(await child.stat({ bigint: true })).isDirectory()) {
          throw new Error(`migration revision ${entry.name} must be a directory`);
        }
        revisions.push(entry.name);
      } finally {
        await child.close();
      }
    }
    const after = await directory.stat({ bigint: true });
    if (!sameFile(before, after)) {
      throw new Error('migration inventory changed while it was being enumerated');
    }
    const latest = revisions.sort().at(-1);
    if (!latest) throw new Error('build attestation migration_revision is unavailable');
    return latest;
  } finally {
    await directory.close();
  }
}

export async function generateBuildAttestation(input: {
  distRoot: string;
  buildSha: string;
  builtAt: string;
  schemaPath: string;
  migrationsRoot: string;
}): Promise<BuildAttestation> {
  const migrationRevision = await latestMigrationRevision(input.migrationsRoot);
  const schemaContents = await readBoundedRegularFile(
    input.schemaPath,
    MAX_SCHEMA_BYTES,
    'Prisma schema provenance input',
  );
  const distDirectory = await openStableDirectory(input.distRoot, 'artifact tree root');
  try {
    const candidate = parseBuildAttestation({
      schema_version: BUILD_ATTESTATION_SCHEMA,
      build_sha: input.buildSha,
      built_at: input.builtAt,
      artifact_digest: await computeArtifactDigestFromDirectory(distDirectory),
      migration_revision: migrationRevision,
      schema_digest: sha256(schemaContents),
    });
    const temporaryName = `.build-attestation.tmp-${randomUUID()}`;
    const temporaryPath = descriptorPath(distDirectory, temporaryName);
    const outputPath = descriptorPath(distDirectory, RECEIPT_FILENAME);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(candidate, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o644,
      });
      await rename(temporaryPath, outputPath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return candidate;
  } finally {
    await distDirectory.close();
  }
}
