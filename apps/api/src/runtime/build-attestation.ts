import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import { open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { RuntimeMode } from './runtime-environment';

export const BUILD_ATTESTATION_SCHEMA = 'global-runtime-build-attestation/v1' as const;
const MAX_ATTESTATION_BYTES = 16 * 1024;
const MAX_ARTIFACT_FILE_BYTES = 64 * 1024 * 1024;
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

async function readBoundedRegularFile(path: string, maximumBytes: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('build attestation rejected by O_NOFOLLOW: final-component symlink', {
        cause: error,
      });
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('build attestation must be a regular file');
    if (before.size > BigInt(maximumBytes)) throw new Error('build attestation exceeds the byte limit');
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
      throw new Error('build attestation changed while it was being read');
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function collectArtifactFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(directory, entry.name);
    const artifactPath = relative(root, absolute).split(sep).join('/');
    if (artifactPath === RECEIPT_FILENAME) continue;
    if (entry.isSymbolicLink()) throw new Error(`artifact tree contains a symlink: ${artifactPath}`);
    if (entry.isDirectory()) {
      paths.push(...(await collectArtifactFiles(root, absolute)));
      continue;
    }
    if (!entry.isFile()) throw new Error(`artifact tree contains a non-regular file: ${artifactPath}`);
    paths.push(artifactPath);
  }
  return paths;
}

export async function computeArtifactDigest(root: string): Promise<string> {
  const digest = createHash('sha256');
  for (const artifactPath of (await collectArtifactFiles(root)).sort()) {
    const contents = await readBoundedRegularFile(
      join(root, artifactPath),
      MAX_ARTIFACT_FILE_BYTES,
    );
    digest.update(`${Buffer.byteLength(artifactPath)}:${artifactPath}:${contents.length}:`);
    digest.update(contents);
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
}

export async function loadBuildIdentity(input: {
  mode: RuntimeMode;
  path: string;
}): Promise<BuildIdentity> {
  let contents: Buffer;
  try {
    contents = await readBoundedRegularFile(input.path, MAX_ATTESTATION_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (input.mode === 'development' || input.mode === 'test') {
        return Object.freeze({ attested: false, schema_version: BUILD_ATTESTATION_SCHEMA });
      }
      throw new Error(`build attestation is required in ${input.mode}`, { cause: error });
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
  const actualDigest = await computeArtifactDigest(dirname(input.path));
  if (actualDigest !== attestation.artifact_digest) {
    throw new Error('build attestation artifact digest mismatch');
  }
  return Object.freeze({ attested: true, ...attestation });
}

function sha256(contents: Buffer | string): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

export async function generateBuildAttestation(input: {
  distRoot: string;
  buildSha: string;
  builtAt: string;
  schemaPath: string;
  migrationsRoot: string;
}): Promise<BuildAttestation> {
  const migrationEntries = await readdir(input.migrationsRoot, { withFileTypes: true });
  const migrationRevision = migrationEntries
    .filter((entry) => entry.isDirectory() && MIGRATION_REVISION_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .at(-1);
  if (!migrationRevision) throw new Error('build attestation migration_revision is unavailable');
  const candidate = parseBuildAttestation({
    schema_version: BUILD_ATTESTATION_SCHEMA,
    build_sha: input.buildSha,
    built_at: input.builtAt,
    artifact_digest: await computeArtifactDigest(input.distRoot),
    migration_revision: migrationRevision,
    schema_digest: sha256(await readFile(input.schemaPath)),
  });
  const outputPath = join(input.distRoot, RECEIPT_FILENAME);
  const temporaryPath = join(input.distRoot, `.build-attestation.tmp-${randomUUID()}`);
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
}
