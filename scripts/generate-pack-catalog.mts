/**
 * 生成 `apps/api/src/skills/packs/generated/builtin-pack-catalog.ts`（运行时读取的 Pack 目录）。
 *
 * 真源：`apps/api/src/skills/packs/content/<pack_type>/<pack-key-suffix>/pack.json + PACK.md`。
 * 用法：`pnpm packs:generate`（写文件） / `pnpm packs:generate --check`（只校验新鲜度）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBuiltinPacks } from "../apps/api/src/skills/packs/load-builtin-packs";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const contentRoot = join(repoRoot, "apps/api/src/skills/packs/content");
const outputPath = join(
  repoRoot,
  "apps/api/src/skills/packs/generated/builtin-pack-catalog.ts",
);

function render(): string {
  const { records, issues } = loadBuiltinPacks(contentRoot);
  for (const issue of issues) {
    const stream = issue.severity === "error" ? process.stderr : process.stdout;
    stream.write(`${issue.severity.toUpperCase()} ${issue.code} ${issue.file}: ${issue.message}\n`);
  }
  if (issues.some((issue) => issue.severity === "error")) {
    process.exit(1);
  }
  return [
    "// GENERATED FILE — do not edit by hand.",
    "// Source: apps/api/src/skills/packs/content/**/pack.json + PACK.md",
    "// Regenerate: pnpm packs:generate   Verify: pnpm packs:validate",
    'import type { BuiltinPackRecord } from "../load-builtin-packs";',
    "",
    "export const BUILTIN_PACKS: readonly BuiltinPackRecord[] =",
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
    process.stderr.write(`missing generated pack catalog: ${outputPath}\n`);
    process.exit(1);
  }
  if (current !== rendered) {
    process.stderr.write("generated pack catalog is stale: run pnpm packs:generate\n");
    process.exit(1);
  }
  process.stdout.write("pack catalog is up to date\n");
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, rendered);
  process.stdout.write(`wrote ${outputPath}\n`);
}
