import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  hasBuildIdentityEnvironment,
  resolveBuildIdentityInput,
  unverifiedBuildIdentity,
  type BuildIdentity,
  type RuntimeEnvironment,
  type VerifiedBuildIdentity,
} from './build-identity';

export const RUNTIME_BUILD_RECEIPT_FILENAME = 'runtime-build-receipt.json';
export const RUNTIME_BUILD_RECEIPT_SCHEMA =
  'global-api-runtime-build-receipt/v1';
export const ARTIFACT_DIGEST_CONTRACT =
  'sha256-sorted-relative-path-and-bytes-v1';

export interface RuntimeBuildReceipt {
  readonly schemaVersion: typeof RUNTIME_BUILD_RECEIPT_SCHEMA;
  readonly artifactDigestContract: typeof ARTIFACT_DIGEST_CONTRACT;
  readonly buildSha: string;
  readonly buildTime: string;
  readonly artifactDigest: string;
  readonly migrationRevision: string;
}

export interface GenerateRuntimeBuildReceiptInput {
  readonly artifactRoot: string;
  readonly receiptPath?: string;
  readonly buildSha: string;
  readonly buildTime: string;
  readonly migrationRevision: string;
  readonly expectedArtifactDigest?: string;
}

export interface LoadRuntimeBuildIdentityInput {
  readonly artifactRoot: string;
  readonly receiptPath?: string;
  readonly env: RuntimeEnvironment;
  readonly required: boolean;
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

function regularArtifactFiles(
  root: string,
  receiptPath: string,
): readonly string[] {
  const receipt = resolve(receiptPath);
  const files: string[] = [];
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (resolve(path) === receipt) continue;
      if (entry.isSymbolicLink()) {
        throw new Error('artifact digest refuses symbolic links');
      }
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          'artifact digest accepts only regular files and directories',
        );
      }
      files.push(path);
    }
  };
  visit(root);
  return Object.freeze(files);
}

export function computeArtifactDigest(
  artifactRoot: string,
  receiptPath = join(artifactRoot, RUNTIME_BUILD_RECEIPT_FILENAME),
): string {
  const root = resolve(artifactRoot);
  const rootStat = statSync(root);
  if (!rootStat.isDirectory())
    throw new Error('artifact root must be a directory');
  canonicalRelativePath(root, resolve(receiptPath));

  const hash = createHash('sha256');
  for (const path of regularArtifactFiles(root, receiptPath)) {
    const relativePath = canonicalRelativePath(root, path);
    const pathBytes = Buffer.from(relativePath, 'utf8');
    const contents = readFileSync(path);
    hash.update(Buffer.from(`${pathBytes.byteLength}:`, 'ascii'));
    hash.update(pathBytes);
    hash.update(Buffer.from(`\0${contents.byteLength}:`, 'ascii'));
    hash.update(contents);
    hash.update(Buffer.from('\0', 'ascii'));
  }
  return `sha256:${hash.digest('hex')}`;
}

function canonicalReceipt(
  identity: VerifiedBuildIdentity,
): RuntimeBuildReceipt {
  return Object.freeze({
    schemaVersion: RUNTIME_BUILD_RECEIPT_SCHEMA,
    artifactDigestContract: ARTIFACT_DIGEST_CONTRACT,
    buildSha: identity.buildSha,
    buildTime: identity.buildTime,
    artifactDigest: identity.artifactDigest,
    migrationRevision: identity.migrationRevision,
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
  const artifactDigest = computeArtifactDigest(artifactRoot, receiptPath);
  if (
    input.expectedArtifactDigest !== undefined &&
    input.expectedArtifactDigest !== artifactDigest
  ) {
    throw new Error(
      'ARTIFACT_DIGEST does not match the deterministic artifact tree',
    );
  }
  const identity = resolveBuildIdentityInput({
    BUILD_SHA: input.buildSha,
    BUILD_TIME: input.buildTime,
    ARTIFACT_DIGEST: artifactDigest,
    MIGRATION_REVISION: input.migrationRevision,
  });
  if (identity.status !== 'VERIFIED') {
    throw new Error(
      `build receipt identity is incomplete: ${identity.missingFields.join(', ')}`,
    );
  }
  const receipt = canonicalReceipt(identity);
  const temporaryPath = join(
    dirname(receiptPath),
    `.${basename(receiptPath)}.${process.pid}.${Date.now()}.tmp`,
  );

  mkdirSync(dirname(receiptPath), { recursive: true });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o444);
    renameSync(temporaryPath, receiptPath);
    const directoryDescriptor = openSync(dirname(receiptPath), 'r');
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

function parseReceipt(receiptPath: string): RuntimeBuildReceipt {
  const receiptStat = lstatSync(receiptPath);
  if (receiptStat.isSymbolicLink() || !receiptStat.isFile()) {
    throw new Error(
      'runtime build receipt must be a regular file, not a symlink',
    );
  }
  if ((receiptStat.mode & 0o222) !== 0) {
    throw new Error('runtime build receipt must be read-only');
  }
  if (receiptStat.size <= 0 || receiptStat.size > 16_384) {
    throw new Error('runtime build receipt size is invalid');
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(receiptPath, 'utf8'));
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
    'migrationRevision',
    'schemaVersion',
  ];
  const actualKeys = Object.keys(record).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
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
    typeof record.artifactDigest !== 'string' ||
    typeof record.migrationRevision !== 'string'
  ) {
    throw new Error('runtime build receipt identity fields must be strings');
  }
  return record as unknown as RuntimeBuildReceipt;
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

  const receipt = parseReceipt(receiptPath);
  const identity = resolveBuildIdentityInput({
    BUILD_SHA: receipt.buildSha,
    BUILD_TIME: receipt.buildTime,
    ARTIFACT_DIGEST: receipt.artifactDigest,
    MIGRATION_REVISION: receipt.migrationRevision,
  });
  if (identity.status !== 'VERIFIED') {
    throw new Error('runtime build receipt identity is incomplete');
  }
  const observedDigest = computeArtifactDigest(artifactRoot, receiptPath);
  if (observedDigest !== identity.artifactDigest) {
    throw new Error('ARTIFACT_DIGEST does not match the runtime artifact tree');
  }

  if (hasBuildIdentityEnvironment(input.env)) {
    const attestation = resolveBuildIdentityInput(input.env);
    if (attestation.status !== 'VERIFIED') {
      throw new Error(
        'runtime build identity env must be a complete receipt attestation',
      );
    }
    const comparisons = [
      ['BUILD_SHA', attestation.buildSha, identity.buildSha],
      ['BUILD_TIME', attestation.buildTime, identity.buildTime],
      ['ARTIFACT_DIGEST', attestation.artifactDigest, identity.artifactDigest],
      [
        'MIGRATION_REVISION',
        attestation.migrationRevision,
        identity.migrationRevision,
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
