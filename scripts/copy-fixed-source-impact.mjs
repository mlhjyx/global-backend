import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { appendFile, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const MAX_BOUND_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_BOUND_SOURCE_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_BOUND_SOURCE_FILES = 512;
const ELIGIBILITY_KEYS = Object.freeze(
  [
    "active_binding_artifact_id",
    "active_binding_path",
    "active_binding_source_bundle_digest",
    "current_source_fingerprint",
    "dispatch_authorization",
    "drifted_paths",
    "pilot_eligibility",
    "required_followup",
    "schema_version",
    "stale_scope",
    "status",
  ].sort(),
);

export const COPY_RUNTIME_ELIGIBILITY_PATH =
  "docs/evidence/site-builder/copy-runtime-eligibility.json";
export const ACTIVE_COPY_RUNTIME_BINDING_PATH =
  "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v22.json";
export const ACTIVE_COPY_RUNTIME_BINDING_SHA256 =
  "135ff0a6166d30b2257de48048b5c6c093a277ace5ef376a6e3dac1582a58bcd";
const REVIEWED_STALE_SCOPES = Object.freeze([
  Object.freeze({
    scope: "PRISMA_SCHEMA_EVOLUTION",
    paths: Object.freeze(["packages/db/prisma/schema.prisma"]),
  }),
  Object.freeze({
    scope: "PRODUCTION_PARITY_SINGLE_RUNTIME_PATH",
    paths: Object.freeze([
      "apps/api/package.json",
      "apps/api/src/model-gateway/new-api-request-bound-settlement.ts",
      "apps/api/src/model-runtime/structured-task-runtime-bridge.ts",
      "apps/api/src/site-builder/agents/ai-task.ts",
      "apps/api/tsconfig.build.json",
      "packages/contracts/package.json",
      "packages/contracts/src/site-builder/component-qualification.ts",
      "packages/db/prisma/schema.prisma",
      "pnpm-lock.yaml",
    ]),
  }),
  Object.freeze({
    scope: "PRODUCTION_PARITY_SINGLE_RUNTIME_PATH_SECURITY_PATCH",
    paths: Object.freeze([
      "apps/api/package.json",
      "apps/api/src/model-gateway/new-api-request-bound-settlement.ts",
      "apps/api/src/model-runtime/structured-task-runtime-bridge.ts",
      "apps/api/src/site-builder/agents/ai-task.ts",
      "apps/api/tsconfig.build.json",
      "package.json",
      "packages/contracts/package.json",
      "packages/contracts/src/site-builder/component-qualification.ts",
      "packages/db/prisma/schema.prisma",
      "pnpm-lock.yaml",
    ]),
  }),
  Object.freeze({
    scope: "PRODUCTION_PARITY_EXECUTION_BUDGET_AUTHORITY_FOUNDATION",
    paths: Object.freeze([
      "apps/api/package.json",
      "apps/api/src/model-gateway/new-api-request-bound-settlement.ts",
      "apps/api/src/model-runtime/structured-task-runtime-bridge.ts",
      "apps/api/src/site-builder/agents/ai-task.ts",
      "apps/api/tsconfig.build.json",
      "package.json",
      "packages/contracts/package.json",
      "packages/contracts/src/index.ts",
      "packages/contracts/src/site-builder/component-qualification.ts",
      "packages/db/prisma/schema.prisma",
      "pnpm-lock.yaml",
    ]),
  }),
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isSafeRepositoryPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").includes("..")
  );
}

function sameOpenedNode(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function descriptorPath(handle, name) {
  const root = `/proc/self/fd/${handle.fd}`;
  return name === undefined ? root : `${root}/${name}`;
}

async function openNoFollow(path, flags, errorCode) {
  try {
    return await open(
      path,
      flags | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      fail(errorCode);
    }
    throw error;
  }
}

export async function readStableRegularHandle(handle, maximumBytes, label) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    fail("COPY_FIXED_SOURCE_SIZE_LIMIT_INVALID");
  }
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) fail("COPY_FIXED_SOURCE_PATH_NOT_REGULAR");
  if (before.size > BigInt(maximumBytes)) {
    fail("COPY_FIXED_SOURCE_FILE_TOO_LARGE");
  }
  const expectedSize = Number(before.size);
  const buffer = Buffer.alloc(expectedSize + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (!sameOpenedNode(before, after) || offset !== expectedSize) {
    fail("COPY_FIXED_SOURCE_FILE_CHANGED");
  }
  return buffer.subarray(0, offset);
}

