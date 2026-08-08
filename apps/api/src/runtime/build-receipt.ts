import { createHash, type Hash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  createVerifiedBuildIdentity,
  hasBuildIdentityEnvironment,
  MIGRATION_MANIFEST_SCHEMA,
  resolveBuildIdentityInput,
  unverifiedBuildIdentity,
  type BuildIdentity,
  type MigrationManifest,
  type MigrationManifestEntry,
  type RuntimeEnvironment,
} from './build-identity';

export const RUNTIME_BUILD_RECEIPT_FILENAME = 'runtime-build-receipt.json';
export const RUNTIME_BUILD_RECEIPT_SCHEMA =
  'global-api-runtime-build-receipt/v2';
export const ARTIFACT_DIGEST_CONTRACT =
  'sha256-global-sorted-relative-path-size-and-file-sha256-v2';

const MIGRATION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_ARTIFACT_FILES = 20_000;
const MAX_ARTIFACT_FILE_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_MIGRATION_LOCK_BYTES = 64 * 1024;
const PRISMA_MIGRATION_LOCK_FILENAME = 'migration_lock.toml';

export interface RuntimeBuildReceipt {
  readonly schemaVersion: typeof RUNTIME_BUILD_RECEIPT_SCHEMA;
  readonly artifactDigestContract: typeof ARTIFACT_DIGEST_CONTRACT;
  readonly buildSha: string;
  readonly buildTime: string;
  readonly artifactDigest: string;
  readonly migrationManifest: MigrationManifest;
}

export interface GenerateRuntimeBuildReceiptInput {
  readonly artifactRoot: string;
  readonly migrationRoot: string;
  readonly receiptPath?: string;
  readonly buildSha: string;
  readonly buildTime: string;
  readonly expectedArtifactDigest?: string;
  readonly expectedMigrationManifestDigest?: string;
}

export interface LoadRuntimeBuildIdentityInput {
  readonly artifactRoot: string;
  readonly receiptPath?: string;
  readonly env: RuntimeEnvironment;
  readonly required: boolean;
  /** Deterministic TOCTOU seam. Production wiring never supplies it. */
  readonly beforeReceiptOpenForTest?: () => void;
  /** Deterministic post-scan receipt replacement seam. Production wiring never supplies it. */
  readonly beforeReceiptFinalizeForTest?: () => void;
  /** Deterministic artifact replacement seam. Production wiring never supplies it. */
  readonly beforeArtifactFileOpenForTest?: (relativePath: string) => void;
}

export interface ArtifactDigestOptions {
  readonly beforeFileOpenForTest?: (relativePath: string) => void;
  readonly beforeRootFinalizeForTest?: () => void;
}

interface ArtifactEntry {
  readonly relativePath: string;
  readonly size: bigint;
  readonly digest: Buffer;
}

function canonicalRelativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join('/');
  if (value === '' || value === '..' || value.startsWith('../')) {
    throw new Error(
      'runtime build receipt path must be inside the artifact root',
    );
  }
  return value;
}

function stableIdentity(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
  ].join(':');
}

function sameObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function openDirectoryNoFollow(path: string): number {
  return openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
}

