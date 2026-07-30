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
  pnpm --filter @global/api exec tsx scripts/prepare-site-builder-design-spec-evaluation-suite.mts \\
    --fixed-commit=<40-char-sha> \\
    --output=<new-repository-relative-json>

This create-only command never reads .env and has no model or network client.
It requires a clean worktree at the exact fixed commit, rebuilds the ignored
@global/contracts runtime locally before importing the suite, and writes only
with wx.
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

function assertFixedRepositoryState(fixedCommitSha: string): void {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  if (head !== fixedCommitSha) {
    throw new Error(
      `fixed commit mismatch: expected ${fixedCommitSha}, got ${head}`,
    );
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
    throw new Error("fixed-commit suite preparation requires a clean worktree");
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
  assertFixedRepositoryState(fixedCommitSha);
  const compiledContractsBuild = buildCompiledContractsForSuiteImport({
    repositoryRoot: REPOSITORY_ROOT,
    fixedCommitSha,
  });
  assertFixedRepositoryState(fixedCommitSha);
  const {
    attestDesignSpecCompiledContractsAfterSuiteImport,
    buildDesignSpecEvaluationSuitePrepManifest,
    writeDesignSpecEvaluationSuitePrepManifestCreateOnly,
  } =
    await import("../src/site-builder/eval/design-spec-evaluation-suite-prep");
  const compiledContracts = attestDesignSpecCompiledContractsAfterSuiteImport(
    compiledContractsBuild,
  );
  const manifest = buildDesignSpecEvaluationSuitePrepManifest(
    fixedCommitSha,
    compiledContracts,
  );
  await assertSourceBundleAtFixedCommit(
    fixedCommitSha,
    manifest.suite.sourceFiles,
  );
  assertCompiledContractsAttestationStable(REPOSITORY_ROOT, compiledContracts);
  assertFixedRepositoryState(fixedCommitSha);
  await writeDesignSpecEvaluationSuitePrepManifestCreateOnly(
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
