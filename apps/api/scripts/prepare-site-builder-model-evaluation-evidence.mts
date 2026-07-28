import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createModelEvaluationCostSafetyAttestation,
  type ModelEvaluationCostSafetyInput,
} from "../src/site-builder/eval/model-evaluation-cost-safety";
import {
  buildModelEvaluationEvidencePlanningManifest,
  createModelEvaluationEvidencePrepBundle,
  writeModelEvaluationEvidencePrepBundleCreateOnly,
} from "../src/site-builder/eval/model-evaluation-evidence-prep";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const HELP = `Usage:
  pnpm --filter @global/api exec tsx scripts/prepare-site-builder-model-evaluation-evidence.mts \\
    --fixed-commit=<40-char-sha> \\
    --attestation=<explicit-safe-json> \\
    --output=<new-repository-relative-json>

This zero-cost preparation command never reads .env and has no model client.
It requires a clean worktree at the exact fixed commit and writes only with wx.
`;

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const values = process.argv
    .slice(2)
    .filter((value) => value.startsWith(prefix));
  if (values.length !== 1) return null;
  return values[0]!.slice(prefix.length);
}

function repositoryOutputPath(value: string): string {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    !value.endsWith(".json")
  ) {
    throw new Error("output must be a new repository-relative JSON path");
  }
  return value;
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
    throw new Error(
      "fixed-commit evidence preparation requires a clean worktree",
    );
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const fixedCommitSha = option("fixed-commit");
  const attestationArgument = option("attestation");
  const outputArgument = option("output");
  if (!fixedCommitSha || !attestationArgument || !outputArgument) {
    throw new Error(HELP);
  }
  if (
    /(^|[/\\])\.env(?:\.|$)/i.test(attestationArgument) ||
    !attestationArgument.endsWith(".json")
  ) {
    throw new Error(
      "attestation must be an explicit safe JSON snapshot, not .env",
    );
  }

  assertFixedRepositoryState(fixedCommitSha);

  const attestationPath = await realpath(resolve(attestationArgument));
  if (/(^|[/\\])\.env(?:\.|$)/i.test(attestationPath)) {
    throw new Error("resolved attestation must not be .env");
  }
  const raw = JSON.parse(
    await readFile(attestationPath, "utf8"),
  ) as ModelEvaluationCostSafetyInput;
  const costSafety = createModelEvaluationCostSafetyAttestation(raw);
  const bundle = createModelEvaluationEvidencePrepBundle({
    fixedCommitSha,
    costSafety,
  });
  const output = repositoryOutputPath(outputArgument);
  assertFixedRepositoryState(fixedCommitSha);
  const currentManifest = buildModelEvaluationEvidencePlanningManifest();
  if (
    currentManifest.sourceBundleSha256 !==
      bundle.planningManifest.sourceBundleSha256 ||
    currentManifest.sourceBundleContractId !==
      bundle.planningManifest.sourceBundleContractId
  ) {
    throw new Error("source bundle drifted during evidence preparation");
  }
  await writeModelEvaluationEvidencePrepBundleCreateOnly(
    REPOSITORY_ROOT,
    output,
    bundle,
  );
  process.stdout.write(
    `created ${output} at ${fixedCommitSha}; dispatch remains NOT_AUTHORIZED\n`,
  );
}

await main();
