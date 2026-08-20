import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, opendir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = "site-builder-quality-candidate-artifact/v1" as const;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_OBJECT_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/;
const MAX_FILES = 4096;
const MAX_ENTRIES = 8192;
const MAX_DEPTH = 32;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export interface QualityCandidateArtifactStorage {
  putBufferImmutable(
    key: string,
    data: Buffer,
    contentType: string,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<"created" | "exists">;
  getBufferBounded(
    key: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Buffer>;
  hashObject(
    key: string,
    signal?: AbortSignal,
  ): Promise<{ sha256: string; size: number }>;
}

interface CandidateArtifactFile {
  path: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
}

interface CandidateArtifactManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  rendererOutputDigest: string;
  fileCount: number;
  totalBytes: number;
  files: CandidateArtifactFile[];
}

export interface QualityCandidateArtifactRef {
  schemaVersion: typeof SCHEMA_VERSION;
  manifestKey: string;
  manifestSha256: string;
  rendererOutputDigest: string;
  fileCount: number;
  totalBytes: number;
}

function invalid(): never {
  throw new Error("QUALITY_CANDIDATE_ARTIFACT_INVALID");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeObjectKey(value: string): string {
  if (
    !SAFE_OBJECT_PREFIX.test(value) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    invalid();
  }
  return value;
}

function assertSafeRelativePath(value: string): string {
  if (
    !value ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    invalid();
  }
  return value;
}

async function collectFiles(root: string): Promise<Array<{ path: string; bytes: Buffer }>> {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  let entriesSeen = 0;
  let totalBytes = 0;

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) invalid();
    const entries = await opendir(directory);
    for await (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_ENTRIES) invalid();
      const absolute = path.join(directory, entry.name);
      const relative = assertSafeRelativePath(
        path.relative(root, absolute).split(path.sep).join("/"),
      );
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) invalid();
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1);
        continue;
      }
      const handle = await open(absolute, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) invalid();
        const bytes = await handle.readFile();
        if (bytes.length !== stat.size) invalid();
        totalBytes += bytes.length;
        if (totalBytes > MAX_TOTAL_BYTES) invalid();
        files.push(Object.freeze({ path: relative, bytes }));
        if (files.length > MAX_FILES) invalid();
      } finally {
        await handle.close();
      }
    }
  };

  await visit(root, 0);
  if (files.length === 0) invalid();
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function validateManifest(value: unknown): CandidateArtifactManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const candidate = value as Partial<CandidateArtifactManifest>;
  if (
    candidate.schemaVersion !== SCHEMA_VERSION ||
    typeof candidate.rendererOutputDigest !== "string" ||
    !SHA256.test(candidate.rendererOutputDigest) ||
    !Number.isSafeInteger(candidate.fileCount) ||
    candidate.fileCount! <= 0 ||
    candidate.fileCount! > MAX_FILES ||
    !Number.isSafeInteger(candidate.totalBytes) ||
    candidate.totalBytes! < 0 ||
    candidate.totalBytes! > MAX_TOTAL_BYTES ||
    !Array.isArray(candidate.files) ||
    candidate.files.length !== candidate.fileCount
  ) {
    invalid();
  }
  let totalBytes = 0;
  let previousPath = "";
  const files = candidate.files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) invalid();
    const item = file as Partial<CandidateArtifactFile>;
    const sizeBytes = item.sizeBytes;
    if (
      typeof item.path !== "string" ||
      assertSafeRelativePath(item.path) !== item.path ||
      item.path <= previousPath ||
      typeof item.objectKey !== "string" ||
      assertSafeObjectKey(item.objectKey) !== item.objectKey ||
      typeof item.sha256 !== "string" ||
      !SHA256.test(item.sha256) ||
      typeof sizeBytes !== "number" ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 0 ||
      sizeBytes > MAX_FILE_BYTES
    ) {
      invalid();
    }
    previousPath = item.path;
    totalBytes += sizeBytes;
    return Object.freeze({
      path: item.path,
      objectKey: item.objectKey,
      sha256: item.sha256,
      sizeBytes,
    });
  });
  if (totalBytes !== candidate.totalBytes) invalid();
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    rendererOutputDigest: candidate.rendererOutputDigest,
    fileCount: candidate.fileCount,
    totalBytes: candidate.totalBytes,
    files,
  });
}

