/**
 * 校验 `apps/api/src/skills/packs/content/**`（4 类 Pack Schema + 语义 + 冲突模拟）。
 * 用法：`pnpm packs:validate`；`pnpm packs:validate --check-catalog` 同时校验生成目录新鲜度。
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBuiltinPacks } from "../apps/api/src/skills/packs/load-builtin-packs";
import { mergeComplianceRules } from "../apps/api/src/skills/packs/pack-merge";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const contentRoot = join(repoRoot, "apps/api/src/skills/packs/content");

const { records, issues } = loadBuiltinPacks(contentRoot);
for (const issue of issues) {
  const stream = issue.severity === "error" ? process.stderr : process.stdout;
  stream.write(`${issue.severity.toUpperCase()} ${issue.code} ${issue.file}: ${issue.message}\n`);
}

const merge = mergeComplianceRules(records.map((record) => record.manifest));
process.stdout.write(
  `packs: ${records.length}, compliance rules effective ${merge.effective.length}, rejected ${merge.rejected.length}\n`,
);

const errors = issues.filter((issue) => issue.severity === "error").length;
if (errors > 0) {
  process.stderr.write(`packs:validate failed (${errors} error(s))\n`);
  process.exit(1);
}
process.stdout.write(`packs:validate ok (${records.length} pack(s), ${issues.length} warning(s))\n`);