async function openStableDirectory(path, errorCode) {
  const handle = await openNoFollow(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
    errorCode,
  );
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory()) fail(errorCode);
    return { handle, stat };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function readAnchoredRepositoryFile(root, repoPath, options = {}) {
  const maximumBytes = options.maxBytes ?? MAX_BOUND_SOURCE_BYTES;
  if (!isSafeRepositoryPath(repoPath)) {
    fail("COPY_FIXED_SOURCE_PATH_INVALID");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    fail("COPY_FIXED_SOURCE_SIZE_LIMIT_INVALID");
  }

  const openedDirectories = [];
  let fileHandle;
  try {
    const repositoryRoot = await openStableDirectory(
      resolve(root),
      "COPY_FIXED_SOURCE_PATH_NOT_REGULAR",
    );
    openedDirectories.push(repositoryRoot);
    const components = repoPath.split("/");
    for (let index = 0; index < components.length; index += 1) {
      const parent = openedDirectories.at(-1);
      const parentBefore = await parent.handle.stat({ bigint: true });
      if (!sameOpenedNode(parent.stat, parentBefore)) {
        fail("COPY_FIXED_SOURCE_DIRECTORY_CHANGED");
      }
      const finalComponent = index === components.length - 1;
      const child = await openNoFollow(
        descriptorPath(parent.handle, components[index]),
        fsConstants.O_RDONLY | (finalComponent ? 0 : fsConstants.O_DIRECTORY),
        "COPY_FIXED_SOURCE_PATH_NOT_REGULAR",
      );
      const parentAfter = await parent.handle.stat({ bigint: true });
      if (!sameOpenedNode(parentBefore, parentAfter)) {
        await child.close().catch(() => undefined);
        fail("COPY_FIXED_SOURCE_DIRECTORY_CHANGED");
      }
      if (finalComponent) {
        fileHandle = child;
      } else {
        try {
          const childStat = await child.stat({ bigint: true });
          if (!childStat.isDirectory()) {
            fail("COPY_FIXED_SOURCE_PATH_NOT_REGULAR");
          }
          openedDirectories.push({ handle: child, stat: childStat });
        } catch (error) {
          await child.close().catch(() => undefined);
          throw error;
        }
      }
    }

    const bytes = await readStableRegularHandle(
      fileHandle,
      maximumBytes,
      repoPath,
    );
    for (const directory of openedDirectories) {
      const after = await directory.handle.stat({ bigint: true });
      if (!sameOpenedNode(directory.stat, after)) {
        fail("COPY_FIXED_SOURCE_DIRECTORY_CHANGED");
      }
    }
    return bytes;
  } finally {
    if (fileHandle !== undefined) {
      await fileHandle.close().catch(() => undefined);
    }
    for (const directory of openedDirectories.reverse()) {
      await directory.handle.close().catch(() => undefined);
    }
  }
}

export function accountCopySourceBytes(currentBytes, stableFileBytes) {
  if (
    !Number.isSafeInteger(currentBytes) ||
    currentBytes < 0 ||
    !Number.isSafeInteger(stableFileBytes) ||
    stableFileBytes < 0
  ) {
    fail("COPY_FIXED_SOURCE_TOTAL_BYTES_INVALID");
  }
  const totalBytes = currentBytes + stableFileBytes;
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > MAX_BOUND_SOURCE_TOTAL_BYTES
  ) {
    fail("COPY_FIXED_SOURCE_TOTAL_BYTES_EXCEEDED");
  }
  return totalBytes;
}

