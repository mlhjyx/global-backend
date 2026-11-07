/**
 * 校验 Golden Set 评测清单（`evals/evals.json`）：结构 + 闭集断言词汇。
 * 用法：`pnpm skills:evals:validate`。没有清单时直接通过（S1-4 起逐步补齐）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEvalManifest } from "../apps/api/src/skills/evals/eval-manifest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const roots = [
  join(repoRoot, "apps/api/src/skills/builtin"),
  join(repoRoot, "apps/api/src/skills/imported"),
  join(repoRoot, "apps/api/src/skills/packs/content"),
];

function findEvalFiles(directory: string): string[] {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      found.push(...findEvalFiles(path));
    } else if (entry === "evals.json") {
      found.push(path);
    }
  }
  return found;
}

let failures = 0;
let checked = 0;
for (const root of roots) {
  for (const file of findEvalFiles(root).sort()) {
    checked += 1;
    let candidate: unknown;
    try {
      candidate = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      process.stderr.write(`ERROR EVAL_JSON_INVALID ${relative(repoRoot, file)}\n`);
      failures += 1;
      continue;
    }
    const issues = validateEvalManifest(candidate);
    for (const issue of issues) {
      process.stderr.write(
        `${issue.severity.toUpperCase()} ${issue.code} ${relative(repoRoot, file)}: ${issue.message}\n`,
      );
    }
    if (issues.some((issue) => issue.severity === "error")) failures += 1;
  }
}

if (failures > 0) {
  process.stderr.write(`skills:evals:validate failed (${failures} file(s))\n`);
  process.exit(1);
}
process.stdout.write(`skills:evals:validate ok (${checked} manifest(s))\n`);
