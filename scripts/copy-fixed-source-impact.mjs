import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { readRepoRegularFile } from "./governance-path-contracts.mjs";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const MAX_BOUND_SOURCE_BYTES = 16 * 1024 * 1024;

export const COPY_RUNTIME_ELIGIBILITY_PATH =
  "docs/evidence/site-builder/copy-runtime-eligibility.json";
export const ACTIVE_COPY_RUNTIME_BINDING_PATH =
  "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v15.json";
export const ACTIVE_COPY_RUNTIME_BINDING_SHA256 =
  "838121ccf9649b05d9c04b05a1cec7ba094439a8a81a177462e5955a17c2ef7c";
const ALLOWED_STALE_PATHS = Object.freeze(["packages/db/prisma/schema.prisma"]);

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
    eligibility.schema_version !== "site-builder-copy-runtime-eligibility/v1" ||
    eligibility.active_binding_path !== ACTIVE_COPY_RUNTIME_BINDING_PATH ||
    eligibility.dispatch_authorization !== "NOT_AUTHORIZED" ||
    eligibility.pilot_eligibility !== "BLOCKED" ||
    eligibility.required_followup !== "REBASE_FIXED_SOURCE_BEFORE_DISPATCH"
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

  const sourceFingerprint = buildCopySourceFingerprint(current);
  if (eligibility.current_source_fingerprint !== sourceFingerprint) {
    fail("COPY_FIXED_SOURCE_FINGERPRINT_MISMATCH");
  }
  const driftedPaths = current
    .filter((entry, index) => entry.sha256 !== boundFiles[index].sha256)
    .map(({ path }) => path);

  const expectedStatus = driftedPaths.length === 0 ? "CURRENT" : "STALE_HOLD";
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
  const expectedStaleScope =
    expectedStatus === "CURRENT" ? "NONE" : "PRISMA_SCHEMA_EVOLUTION";
  if (
    eligibility.stale_scope !== expectedStaleScope ||
    driftedPaths.some((path) => !ALLOWED_STALE_PATHS.includes(path))
  ) {
    fail("COPY_FIXED_SOURCE_STALE_SCOPE_INVALID");
  }

  return Object.freeze({
    status: expectedStatus,
    driftedPaths,
    sourceFingerprint,
  });
}

async function parseJsonFile(root, path) {
  const bytes = await readRepoRegularFile(root, path, {
    maxBytes: MAX_BOUND_SOURCE_BYTES,
  });
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail("COPY_FIXED_SOURCE_JSON_INVALID");
  }
}

async function evaluateRepository(root) {
  const eligibility = await parseJsonFile(root, COPY_RUNTIME_ELIGIBILITY_PATH);
  if (eligibility.active_binding_path !== ACTIVE_COPY_RUNTIME_BINDING_PATH) {
    fail("COPY_FIXED_SOURCE_SAFETY_BOUNDARY_INVALID");
  }
  const bindingBytes = await readRepoRegularFile(
    root,
    ACTIVE_COPY_RUNTIME_BINDING_PATH,
    { maxBytes: MAX_BOUND_SOURCE_BYTES },
  );
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
  const currentFiles = [];
  for (const { path } of boundFiles) {
    const bytes = await readRepoRegularFile(root, path, {
      maxBytes: MAX_BOUND_SOURCE_BYTES,
    });
    currentFiles.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return evaluateCopyFixedSourceImpact({ binding, eligibility, currentFiles });
}

async function main(argv) {
  const root = process.cwd();
  const result = await evaluateRepository(root);
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
