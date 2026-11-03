#!/usr/bin/env node
// 运行 packages/db/test 下的数据库测试，按 ci-manifest.json 分组。
// 清单是唯一分组真值：任何 *.spec.mjs 未登记（或登记后文件消失）都直接失败，防止测试孤儿。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(scriptDir, "..");
export const TEST_DIR = join(REPO_ROOT, "packages/db/test");
export const MANIFEST_PATH = join(TEST_DIR, "ci-manifest.json");
export const GROUPS = ["service", "isolated", "static"];

export function loadManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

export function listTestFiles(testDir = TEST_DIR) {
  return readdirSync(testDir)
    .filter((name) => name.endsWith(".spec.mjs"))
    .sort();
}

/** @returns {string[]} 人类可读的错误；空数组表示清单完整。 */
export function validateManifest(manifest, files) {
  const errors = [];
  const seen = new Map();
  for (const group of Object.keys(manifest)) {
    if (!GROUPS.includes(group)) {
      errors.push(`unknown group '${group}' (allowed: ${GROUPS.join(", ")})`);
    }
    for (const file of manifest[group]) {
      if (seen.has(file)) {
        errors.push(`'${file}' listed twice (${seen.get(file)}, ${group})`);
      } else {
        seen.set(file, group);
      }
      if (!files.includes(file)) {
        errors.push(`'${file}' listed in '${group}' but missing from ${TEST_DIR}`);
      }
    }
  }
  for (const file of files) {
    if (!seen.has(file)) {
      errors.push(`'${file}' is not classified in ci-manifest.json`);
    }
  }
  return errors;
}

/** 轮转分片：第 shardIndex 片（1 起）取索引 i 满足 (i % shardCount) === shardIndex - 1 的文件。 */
export function selectFiles(manifest, group, shardIndex = 1, shardCount = 1) {
  if (!GROUPS.includes(group)) {
    throw new Error(`unknown group '${group}' (allowed: ${GROUPS.join(", ")})`);
  }
  if (!Number.isInteger(shardIndex) || !Number.isInteger(shardCount) || shardIndex < 1 || shardCount < 1 || shardIndex > shardCount) {
    throw new Error(`invalid shard ${shardIndex}/${shardCount}`);
  }
  return manifest[group].filter((_, index) => index % shardCount === shardIndex - 1);
}

function parseArgs(argv) {
  const options = { group: "all", shardIndex: 1, shardCount: 1, checkOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--group") options.group = argv[++i];
    else if (arg === "--shard") {
      const [index, count] = String(argv[++i] ?? "").split("/").map(Number);
      options.shardIndex = index;
      options.shardCount = count;
    } else if (arg === "--check-only") options.checkOnly = true;
    else throw new Error(`unknown argument '${arg}'`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = loadManifest();
  const files = listTestFiles();
  const errors = validateManifest(manifest, files);
  if (errors.length > 0) {
    for (const error of errors) console.error(`DB_TEST_MANIFEST ${error}`);
    process.exitCode = 1;
    return;
  }
  const groups = options.group === "all" ? GROUPS : [options.group];
  const selected = groups.flatMap((group) =>
    selectFiles(manifest, group, options.shardIndex, options.shardCount),
  );
  if (selected.length === 0) {
    console.error(`DB_TEST_EMPTY no test files selected for ${options.group} shard ${options.shardIndex}/${options.shardCount}`);
    process.exitCode = 1;
    return;
  }
  console.log(`db tests: ${options.group} shard ${options.shardIndex}/${options.shardCount} -> ${selected.length} files`);
  for (const file of selected) console.log(`  ${file}`);
  if (options.checkOnly) return;
  const result = spawnSync(
    "pnpm",
    ["exec", "tsx", "--test", "--test-concurrency=2", ...selected.map((file) => join(TEST_DIR, file))],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (result.error) {
    console.error(`DB_TEST_SPAWN ${result.error.message}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