async function putAndVerify(
  storage: QualityCandidateArtifactStorage,
  key: string,
  bytes: Buffer,
  digest: string,
  contentType: string,
  signal?: AbortSignal,
): Promise<void> {
  await storage.putBufferImmutable(key, bytes, contentType, digest, signal);
  const observed = await storage.hashObject(key, signal);
  if (observed.sha256 !== digest || observed.size !== bytes.length) invalid();
}

export async function persistQualityCandidateArtifact(input: {
  root: string;
  objectPrefix: string;
  rendererOutputDigest: string;
  storage: QualityCandidateArtifactStorage;
  signal?: AbortSignal;
}): Promise<QualityCandidateArtifactRef> {
  const objectPrefix = assertSafeObjectKey(input.objectPrefix);
  if (!SHA256.test(input.rendererOutputDigest)) invalid();
  const files = await collectFiles(input.root);
  const manifestFiles: CandidateArtifactFile[] = [];
  for (const file of files) {
    const digest = sha256(file.bytes);
    const objectKey = `${objectPrefix}/files/${digest}`;
    await putAndVerify(
      input.storage,
      objectKey,
      file.bytes,
      digest,
      "application/octet-stream",
      input.signal,
    );
    manifestFiles.push(
      Object.freeze({
        path: file.path,
        objectKey,
        sha256: digest,
        sizeBytes: file.bytes.length,
      }),
    );
  }
  const manifest = validateManifest({
    schemaVersion: SCHEMA_VERSION,
    rendererOutputDigest: input.rendererOutputDigest,
    fileCount: manifestFiles.length,
    totalBytes: manifestFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
    files: manifestFiles,
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (manifestBytes.length > MAX_MANIFEST_BYTES) invalid();
  const manifestSha256 = sha256(manifestBytes);
  const manifestKey = `${objectPrefix}/manifest-${manifestSha256}.json`;
  await putAndVerify(
    input.storage,
    manifestKey,
    manifestBytes,
    manifestSha256,
    "application/json",
    input.signal,
  );
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    manifestKey,
    manifestSha256,
    rendererOutputDigest: input.rendererOutputDigest,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
  });
}

export async function materializeQualityCandidateArtifact(input: {
  reference: QualityCandidateArtifactRef;
  scratchParent: string;
  storage: QualityCandidateArtifactStorage;
  signal?: AbortSignal;
}): Promise<{ root: string; cleanup(): Promise<void> }> {
  const reference = input.reference;
  if (
    reference.schemaVersion !== SCHEMA_VERSION ||
    !SHA256.test(reference.manifestSha256) ||
    !SHA256.test(reference.rendererOutputDigest) ||
    !Number.isSafeInteger(reference.fileCount) ||
    reference.fileCount <= 0 ||
    reference.fileCount > MAX_FILES ||
    !Number.isSafeInteger(reference.totalBytes) ||
    reference.totalBytes < 0 ||
    reference.totalBytes > MAX_TOTAL_BYTES
  ) {
    invalid();
  }
  assertSafeObjectKey(reference.manifestKey);
  const manifestBytes = await input.storage.getBufferBounded(
    reference.manifestKey,
    MAX_MANIFEST_BYTES,
    input.signal,
  );
  if (sha256(manifestBytes) !== reference.manifestSha256) invalid();
  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    invalid();
  }
  const manifest = validateManifest(decoded);
  if (
    manifest.rendererOutputDigest !== reference.rendererOutputDigest ||
    manifest.fileCount !== reference.fileCount ||
    manifest.totalBytes !== reference.totalBytes ||
    !manifest.files.every((file) =>
      file.objectKey.startsWith(`${reference.manifestKey.split("/manifest-")[0]}/files/`),
    )
  ) {
    invalid();
  }

  await mkdir(input.scratchParent, { recursive: true });
  const root = await mkdtemp(path.join(input.scratchParent, "candidate-"));
  try {
    for (const file of manifest.files) {
      const bytes = await input.storage.getBufferBounded(
        file.objectKey,
        file.sizeBytes === 0 ? 1 : file.sizeBytes,
        input.signal,
      );
      if (bytes.length !== file.sizeBytes || sha256(bytes) !== file.sha256) invalid();
      const target = path.join(root, ...file.path.split("/"));
      const relative = path.relative(root, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) invalid();
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
    return Object.freeze({
      root,
      cleanup: () => rm(root, { recursive: true, force: true }),
    });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