function canonicalSourceFiles(files, errorCode) {
  if (!Array.isArray(files) || files.length === 0) fail(errorCode);
  const paths = new Set();
  return files.map((entry, index) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      !isSafeRepositoryPath(entry.path) ||
      !SHA256.test(entry.sha256) ||
      paths.has(entry.path) ||
      (index > 0 && files[index - 1]?.path >= entry.path)
    ) {
      fail(errorCode);
    }
    paths.add(entry.path);
    return Object.freeze({ path: entry.path, sha256: entry.sha256 });
  });
}

export function buildCopySourceFingerprint(files) {
  const canonical = canonicalSourceFiles(
    files,
    "COPY_FIXED_SOURCE_CURRENT_FILES_INVALID",
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function reviewedStaleScope(driftedPaths) {
  if (driftedPaths.length === 0) return "NONE";
  const reviewed = REVIEWED_STALE_SCOPES.find(
    ({ paths }) =>
      paths.length === driftedPaths.length &&
      paths.every((path, index) => path === driftedPaths[index]),
  );
  if (!reviewed) fail("COPY_FIXED_SOURCE_STALE_SCOPE_INVALID");
  return reviewed.scope;
}

function validateBinding(binding) {
  if (
    binding === null ||
    typeof binding !== "object" ||
    typeof binding.artifactId !== "string" ||
    binding.artifactId.length === 0 ||
    !GIT_COMMIT.test(binding.fixedSourceCommit) ||
    binding.dispatchAuthorization !== "NOT_AUTHORIZED" ||
    binding.sourceBundle === null ||
    typeof binding.sourceBundle !== "object" ||
    !SHA256.test(binding.sourceBundle.digest)
  ) {
    fail("COPY_FIXED_SOURCE_BINDING_INVALID");
  }
  return canonicalSourceFiles(
    binding.sourceBundle.files,
    "COPY_FIXED_SOURCE_BINDING_INVALID",
  );
}

function validateEligibilityBoundary(eligibility) {
  if (
    eligibility === null ||
    typeof eligibility !== "object" ||
    Array.isArray(eligibility) ||
    JSON.stringify(Object.keys(eligibility).sort()) !==
      JSON.stringify(ELIGIBILITY_KEYS) ||
    eligibility.schema_version !== "site-builder-copy-runtime-eligibility/v1" ||
    eligibility.active_binding_path !== ACTIVE_COPY_RUNTIME_BINDING_PATH ||
    eligibility.dispatch_authorization !== "NOT_AUTHORIZED" ||
    eligibility.pilot_eligibility !== "BLOCKED"
  ) {
    fail("COPY_FIXED_SOURCE_SAFETY_BOUNDARY_INVALID");
  }
}

export function evaluateCopyFixedSourceImpact({
  binding,
  eligibility,
  currentFiles,
}) {
  const boundFiles = validateBinding(binding);
  const current = canonicalSourceFiles(
    currentFiles,
    "COPY_FIXED_SOURCE_CURRENT_FILES_INVALID",
  );
  validateEligibilityBoundary(eligibility);

  if (
    eligibility.active_binding_artifact_id !== binding.artifactId ||
    eligibility.active_binding_source_bundle_digest !==
      binding.sourceBundle.digest
  ) {
    fail("COPY_FIXED_SOURCE_BINDING_MISMATCH");
  }
  if (
    current.length !== boundFiles.length ||
    current.some((entry, index) => entry.path !== boundFiles[index]?.path)
  ) {
    fail("COPY_FIXED_SOURCE_CURRENT_FILES_INVALID");
  }

  const expectedReceipt = buildCopyRuntimeEligibilityReceipt({
    binding,
    currentFiles: current,
  });
  const sourceFingerprint = expectedReceipt.current_source_fingerprint;
  if (eligibility.current_source_fingerprint !== sourceFingerprint) {
    fail("COPY_FIXED_SOURCE_FINGERPRINT_MISMATCH");
  }
  const driftedPaths = expectedReceipt.drifted_paths;
  const expectedStatus = expectedReceipt.status;
  if (eligibility.status !== expectedStatus) {
    fail("COPY_FIXED_SOURCE_STATUS_INVALID");
  }
  if (
    !Array.isArray(eligibility.drifted_paths) ||
    eligibility.drifted_paths.length !== driftedPaths.length ||
    eligibility.drifted_paths.some(
      (path, index) => path !== driftedPaths[index],
    )
  ) {
    fail("COPY_FIXED_SOURCE_DRIFT_PATHS_MISMATCH");
  }
  if (eligibility.stale_scope !== expectedReceipt.stale_scope) {
    fail("COPY_FIXED_SOURCE_STALE_SCOPE_INVALID");
  }
  if (eligibility.required_followup !== expectedReceipt.required_followup) {
    fail("COPY_FIXED_SOURCE_FOLLOWUP_INVALID");
  }

  return Object.freeze({
    status: expectedStatus,
    driftedPaths,
    sourceFingerprint,
  });
}

export function buildCopyRuntimeEligibilityReceipt({ binding, currentFiles }) {
  const boundFiles = validateBinding(binding);
  const current = canonicalSourceFiles(
    currentFiles,
    "COPY_FIXED_SOURCE_CURRENT_FILES_INVALID",
  );
  if (
    current.length !== boundFiles.length ||
    current.some((entry, index) => entry.path !== boundFiles[index]?.path)
  ) {
    fail("COPY_FIXED_SOURCE_CURRENT_FILES_INVALID");
  }
  const driftedPaths = current
    .filter((entry, index) => entry.sha256 !== boundFiles[index].sha256)
    .map(({ path }) => path);
  const status = driftedPaths.length === 0 ? "CURRENT" : "STALE_HOLD";
  const staleScope = reviewedStaleScope(driftedPaths);
  return Object.freeze({
    schema_version: "site-builder-copy-runtime-eligibility/v1",
    active_binding_path: ACTIVE_COPY_RUNTIME_BINDING_PATH,
    active_binding_artifact_id: binding.artifactId,
    active_binding_source_bundle_digest: binding.sourceBundle.digest,
    status,
    current_source_fingerprint: buildCopySourceFingerprint(current),
    drifted_paths: driftedPaths,
    dispatch_authorization: "NOT_AUTHORIZED",
    pilot_eligibility: "BLOCKED",
    required_followup:
      status === "CURRENT"
        ? "SEPARATE_DISPATCH_AUTHORIZATION"
        : "REBASE_FIXED_SOURCE_BEFORE_DISPATCH",
    stale_scope: staleScope,
  });
}

async function parseJsonFile(root, path) {
  const bytes = await readAnchoredRepositoryFile(root, path, {
    maxBytes: MAX_BOUND_SOURCE_BYTES,
  });
  try {
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } catch {
    return fail("COPY_FIXED_SOURCE_JSON_INVALID");
  }
}

async function readActiveBindingAndCurrentFiles(root, initialTotalBytes = 0) {
  let totalBytes = initialTotalBytes;
  const bindingBytes = await readAnchoredRepositoryFile(
    root,
    ACTIVE_COPY_RUNTIME_BINDING_PATH,
    { maxBytes: MAX_BOUND_SOURCE_BYTES },
  );
  totalBytes = accountCopySourceBytes(totalBytes, bindingBytes.length);
  if (
    createHash("sha256").update(bindingBytes).digest("hex") !==
    ACTIVE_COPY_RUNTIME_BINDING_SHA256
  ) {
    fail("COPY_FIXED_SOURCE_BINDING_BYTES_MISMATCH");
  }
  let binding;
  try {
    binding = JSON.parse(bindingBytes.toString("utf8"));
  } catch {
    fail("COPY_FIXED_SOURCE_JSON_INVALID");
  }
  const boundFiles = validateBinding(binding);
  if (boundFiles.length > MAX_BOUND_SOURCE_FILES) {
    fail("COPY_FIXED_SOURCE_FILE_COUNT_EXCEEDED");
  }
  const currentFiles = [];
  for (const { path } of boundFiles) {
    const bytes = await readAnchoredRepositoryFile(root, path, {
      maxBytes: MAX_BOUND_SOURCE_BYTES,
    });
    totalBytes = accountCopySourceBytes(totalBytes, bytes.length);
    currentFiles.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return Object.freeze({ binding, currentFiles: Object.freeze(currentFiles) });
}

export async function prepareCopyRuntimeEligibilityReceiptFromRepository(root) {
  return buildCopyRuntimeEligibilityReceipt(
    await readActiveBindingAndCurrentFiles(root),
  );
}

export async function writeCopyRuntimeEligibilityReceiptFromRepository(root) {
  const receipt =
    await prepareCopyRuntimeEligibilityReceiptFromRepository(root);
  const outputPath = resolve(root, COPY_RUNTIME_ELIGIBILITY_PATH);
  const temporaryPath = resolve(
    dirname(outputPath),
    `.${COPY_RUNTIME_ELIGIBILITY_PATH.split("/").at(-1)}.${process.pid}.tmp`,
  );
  let output;
  try {
    output = await open(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    await output.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    await output.sync();
    await output.close();
    output = undefined;
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await output?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return receipt;
}

async function evaluateRepository(root) {
  const eligibilityFile = await parseJsonFile(
    root,
    COPY_RUNTIME_ELIGIBILITY_PATH,
  );
  const eligibility = eligibilityFile.value;
  if (eligibility.active_binding_path !== ACTIVE_COPY_RUNTIME_BINDING_PATH) {
    fail("COPY_FIXED_SOURCE_SAFETY_BOUNDARY_INVALID");
  }
  const { binding, currentFiles } = await readActiveBindingAndCurrentFiles(
    root,
    accountCopySourceBytes(0, eligibilityFile.bytes.length),
  );
  return evaluateCopyFixedSourceImpact({ binding, eligibility, currentFiles });
}

async function main(argv) {
  const root = process.cwd();
  const writeEligibility =
    argv.length === 1 && argv[0] === "--write-eligibility";
  const result = writeEligibility
    ? await writeCopyRuntimeEligibilityReceiptFromRepository(root)
    : await evaluateRepository(root);
  if (writeEligibility) {
    process.stdout.write(
      `${JSON.stringify({
        result: result.status,
        active_binding_path: result.active_binding_path,
        active_binding_artifact_id: result.active_binding_artifact_id,
        dispatch_authorization: result.dispatch_authorization,
        pilot_eligibility: result.pilot_eligibility,
      })}\n`,
    );
    return;
  }
  const outputIndex = argv.indexOf("--github-output");
  if (outputIndex !== -1) {
    const outputPath = argv[outputIndex + 1];
    if (
      argv.length !== 2 ||
      outputIndex !== 0 ||
      typeof outputPath !== "string" ||
      !isAbsolute(outputPath) ||
      outputPath.includes("\0")
    ) {
      fail("COPY_FIXED_SOURCE_GITHUB_OUTPUT_INVALID");
    }
    await appendFile(outputPath, `status=${result.status}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } else if (argv.length !== 0) {
    fail("COPY_FIXED_SOURCE_ARGUMENTS_INVALID");
  }
  process.stdout.write(
    `${JSON.stringify({
      result: result.status,
      drifted_paths: result.driftedPaths,
      dispatch_authorization: "NOT_AUTHORIZED",
      pilot_eligibility: "BLOCKED",
    })}\n`,
  );
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error?.code ?? error?.message ?? "COPY_FIXED_SOURCE_UNKNOWN"}\n`,
    );
    process.exitCode = 1;
  });
}
