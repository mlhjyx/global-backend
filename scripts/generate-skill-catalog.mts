/**
 * 生成 `apps/api/src/skills/generated/builtin-skill-catalog.ts`（运行时读取的技能目录）。
 *
 * 真源：`apps/api/src/skills/builtin/<pack_type>/<skill-name>/SKILL.md`。
 * 用法：`pnpm skills:generate`（写文件） / `pnpm skills:generate --check`（只校验新鲜度）。
 * 前置：`pnpm --filter @global/contracts build`（任务契约在本仓的类型解析需要）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTask } from "../apps/api/src/ai-tasks/task-registry";
import { loadBuiltinSkills } from "../apps/api/src/skills/load-builtin-skills";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const builtinRoot = join(repoRoot, "apps/api/src/skills/builtin");
const outputPath = join(repoRoot, "apps/api/src/skills/generated/builtin-skill-catalog.ts");

function render(): string {
  const { records, issues } = loadBuiltinSkills(builtinRoot, getTask);
  for (const issue of issues) {
    const stream = issue.severity === "error" ? process.stderr : process.stdout;
    stream.write(`${issue.severity.toUpperCase()} ${issue.code} ${issue.file}: ${issue.message}\n`);
  }
  if (issues.some((issue) => issue.severity === "error")) {
    process.exit(1);
  }
  return [
    "// GENERATED FILE — do not edit by hand.",
    "// Source: apps/api/src/skills/builtin/**/SKILL.md",
    "// Regenerate: pnpm skills:generate   Verify: pnpm skills:validate",
    'import type { BuiltinSkillRecord } from "../load-builtin-skills";',
    "",
    "export const BUILTIN_SKILLS: readonly BuiltinSkillRecord[] =",
    `${JSON.stringify(records, null, 2)};`,
    "",
  ].join("\n");
}

const rendered = render();
const check = process.argv.includes("--check");

if (check) {
  let current = "";
  try {
    current = readFileSync(outputPath, "utf8");
  } catch {
    process.stderr.write(`missing generated catalog: ${outputPath}\n`);
    process.exit(1);
  }
  if (current !== rendered) {
    process.stderr.write("generated skill catalog is stale: run pnpm skills:generate\n");
    process.exit(1);
  }
  process.stdout.write("skill catalog is up to date\n");
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered);
  process.stdout.write(`wrote ${outputPath}\n`);
}
