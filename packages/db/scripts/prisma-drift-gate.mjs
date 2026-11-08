#!/usr/bin/env node
/**
 * ch08 §3.1.7 Prisma 漂移门：迁移链（--from-migrations）⇄ Prisma datamodel 的差异必须为零，
 * 已知差异按「基线允许清单」逐条登记（owner + 到期日），新增漂移即红。
 *
 * 为什么用 --from-migrations 而不是 --from-url：本门的职责是「datamodel 与迁移文件一致」，
 * 不依赖任何一套已应用的数据库；影子库只用来重放迁移链。
 *
 * 基线（packages/db/prisma/drift-baseline.json）是 ratchet：
 *  - 出现清单外的差异语句 → 失败（新增 SQL-only 表/列/索引 → 先补 datamodel 或登记，二选一并写明 owner/到期）；
 *  - 清单内的条目在当前差异中消失 → 失败（要求删除过期条目，清单只许收紧）；
 *  - 条目过期（expiresAt < 今天）→ 失败（补 datamodel 或书面续期）。
 *
 * 用法：
 *   node packages/db/scripts/prisma-drift-gate.mjs                 # 检查（CI/本地）
 *   node packages/db/scripts/prisma-drift-gate.mjs --write-baseline  # 以当前差异重写基线（人工评审后提交）
 *
 * env：DATABASE_URL（必填，CI 指向 postgres service；本地可用 packages/db/.env）；
 *      PRISMA_DRIFT_SHADOW_DB（可选，影库名，默认 prisma_drift_shadow）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');
const dbPackageDir = resolve(repoRoot, 'packages/db');
const migrationsDir = resolve(dbPackageDir, 'prisma/migrations');
const schemaPath = resolve(dbPackageDir, 'prisma/schema.prisma');
const baselinePath = resolve(dbPackageDir, 'prisma/drift-baseline.json');

function fatal(message) {
  console.error(`[prisma-drift-gate] ${message}`);
  process.exit(1);
}

function loadDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = resolve(dbPackageDir, '.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const match = /^\s*DATABASE_URL\s*=\s*(.*)$/.exec(line);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  fatal('DATABASE_URL is required (env or packages/db/.env)');
}

function withDatabase(rawUrl, databaseName) {
  const url = new URL(rawUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function shadowDatabaseName() {
  const name = process.env.PRISMA_DRIFT_SHADOW_DB ?? 'prisma_drift_shadow';
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) fatal(`invalid shadow database name: ${name}`);
  return name;
}

function prisma(args, { input } = {}) {
  const result = spawnSync(
    'pnpm',
    ['--filter', '@global/db', 'exec', 'prisma', ...args],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      input,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error) fatal(`failed to run prisma: ${result.error.message}`);
  return result;
}

function ensureShadowDatabase(adminUrl, name) {
  const result = prisma(['db', 'execute', '--url', adminUrl, '--stdin'], {
    input: `CREATE DATABASE "${name}";\n`,
  });
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0) return;
  // 并发/残留：库已存在即可继续（Prisma 会重置其中的对象）。
  if (/already exists/i.test(combined)) return;
  fatal(`cannot create shadow database ${name}:\n${combined.trim()}`);
}

function dropShadowDatabase(adminUrl, name) {
  prisma(['db', 'execute', '--url', adminUrl, '--stdin'], {
    input: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);\n`,
  });
}

/**
 * 极简 SQL 语句切分：识别单引号、双引号、$tag$ 美元引用与行/块注释，只在顶层 `;` 切分。
 * 迁移差异只含 DDL，不需要完整 SQL 解析器；但函数体/默认值里的分号不能误切。
 */
