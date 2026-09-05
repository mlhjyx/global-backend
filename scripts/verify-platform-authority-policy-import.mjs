import { spawnSync } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCHEMA_VERSION = "platform-authority-policy-import-verification/v1";
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
    authorityCommit: "290c6f9f6a41c7c39dfe071683252982536937d8",
    artifactSha256:
      "248a416e72a8c2590a5c6c8adb941f4105c6ac3e722bc85ced3a77f404784fa1",
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