function assertCanonicalDirectoryRoot(rootInput: string, label: string): {
  readonly root: string;
  readonly descriptor: number;
  readonly identity: BigIntStats;
} {
  const root = resolve(rootInput);
  const pathStat = lstatSync(root, { bigint: true });
  if (pathStat.isSymbolicLink()) {
    throw new Error(`${label} root must not be a symlink`);
  }
  if (!pathStat.isDirectory()) {
    throw new Error(`${label} root must be a directory`);
  }
  if (realpathSync.native(root) !== root) {
    throw new Error(`${label} root must use its canonical real path`);
  }
  const descriptor = openDirectoryNoFollow(root);
  try {
    const descriptorStat = fstatSync(descriptor, { bigint: true });
    if (!descriptorStat.isDirectory() || !sameObject(pathStat, descriptorStat)) {
      throw new Error(`${label} root identity changed during admission`);
    }
    return { root, descriptor, identity: descriptorStat };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function readStableRegularFile(
  anchoredPath: string,
  label: string,
  maxBytes: number,
  beforeOpen?: () => void,
  allowEmpty = false,
): { readonly bytes: Buffer; readonly stat: BigIntStats } {
  const pathBefore = lstatSync(anchoredPath, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink`);
  }
  if (
    (!allowEmpty && pathBefore.size === 0n) ||
    pathBefore.size < 0n ||
    pathBefore.size > BigInt(maxBytes)
  ) {
    throw new Error(`${label} size is invalid`);
  }
  beforeOpen?.();
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      anchoredPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameObject(pathBefore, before)) {
      throw new Error(`${label} identity changed before open`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(anchoredPath, { bigint: true });
    if (
      stableIdentity(before) !== stableIdentity(after) ||
      !sameObject(after, pathAfter) ||
      bytes.byteLength !== Number(after.size)
    ) {
      throw new Error(`${label} changed while being read`);
    }
    return { bytes, stat: after };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function updateFrame(hash: Hash, bytes: Buffer): void {
  hash.update(Buffer.from(`${bytes.byteLength}:`, 'ascii'));
  hash.update(bytes);
}

function digestArtifactEntries(entries: readonly ArtifactEntry[]): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(`${ARTIFACT_DIGEST_CONTRACT}\0`, 'utf8'));
  for (const entry of entries) {
    updateFrame(hash, Buffer.from(entry.relativePath, 'utf8'));
    updateFrame(hash, Buffer.from(entry.size.toString(), 'ascii'));
    updateFrame(hash, entry.digest);
    hash.update(Buffer.from([0]));
  }
  return `sha256:${hash.digest('hex')}`;
}

function collectArtifactEntries(
  rootDescriptor: number,
  excludedRelativePath: string,
  options: ArtifactDigestOptions,
): readonly ArtifactEntry[] {
  const entries: ArtifactEntry[] = [];
  let totalBytes = 0n;

  const visit = (directoryDescriptor: number, prefix: string): void => {
    const directoryBefore = fstatSync(directoryDescriptor, { bigint: true });
    const descriptorPath = `/proc/self/fd/${directoryDescriptor}`;
    const children = readdirSync(descriptorPath, { withFileTypes: true }).sort(
      (left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
    );
    const namesBefore = children.map(({ name }) => name);
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      if (relativePath === excludedRelativePath) continue;
      const anchoredPath = `${descriptorPath}/${child.name}`;
      if (child.isSymbolicLink()) {
        throw new Error('artifact digest refuses symbolic links');
      }
      if (child.isDirectory()) {
        const pathBefore = lstatSync(anchoredPath, { bigint: true });
        const childDescriptor = openDirectoryNoFollow(anchoredPath);
        try {
          const opened = fstatSync(childDescriptor, { bigint: true });
          if (!opened.isDirectory() || !sameObject(pathBefore, opened)) {
            throw new Error('artifact directory identity changed during scan');
          }
          visit(childDescriptor, relativePath);
          const pathAfter = lstatSync(anchoredPath, { bigint: true });
          if (!sameObject(opened, pathAfter)) {
            throw new Error('artifact directory identity changed during scan');
          }
        } finally {
          closeSync(childDescriptor);
        }
        continue;
      }
      if (!child.isFile()) {
        throw new Error(
          'artifact digest accepts only regular files and directories',
        );
      }
      if (entries.length >= MAX_ARTIFACT_FILES) {
        throw new Error('artifact digest file-count limit exceeded');
      }
      const file = readStableRegularFile(
        anchoredPath,
        `artifact file ${relativePath}`,
        MAX_ARTIFACT_FILE_BYTES,
        () => options.beforeFileOpenForTest?.(relativePath),
        true,
      );
      totalBytes += file.stat.size;
      if (totalBytes > BigInt(MAX_ARTIFACT_TOTAL_BYTES)) {
        throw new Error('artifact digest total-byte limit exceeded');
      }
      entries.push(
        Object.freeze({
          relativePath,
          size: file.stat.size,
          digest: createHash('sha256').update(file.bytes).digest(),
        }),
      );
    }
    const namesAfter = readdirSync(descriptorPath).sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    const directoryAfter = fstatSync(directoryDescriptor, { bigint: true });
    if (
      stableIdentity(directoryBefore) !== stableIdentity(directoryAfter) ||
      JSON.stringify(namesBefore) !== JSON.stringify(namesAfter)
    ) {
      throw new Error('artifact directory changed during scan');
    }
  };

  visit(rootDescriptor, '');
  return Object.freeze(
    entries.sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.relativePath, 'utf8'),
        Buffer.from(right.relativePath, 'utf8'),
      ),
    ),
  );
}

export function computeArtifactDigest(
  artifactRoot: string,
  receiptPath = join(artifactRoot, RUNTIME_BUILD_RECEIPT_FILENAME),
  options: ArtifactDigestOptions = {},
): string {
  const openedRoot = assertCanonicalDirectoryRoot(
    artifactRoot,
    'artifact',
  );
  try {
    const excludedRelativePath = canonicalRelativePath(
      openedRoot.root,
      resolve(receiptPath),
    );
    const entries = collectArtifactEntries(
      openedRoot.descriptor,
      excludedRelativePath,
      options,
    );
    options.beforeRootFinalizeForTest?.();
    const rootAfter = fstatSync(openedRoot.descriptor, { bigint: true });
    const pathAfter = lstatSync(openedRoot.root, { bigint: true });
    if (
      stableIdentity(openedRoot.identity) !== stableIdentity(rootAfter) ||
      !sameObject(rootAfter, pathAfter) ||
      realpathSync.native(openedRoot.root) !== openedRoot.root
    ) {
      throw new Error('artifact root identity changed during scan');
    }
    return digestArtifactEntries(entries);
  } finally {
    closeSync(openedRoot.descriptor);
  }
}

function migrationManifestDigest(
  entries: readonly MigrationManifestEntry[],
): string {
  const hash = createHash('sha256');
  hash.update(Buffer.from(`${MIGRATION_MANIFEST_SCHEMA}\0`, 'utf8'));
  for (const entry of entries) {
    updateFrame(hash, Buffer.from(entry.name, 'utf8'));
    updateFrame(hash, Buffer.from(entry.checksum, 'hex'));
    hash.update(Buffer.from([0]));
  }
  return `sha256:${hash.digest('hex')}`;
}

export function buildMigrationManifest(migrationRoot: string): MigrationManifest {
  const openedRoot = assertCanonicalDirectoryRoot(
    migrationRoot,
    'migration',
  );
  try {
    const rootPath = `/proc/self/fd/${openedRoot.descriptor}`;
    const children = readdirSync(rootPath, { withFileTypes: true }).sort(
      (left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
    );
    const namesBefore = children.map(({ name }) => name);
    const migrationDirectories = children.filter((child) => {
      if (child.name !== PRISMA_MIGRATION_LOCK_FILENAME) return true;
      if (child.isSymbolicLink() || !child.isFile()) {
        throw new Error('Prisma migration lock must be a regular file');
      }
      readStableRegularFile(
        `${rootPath}/${child.name}`,
        'Prisma migration lock',
        MAX_MIGRATION_LOCK_BYTES,
      );
      return false;
    });
    if (migrationDirectories.length === 0) {
      throw new Error('migration manifest must contain at least one migration');
    }
    const entries = migrationDirectories.map((child): MigrationManifestEntry => {
      if (
        child.isSymbolicLink() ||
        !child.isDirectory() ||
        !MIGRATION_NAME_PATTERN.test(child.name)
      ) {
        throw new Error('migration root contains an invalid migration directory');
      }
      const directoryPath = `${rootPath}/${child.name}`;
      const directoryBefore = lstatSync(directoryPath, { bigint: true });
      const directoryDescriptor = openDirectoryNoFollow(directoryPath);
      try {
        const directoryOpened = fstatSync(directoryDescriptor, { bigint: true });
        if (
          !directoryOpened.isDirectory() ||
          !sameObject(directoryBefore, directoryOpened)
        ) {
          throw new Error('migration directory identity changed during scan');
        }
        const migration = readStableRegularFile(
          `/proc/self/fd/${directoryDescriptor}/migration.sql`,
          `migration ${child.name}/migration.sql`,
          MAX_ARTIFACT_FILE_BYTES,
        );
        const directoryAfter = fstatSync(directoryDescriptor, { bigint: true });
        const pathAfter = lstatSync(directoryPath, { bigint: true });
        if (
          stableIdentity(directoryOpened) !== stableIdentity(directoryAfter) ||
          !sameObject(directoryAfter, pathAfter)
        ) {
          throw new Error('migration directory changed during scan');
        }
        return Object.freeze({
          name: child.name,
          checksum: createHash('sha256').update(migration.bytes).digest('hex'),
        });
      } finally {
        closeSync(directoryDescriptor);
      }
    });
    const namesAfter = readdirSync(rootPath).sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    const rootAfter = fstatSync(openedRoot.descriptor, { bigint: true });
    const pathAfter = lstatSync(openedRoot.root, { bigint: true });
    if (
      stableIdentity(openedRoot.identity) !== stableIdentity(rootAfter) ||
      !sameObject(rootAfter, pathAfter) ||
      realpathSync.native(openedRoot.root) !== openedRoot.root ||
      JSON.stringify(namesBefore) !== JSON.stringify(namesAfter)
    ) {
      throw new Error('migration root identity changed during scan');
    }
    const frozenEntries = Object.freeze(entries);
    return Object.freeze({
      schemaVersion: MIGRATION_MANIFEST_SCHEMA,
      digest: migrationManifestDigest(frozenEntries),
      entries: frozenEntries,
    });
  } finally {
    closeSync(openedRoot.descriptor);
  }
}

function canonicalReceipt(
  input: GenerateRuntimeBuildReceiptInput,
  artifactDigest: string,
  migrationManifest: MigrationManifest,
): RuntimeBuildReceipt {
  const attestation = resolveBuildIdentityInput({
    BUILD_SHA: input.buildSha,
    BUILD_TIME: input.buildTime,
    ARTIFACT_DIGEST: artifactDigest,
    MIGRATION_MANIFEST_DIGEST: migrationManifest.digest,
  });
  if (attestation.status !== 'VERIFIED') {
    throw new Error(
      `build receipt identity is incomplete: ${attestation.missingFields.join(', ')}`,
    );
  }
  return Object.freeze({
    schemaVersion: RUNTIME_BUILD_RECEIPT_SCHEMA,
    artifactDigestContract: ARTIFACT_DIGEST_CONTRACT,
    buildSha: attestation.buildSha,
    buildTime: attestation.buildTime,
    artifactDigest: attestation.artifactDigest,
    migrationManifest,
  });
}

export async function generateRuntimeBuildReceipt(
  input: GenerateRuntimeBuildReceiptInput,
): Promise<RuntimeBuildReceipt> {
  const artifactRoot = resolve(input.artifactRoot);
  const receiptPath = resolve(
    input.receiptPath ?? join(artifactRoot, RUNTIME_BUILD_RECEIPT_FILENAME),
  );
  canonicalRelativePath(artifactRoot, receiptPath);
  const migrationManifest = buildMigrationManifest(input.migrationRoot);
  if (
    input.expectedMigrationManifestDigest !== undefined &&
    input.expectedMigrationManifestDigest !== migrationManifest.digest
  ) {
    throw new Error(
      'MIGRATION_MANIFEST_DIGEST does not match the source migration tree',
    );
  }
  const artifactDigest = computeArtifactDigest(artifactRoot, receiptPath);
  if (
    input.expectedArtifactDigest !== undefined &&
    input.expectedArtifactDigest !== artifactDigest
  ) {
    throw new Error(
      'ARTIFACT_DIGEST does not match the deterministic artifact tree',
    );
  }
  const receipt = canonicalReceipt(
    input,
    artifactDigest,
    migrationManifest,
  );
  const temporaryPath = join(
    dirname(receiptPath),
    `.${basename(receiptPath)}.${process.pid}.${Date.now()}.tmp`,
  );

  mkdirSync(dirname(receiptPath), { recursive: true });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o444);
    renameSync(temporaryPath, receiptPath);
    const directoryDescriptor = openDirectoryNoFollow(dirname(receiptPath));
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
  return receipt;
}

function parseMigrationManifest(value: unknown): MigrationManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('runtime build receipt migration manifest is invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(record).sort()) !==
      JSON.stringify(['digest', 'entries', 'schemaVersion']) ||
    record.schemaVersion !== MIGRATION_MANIFEST_SCHEMA ||
    typeof record.digest !== 'string' ||
    !SHA256_DIGEST_PATTERN.test(record.digest) ||
    !Array.isArray(record.entries) ||
    record.entries.length === 0
  ) {
    throw new Error('runtime build receipt migration manifest is invalid');
  }
  const entries = record.entries.map((entry): MigrationManifestEntry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('runtime build receipt migration entry is invalid');
    }
    const item = entry as Record<string, unknown>;
    if (
      JSON.stringify(Object.keys(item).sort()) !==
        JSON.stringify(['checksum', 'name']) ||
      typeof item.name !== 'string' ||
      !MIGRATION_NAME_PATTERN.test(item.name) ||
      typeof item.checksum !== 'string' ||
      !CHECKSUM_PATTERN.test(item.checksum)
    ) {
      throw new Error('runtime build receipt migration entry is invalid');
    }
    return Object.freeze({ name: item.name, checksum: item.checksum });
  });
  const names = entries.map(({ name }) => name);
  const sortedNames = [...names].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  if (
    new Set(names).size !== names.length ||
    JSON.stringify(names) !== JSON.stringify(sortedNames)
  ) {
    throw new Error(
      'runtime build receipt migration manifest must be uniquely ordered',
    );
  }
  const frozenEntries = Object.freeze(entries);
  if (migrationManifestDigest(frozenEntries) !== record.digest) {
    throw new Error('runtime build receipt migration manifest digest mismatch');
  }
  return Object.freeze({
    schemaVersion: MIGRATION_MANIFEST_SCHEMA,
    digest: record.digest,
    entries: frozenEntries,
  });
}

function parseReceiptBytes(bytes: Buffer): RuntimeBuildReceipt {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('runtime build receipt is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('runtime build receipt must be an object');
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    'artifactDigest',
    'artifactDigestContract',
    'buildSha',
    'buildTime',
    'migrationManifest',
    'schemaVersion',
  ];
  if (
    JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expectedKeys)
  ) {
    throw new Error('runtime build receipt fields are invalid');
  }
  if (
    record.schemaVersion !== RUNTIME_BUILD_RECEIPT_SCHEMA ||
    record.artifactDigestContract !== ARTIFACT_DIGEST_CONTRACT
  ) {
    throw new Error('runtime build receipt contract is unsupported');
  }
  if (
    typeof record.buildSha !== 'string' ||
    typeof record.buildTime !== 'string' ||
    typeof record.artifactDigest !== 'string'
  ) {
    throw new Error('runtime build receipt identity fields must be strings');
  }
  return Object.freeze({
    schemaVersion: RUNTIME_BUILD_RECEIPT_SCHEMA,
    artifactDigestContract: ARTIFACT_DIGEST_CONTRACT,
    buildSha: record.buildSha,
    buildTime: record.buildTime,
    artifactDigest: record.artifactDigest,
    migrationManifest: parseMigrationManifest(record.migrationManifest),
  });
}

function readReceipt(
  receiptPath: string,
  beforeOpen?: () => void,
): { readonly value: RuntimeBuildReceipt; readonly stat: BigIntStats } {
  if (realpathSync.native(receiptPath) !== receiptPath) {
    throw new Error(
      'runtime build receipt must use its canonical real path without symlinks',
    );
  }
  const receipt = readStableRegularFile(
    receiptPath,
    'runtime build receipt',
    MAX_RECEIPT_BYTES,
    beforeOpen,
  );
  if ((receipt.stat.mode & 0o222n) !== 0n) {
    throw new Error('runtime build receipt must be read-only');
  }
  return Object.freeze({
    value: parseReceiptBytes(receipt.bytes),
    stat: receipt.stat,
  });
}

export function loadRuntimeBuildIdentity(
  input: LoadRuntimeBuildIdentityInput,
): BuildIdentity {
  const artifactRoot = resolve(input.artifactRoot);
  const receiptPath = resolve(
    input.receiptPath ?? join(artifactRoot, RUNTIME_BUILD_RECEIPT_FILENAME),
  );
  canonicalRelativePath(artifactRoot, receiptPath);
  if (!existsSync(receiptPath)) {
    if (input.required || hasBuildIdentityEnvironment(input.env)) {
      throw new Error(
        'runtime build receipt is required; env-only build identity is not admitted',
      );
    }
    return unverifiedBuildIdentity();
  }

  const receiptRead = readReceipt(
    receiptPath,
    input.beforeReceiptOpenForTest,
  );
  const receipt = receiptRead.value;
  const attestation = resolveBuildIdentityInput({
    BUILD_SHA: receipt.buildSha,
    BUILD_TIME: receipt.buildTime,
    ARTIFACT_DIGEST: receipt.artifactDigest,
    MIGRATION_MANIFEST_DIGEST: receipt.migrationManifest.digest,
  });
  if (attestation.status !== 'VERIFIED') {
    throw new Error('runtime build receipt identity is incomplete');
  }
  const identity = createVerifiedBuildIdentity(
    attestation,
    receipt.migrationManifest,
  );
  const observedDigest = computeArtifactDigest(artifactRoot, receiptPath, {
    beforeFileOpenForTest: input.beforeArtifactFileOpenForTest,
  });
  if (observedDigest !== identity.artifactDigest) {
    throw new Error('ARTIFACT_DIGEST does not match the runtime artifact tree');
  }
  input.beforeReceiptFinalizeForTest?.();
  const receiptAfter = lstatSync(receiptPath, { bigint: true });
  if (
    receiptAfter.isSymbolicLink() ||
    !receiptAfter.isFile() ||
    stableIdentity(receiptRead.stat) !== stableIdentity(receiptAfter) ||
    realpathSync.native(receiptPath) !== receiptPath
  ) {
    throw new Error('runtime build receipt changed during admission');
  }

  if (hasBuildIdentityEnvironment(input.env)) {
    const envAttestation = resolveBuildIdentityInput(input.env);
    if (envAttestation.status !== 'VERIFIED') {
      throw new Error(
        'runtime build identity env must be a complete receipt attestation',
      );
    }
    const comparisons = [
      ['BUILD_SHA', envAttestation.buildSha, identity.buildSha],
      ['BUILD_TIME', envAttestation.buildTime, identity.buildTime],
      ['ARTIFACT_DIGEST', envAttestation.artifactDigest, identity.artifactDigest],
      [
        'MIGRATION_MANIFEST_DIGEST',
        envAttestation.migrationManifestDigest,
        identity.migrationManifestDigest,
      ],
    ] as const;
    const mismatch = comparisons.find(
      ([, actual, expected]) => actual !== expected,
    );
    if (mismatch) {
      throw new Error(
        `runtime build identity attestation mismatch for ${mismatch[0]}`,
      );
    }
  }

  return identity;
}