export function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end;
      current += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      current += ' ';
      continue;
    }
    if (ch === "'") {
      current += ch;
      i += 1;
      while (i < n) {
        current += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            current += sql[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      current += ch;
      i += 1;
      while (i < n) {
        current += sql[i];
        if (sql[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end !== -1) {
          current += sql.slice(i, end + tag.length);
          i = end + tag.length;
          continue;
        }
      }
    }
    if (ch === ';') {
      statements.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  statements.push(current);
  return statements
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.endsWith(';') ? s : `${s};`));
}

function currentDiff(adminUrl, shadowUrl, name) {
  ensureShadowDatabase(adminUrl, name);
  try {
    const result = prisma([
      'migrate',
      'diff',
      '--from-migrations',
      migrationsDir,
      '--to-schema-datamodel',
      schemaPath,
      '--shadow-database-url',
      shadowUrl,
      '--script',
    ]);
    if (result.status !== 0) {
      fatal(`prisma migrate diff failed:\n${result.stdout}\n${result.stderr}`.trim());
    }
    return splitSqlStatements(result.stdout);
  } finally {
    dropShadowDatabase(adminUrl, name);
  }
}

function loadBaseline() {
  if (!existsSync(baselinePath)) return { knownDifferences: [] };
  try {
    const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
    if (!Array.isArray(parsed.knownDifferences)) fatal('baseline missing knownDifferences[]');
    return parsed;
  } catch (error) {
    fatal(`baseline is not valid JSON: ${error.message}`);
  }
}

function statementKey(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function check(produced) {
  const baseline = loadBaseline();
  const byKey = new Map();
  for (const entry of baseline.knownDifferences) {
    if (typeof entry.statement !== 'string' || typeof entry.owner !== 'string' || typeof entry.expiresAt !== 'string') {
      fatal('each baseline entry needs statement/owner/expiresAt');
    }
    const key = statementKey(entry.statement);
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }

  const today = new Date().toISOString().slice(0, 10);
  const problems = [];

  const producedKeys = new Set(produced.map(statementKey));
  for (const key of producedKeys) {
    const entries = byKey.get(key);
    if (!entries) {
      problems.push(`UNREGISTERED DIFF: ${key}`);
      continue;
    }
    for (const entry of entries) {
      if (entry.expiresAt < today) {
        problems.push(`EXPIRED baseline entry (${entry.expiresAt}, owner ${entry.owner}): ${key}`);
      }
    }
  }
  for (const [key, entries] of byKey) {
    if (!producedKeys.has(key)) {
      problems.push(
        `STALE baseline entry (no longer in diff — drop it; owner ${entries[0].owner}): ${key}`,
      );
    }
  }

  if (problems.length > 0) {
    console.error('[prisma-drift-gate] FAILED');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      '修复方式：把 SQL-only 结构补进 packages/db/prisma/schema.prisma（推荐），或经评审后登记进 packages/db/prisma/drift-baseline.json（带 owner 与到期日）。',
    );
    process.exit(1);
  }
  const known = baseline.knownDifferences.length;
  console.log(
    `[prisma-drift-gate] OK — datamodel ⇄ migrations 无未登记差异（基线已知差异 ${known} 条，均有 owner/到期日）。`,
  );
}

function writeBaseline(produced) {
  const entries = produced.map((statement) => ({
    statement,
    owner: 'P5c-BE-30',
    expiresAt: '2027-01-31',
    reason: 'SQL-only structure pre-dating the drift gate (ch08 §3.1.7)',
  }));
  const payload = {
    $comment:
      '已知 datamodel ⇄ migrations 差异（ch08 §3.1.7 基线）。只许收紧：条目修复后必须删除；expiresAt 到期即红。',
    knownDifferences: entries,
  };
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`[prisma-drift-gate] wrote ${entries.length} entries → ${baselinePath}`);
}

function main() {
  const databaseUrl = loadDatabaseUrl();
  const shadowName = shadowDatabaseName();
  const adminUrl = withDatabase(databaseUrl, 'postgres');
  const shadowUrl = withDatabase(databaseUrl, shadowName);

  const produced = currentDiff(adminUrl, shadowUrl, shadowName);
  if (process.argv.includes('--write-baseline')) {
    writeBaseline(produced);
    return;
  }
  check(produced);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { currentDiff, loadBaseline, statementKey };
