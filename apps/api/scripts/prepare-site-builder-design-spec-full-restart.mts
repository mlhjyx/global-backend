import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDesignSpecFullRestartPrep,
  DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_BUNDLE_ID,
  DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_FILES,
  renderDesignSpecFullRestartDecisionCard,
} from "../src/site-builder/eval/design-spec-full-restart-prep";
import { sha256CanonicalJson } from "../src/site-builder/eval/design-spec-evidence-preflight";
import {
  writeRepositoryJsonCreateOnly,
  writeRepositoryMarkdownCreateOnly,
} from "../src/site-builder/eval/create-only-json";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const SOURCES = Object.freeze({
  manifest:
    "docs/evidence/site-builder/m1-g-design-spec-evaluation-manifest-v1.json",
  resume: "docs/evidence/site-builder/m1-g-design-spec-resume-prep-v1.json",
  stopped: "docs/evidence/site-builder/m1-g-design-spec-real-evidence-v1.json",
  reconciliation:
    "docs/evidence/site-builder/m1-g-design-spec-settlement-reconciliation-v1.json",
});

function option(name: string): string {
  const prefix = `--${name}=`;
  const values = process.argv
    .slice(2)
    .filter((value) => value.startsWith(prefix));
  if (values.length !== 1 || values[0]!.length === prefix.length) {
    throw new Error(`exactly one --${name}=... option is required`);
  }
  return values[0]!.slice(prefix.length);
}

function gitShow(path: string): Buffer {
  return execFileSync("git", ["show", `HEAD:${path}`], {
    cwd: REPOSITORY_ROOT,
    encoding: null,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function assertCleanHead(): string {
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  ).trim();
  if (dirty !== "") {
    throw new Error(
      "full-restart preparation requires a clean fixed-commit worktree",
    );
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("fixed HEAD is invalid");
  return head;
}

function evidence(path: string): { value: unknown; sha256: string } {
  const bytes = gitShow(path);
  return {
    value: JSON.parse(bytes.toString("utf8")) as unknown,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function runnerSourceBundle(commitSha: string) {
  const files = DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_FILES.map((path) => {
    const bytes = gitShow(path);
    return Object.freeze({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });
  return Object.freeze({
    commitSha,
    contractId: DESIGN_SPEC_FULL_RESTART_PREFLIGHT_SOURCE_BUNDLE_ID,
    sha256: sha256CanonicalJson(files),
    files: Object.freeze(files),
  });
}

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write(
      "Usage: tsx scripts/prepare-site-builder-design-spec-full-restart.mts --output=docs/evidence/site-builder/<new>.json --decision-card=docs/evidence/site-builder/<new>.md\nThis command is offline and create-only. It does not read credentials, call a network/model endpoint, modify new-api, or authorize dispatch.\n",
    );
    return;
  }
  const output = option("output");
  const decisionCard = option("decision-card");
  const preparedFixedCommitSha = assertCleanHead();
  const [manifest, resume, stopped, reconciliation] = [
    evidence(SOURCES.manifest),
    evidence(SOURCES.resume),
    evidence(SOURCES.stopped),
    evidence(SOURCES.reconciliation),
  ];
  const report = buildDesignSpecFullRestartPrep({
    preparedFixedCommitSha,
    manifest,
    resume,
    stopped,
    reconciliation,
    runnerSourceBundle: runnerSourceBundle(preparedFixedCommitSha),
  });
  await writeRepositoryJsonCreateOnly(REPOSITORY_ROOT, output, report);
  await writeRepositoryMarkdownCreateOnly(
    REPOSITORY_ROOT,
    decisionCard,
    renderDesignSpecFullRestartDecisionCard(report),
  );
  process.stdout.write(
    `created ${output} and ${decisionCard}; status=${report.status}; network_calls=0; model_wire_calls=0; model_cost_cents=0; dispatch=NOT_AUTHORIZED\n`,
  );
}

await main();
