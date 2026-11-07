/**
 * 校验 `apps/api/src/skills/builtin/**` 下的 SKILL.md（spec v0）。
 * 用法：`pnpm skills:validate`；`pnpm skills:validate --print-digests` 输出绑定任务的
 * 当前契约摘要（更新 SKILL.md 的 `platform.task-contract-digest` 时使用）。
 * 前置：`pnpm --filter @global/contracts build`。
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTask } from "../apps/api/src/ai-tasks/task-registry";
import { loadBuiltinSkills } from "../apps/api/src/skills/load-builtin-skills";
import { computeTaskContractDigest } from "../apps/api/src/skills/skill-manifest";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const builtinRoot = join(repoRoot, "apps/api/src/skills/builtin");

const { records, issues } = loadBuiltinSkills(builtinRoot, getTask);

if (process.argv.includes("--print-digests")) {
  for (const record of records) {
    const contractId = record.manifest.platform.taskContractId;
    const contract = getTask(contractId);
    const digest = contract ? computeTaskContractDigest(contract) : "MISSING";
    process.stdout.write(`${record.skillKey}\t${contractId}\t${digest}\n`);
  }
}

for (const issue of issues) {
  const stream = issue.severity === "error" ? process.stderr : process.stdout;
  stream.write(`${issue.severity.toUpperCase()} ${issue.code} ${issue.file}: ${issue.message}\n`);
}

const errors = issues.filter((issue) => issue.severity === "error").length;
if (errors > 0) {
  process.stderr.write(`skills:validate failed (${errors} error(s), ${records.length} skill(s))\n`);
  process.exit(1);
}
process.stdout.write(`skills:validate ok (${records.length} skill(s), ${issues.length} warning(s))\n`);
