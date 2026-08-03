import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = realpathSync(resolve(import.meta.dirname, "../../.."));
const outputPath =
  "docs/evidence/site-builder/m1-g-remaining-text-evaluation-manifest-v2.json";
const fixedCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();

const {
  buildRemainingTextEvaluationPrepManifest,
  writeRemainingTextEvaluationPrepManifestCreateOnly,
} =
  await import("../src/site-builder/eval/remaining-text-evaluation-manifest-prep");

const manifest = buildRemainingTextEvaluationPrepManifest(fixedCommitSha);
await writeRemainingTextEvaluationPrepManifestCreateOnly(
  repositoryRoot,
  outputPath,
  manifest,
);

process.stdout.write(
  `${JSON.stringify({ outputPath, manifestSha256: manifest.manifestSha256 })}\n`,
);
