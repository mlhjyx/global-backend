import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCompiledContractsAttestationStable,
  buildCompiledContractsForSuiteImport,
} from "../src/site-builder/eval/compiled-contracts-attestation";
import { SITE_BUILDER_EVIDENCE_OUTPUT_PREFIX } from "../src/site-builder/eval/create-only-json";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const HELP = `Usage:
  pnpm --filter @global/api exec tsx scripts/prepare-site-builder-design-spec-evaluation-manifest.mts \\
    --fixed-commit=<40-char-sha> \\
    --output=<new-repository-relative-json>

This create-only command never reads .env and has no model or network client.
It requires a clean preparation worktree whose fixed source commit is already
reachable from origin/main, rebuilds the ignored @global/contracts runtime
locally before importing the suite, and writes only with wx. The prep HEAD may
differ from the fixed source commit because this is the separate manifest PR.
`;

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const values = process.argv
    .slice(2)
    .filter((value) => value.startsWith(prefix));
  if (values.length !== 1) return null;
  return values[0]!.slice(prefix.length);
}

function outputPath(value: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    !value.startsWith(SITE_BUILDER_EVIDENCE_OUTPUT_PREFIX) ||
    !value.endsWith(".json")
  ) {
    throw new Error(
      "output must be a repository-relative Site Builder evidence JSON path",
    );
  }
  return value;
}

function fixedCommitFile(fixedCommitSha: string, path: string): Buffer {
  try {
    return execFileSync("git", ["show", `${fixedCommitSha}:${path}`], {
      cwd: REPOSITORY_ROOT,
      encoding: null,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error(`${path} must be tracked at the fixed commit`);
  }
}

async function assertSourceBundleAtFixedCommit(
  fixedCommitSha: string,
  sourceFiles: readonly { path: string; sha256: string }[],
): Promise<void> {
  for (const source of sourceFiles) {
    const committed = fixedCommitFile(fixedCommitSha, source.path);
    const working = await readFile(resolve(REPOSITORY_ROOT, source.path));
    if (!working.equals(committed)) {
      throw new Error(`${source.path} drifted from the fixed commit`);
    }
    const digest = createHash("sha256").update(committed).digest("hex");
    if (digest !== source.sha256) {
      throw new Error(
        `${source.path} does not match the fixed source bundle digest`,
      );
    }
  }
}

function assertPreparationRepositoryState(fixedCommitSha: string): void {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(fixedCommitSha) || !/^[a-f0-9]{40}$/.test(head)) {
    throw new Error("fixed source and prep head must be full commit SHAs");
  }
  for (const revision of ["HEAD", "refs/remotes/origin/main"] as const) {
    try {
      execFileSync(
        "git",
        ["merge-base", "--is-ancestor", fixedCommitSha, revision],
        { cwd: REPOSITORY_ROOT, stdio: "ignore" },
      );
    } catch {
      throw new Error(`fixed source commit must be reachable from ${revision}`);
    }
  }
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    },
  ).trim();
  if (dirty !== "") {
    throw new Error(
      "fixed-commit manifest preparation requires a clean worktree",
    );
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const fixedCommitSha = option("fixed-commit");
  const outputArgument = option("output");
  if (!fixedCommitSha || !outputArgument) throw new Error(HELP);
  const output = outputPath(outputArgument);
  assertPreparationRepositoryState(fixedCommitSha);
  const compiledContractsBuild = buildCompiledContractsForSuiteImport({
    repositoryRoot: REPOSITORY_ROOT,
    fixedCommitSha,
  });
  assertPreparationRepositoryState(fixedCommitSha);
  const {
    attestDesignSpecCompiledContractsAfterSuiteImport,
    buildDesignSpecEvaluationPrepManifest,
    writeDesignSpecEvaluationPrepManifestCreateOnly,
  } =
    await import("../src/site-builder/eval/design-spec-evaluation-manifest-prep");
  const compiledContracts = attestDesignSpecCompiledContractsAfterSuiteImport(
    compiledContractsBuild,
  );
  const manifest = buildDesignSpecEvaluationPrepManifest(
    fixedCommitSha,
    compiledContracts,
  );
  await assertSourceBundleAtFixedCommit(
    fixedCommitSha,
    manifest.suite.sourceFiles,
  );
  assertCompiledContractsAttestationStable(REPOSITORY_ROOT, compiledContracts);
  assertPreparationRepositoryState(fixedCommitSha);
  await writeDesignSpecEvaluationPrepManifestCreateOnly(
    REPOSITORY_ROOT,
    output,
    manifest,
    compiledContracts,
  );
  process.stdout.write(
    `created ${output} at ${fixedCommitSha}; network=0 model_cost_cents=0 dispatch=NOT_AUTHORIZED\n`,
  );
}

await main();
