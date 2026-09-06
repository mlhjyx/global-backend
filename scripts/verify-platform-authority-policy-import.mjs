import { spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = "platform-authority-policy-import-verification/v2";
const BACKEND_ROOT = resolve(import.meta.dirname, "..");
const CROSS_REPO_TEST = resolve(
  BACKEND_ROOT,
  "scripts/platform-authority-policy-import.cross-repo.spec.mjs",
);

function report(status, reason, extra = {}) {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, status, reason, ...extra })}\n`,
  );
}

function argumentsFrom(argv) {
  if (argv.length === 0) {
    return {
      authorityRoot:
        process.env.GROWTHOS_AUTHORITY_ROOT ??
        "/global/frontend/growthos-source",
    };
  }
  if (
    argv.length === 2 &&
    argv[0] === "--authority-root" &&
    typeof argv[1] === "string" &&
    argv[1].trim() === argv[1] &&
    isAbsolute(argv[1])
  ) {
    return { authorityRoot: argv[1] };
  }
  return null;
}

async function exactDirectory(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return null;
    return await realpath(path);
  } catch {
    return null;
  }
}

export async function verifyPlatformAuthorityPolicyImport(argv) {
  const input = argumentsFrom(argv);
  if (input === null) {
    report("FAILED", "VERIFIER_INPUT_INVALID");
    return 1;
  }
  const authorityRoot = await exactDirectory(resolve(input.authorityRoot));
  if (authorityRoot === null) {
    report("EXTERNAL_UNVERIFIED", "AUTHORITY_CHECKOUT_UNAVAILABLE");
    return 2;
  }
  const result = spawnSync(process.execPath, ["--test", CROSS_REPO_TEST], {
    cwd: BACKEND_ROOT,
    encoding: "utf8",
    env: { ...process.env, GROWTHOS_AUTHORITY_ROOT: authorityRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    report("FAILED", "AUTHORITY_VERIFICATION_FAILED");
    return 1;
  }
  report("VERIFIED", "EXACT_AUTHORITY_MATERIALIZED", {
    reviewedAuthorityCommit:
      "17e68953ff2e26ac8433db5aa49689e5f9283659",
    artifactCommit: "cb572a149d44ab402d5cfcdaaa0aeb21c053ad9e",
    artifactSha256:
      "f9e9591731772f974b087307b5d0365c58c86b501232804c77a20fd3592db01b",
  });
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  verifyPlatformAuthorityPolicyImport(process.argv.slice(2))
    .then((status) => {
      process.exitCode = status;
    })
    .catch(() => {
      report("FAILED", "AUTHORITY_VERIFIER_UNAVAILABLE");
      process.exitCode = 1;
    });
}
