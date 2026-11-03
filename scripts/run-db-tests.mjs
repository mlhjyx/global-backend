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
export const GROUPS = ["service", "isolated", "manual", "static"];

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

/** 把连接串里的数据库名替换为 db（保留凭据、主机与参数）。 */
export function rewriteDatabaseUrl(url, db) {
  const parsed = new URL(url);
  parsed.pathname = `/${db}`;
  return parsed.toString();
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
  if (options.group === "manual") {
    console.log("manual group: 需要外部预置容器的测试只登记、不在 CI 运行；按文件头注释中的环境变量手工执行。");
    return;
  }
  if (options.group === "service") {
    runServiceGroup(selected);
    return;
  }
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

/**
 * service 组的测试会重置 schema、创建临时库或断言全局角色，
 * 共享一个库时互相污染；每个文件使用独立的新库并串行执行。
 */
function runServiceGroup(files) {
  const adminUrl = process.env.DATABASE_URL;
  const appUrl = process.env.APP_DATABASE_URL;
  if (!adminUrl) {
    console.error("DB_TEST_ENV DATABASE_URL is required for the service group");
    process.exitCode = 1;
    return;
  }
  const prisma = ["--filter", "@global/db", "exec", "prisma"];
  const runPsql = (url, sql) =>
    spawnSync("pnpm", [...prisma, "db", "execute", "--url", url, "--stdin"], {
      cwd: REPO_ROOT,
      input: sql,
      encoding: "utf8",
    });
  let failed = false;
  for (const [index, file] of files.entries()) {
    const db = `global_test_svc_${process.pid}_${index}`;
    const ownerUrl = rewriteDatabaseUrl(adminUrl, db);
    const perFileAppUrl = appUrl ? rewriteDatabaseUrl(appUrl, db) : ownerUrl;
    console.log(`db tests: service file ${index + 1}/${files.length} -> ${file} (db ${db})`);
    const created = runPsql(adminUrl, `CREATE DATABASE "${db}";`);
    if (created.status !== 0) {
      console.error(`DB_TEST_CREATE ${file}: ${created.stderr || created.stdout}`);
      failed = true;
      continue;
    }
    const migrated = spawnSync("pnpm", [...prisma, "migrate", "deploy"], {
      cwd: REPO_ROOT,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: ownerUrl },
    });
    const tested =
      migrated.status === 0
        ? spawnSync("pnpm", ["exec", "tsx", "--test", "--test-concurrency=1", join(TEST_DIR, file)], {
            cwd: REPO_ROOT,
            stdio: "inherit",
            env: { ...process.env, DATABASE_URL: ownerUrl, APP_DATABASE_URL: perFileAppUrl },
          })
        : { status: 1 };
    if (migrated.status !== 0) console.error(`DB_TEST_MIGRATE ${file}`);
    const dropped = runPsql(adminUrl, `DROP DATABASE IF EXISTS "${db}" WITH (FORCE);`);
    if (dropped.status !== 0) {
      console.error(`DB_TEST_DROP ${file}: ${dropped.stderr || dropped.stdout}`);
    }
    if (tested.status !== 0) {
      console.error(`DB_TEST_FAIL ${file}`);
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
