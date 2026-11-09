#!/usr/bin/env node
/**
 * ch08 §3.4 G2：迁移命名与 checksum 完整性门。
 *
 * 检查：
 *  1. 迁移目录名匹配 `^\d{14}_[a-z0-9_]+$`；
 *  2. 14 位时间戳唯一 —— Prisma 按时间戳+名称字典序重放，撞车会让合并顺序不确定；
 *     存量撞车（历史已应用，改名会破坏 checksum）登记在基线，新增撞车即红（ratchet）；
 *  3. 历史文件不可变性（权威口径）：文件内容必须与「把它加入仓库的提交」逐字节一致。
 *     只看库里的 checksum 不够——CI 每次空库重放，篡改后的文件会与自己自洽；只有 git 历史能证明改过。
 *  4. 对一次性库 `prisma migrate deploy` 后逐行校验 `_prisma_migrations.checksum` 等于迁移文件
 *     sha256（库与文件分叉 → 红；长期库的纵深防御）；存在失败/回滚行 → 红；库与仓库文件双向一致。
 *
 * 用法（CI 里 PRISMA_CIGATE_FROM_URL 缺省用 DATABASE_URL=global_test）：
 *   node packages/db/scripts/migration-integrity-gate.mjs
 *   node packages/db/scripts/migration-integrity-gate.mjs --write-baseline   # 重写撞车基线（人工评审）
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  assertDisposableDatabase,
  baselinesDir,
  deployMigrations,
  fail,
  loadDatabaseUrl,
  repoRoot,
  todayIsoDate,
  withPrismaClient,
} from './lib/gate-runtime.mjs';

const GATE = 'g2-migration-integrity';
const MIGRATIONS_DIR = resolve(import.meta.dirname, '../prisma/migrations');
const BASELINE_PATH = join(baselinesDir, 'g2-migration-integrity.json');
const NAME_PATTERN = /^\d{14}_[a-z0-9_]+$/;

function listMigrations() {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function duplicateTimestamps(migrations) {
  const byTimestamp = new Map();
  for (const name of migrations) {
    const timestamp = name.slice(0, 14);
    byTimestamp.set(timestamp, [...(byTimestamp.get(timestamp) ?? []), name]);
  }
  return [...byTimestamp.entries()]
    .filter(([, names]) => names.length > 1)
    .sort(([a], [b]) => a.localeCompare(b));
}

function checkNaming(migrations) {
  const problems = [];
  for (const name of migrations) {
    if (!NAME_PATTERN.test(name)) {
      problems.push(`迁移目录名不合规（需 ^\\d{14}_[a-z0-9_]+$）：migrations/${name}`);
    }
  }
  return problems;
}

function loadBaseline() {
  // 允许缺失：撞车基线为空即「当前不允许任何撞车」。
  if (!existsSync(BASELINE_PATH)) return { duplicateTimestamps: [] };
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (error) {
    fail(GATE, `baseline is not valid JSON: ${error.message}`);
  }
}

function checkDuplicates(gateDuplicates) {
  const baseline = loadBaseline();
  const entries = Array.isArray(baseline.duplicateTimestamps) ? baseline.duplicateTimestamps : [];
  const byTimestamp = new Map(entries.map((entry) => [entry.timestamp, entry]));
  const problems = [];
  const today = todayIsoDate();
  const seen = new Set();
  for (const [timestamp, names] of gateDuplicates) {
    seen.add(timestamp);
    const entry = byTimestamp.get(timestamp);
    if (!entry) {
      problems.push(
        `新增时间戳撞车 ${timestamp}: ${names.join(', ')} —— 新迁移请换一个未被占用的 14 位时间戳` +
          '（已应用迁移禁止改名，会破坏 checksum）。若确需保留，评审后登记进 ' +
          'docs/governance/ci-baselines/g2-migration-integrity.json（owner + 到期日）。',
      );
      continue;
    }
    const baselineNames = Array.isArray(entry.migrations) ? entry.migrations : [];
    if (baselineNames.join(',') !== names.join(',')) {
      problems.push(
        `撞车组 ${timestamp} 的成员发生变化（基线 [${baselineNames.join(', ')}] ≠ 当前 [${names.join(', ')}]）` +
          '—— 在已撞车的时间戳上新增迁移同样不允许；请换新时间戳并更新基线。',
      );
    }
    if (typeof entry.owner !== 'string' || typeof entry.expiresAt !== 'string') {
      problems.push(`基线条目 ${timestamp} 缺少 owner/expiresAt`);
    } else if (entry.expiresAt < today) {
      problems.push(`基线条目 ${timestamp} 已过期（${entry.expiresAt}，owner ${entry.owner}）`);
    }
  }
  for (const [timestamp, entry] of byTimestamp) {
    if (!seen.has(timestamp)) {
      problems.push(
        `基线条目 ${timestamp} 在当前迁移链中已不存在（ratchet：撞车修复后必须删除该条目）`,
      );
    }
  }
  return problems;
}

function fileSha256(name) {
  return createHash('sha256')
    .update(readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql')))
    .digest('hex');
}

/**
 * 历史文件不可变性（权威口径）：迁移文件内容必须与「把它加入仓库的那个提交」逐字节一致。
 * 为什么不能只靠库里的 checksum：CI 每次都是空库，篡改后的文件会被同一份内容重放，
 * 库里 checksum 与文件自洽——只有 git 历史能证明「文件被改过」。
 *
 * 存量豁免（棘轮）：gate 上线前有 13 个迁移在合入后被修改过（旧实践）。基线把这些文件的
 * **当前** sha256 钉死（`modifiedHistory`），此后任何修改（包括再次修改）都会红；
 * 条目只许收紧：若某文件已与加入提交一致（不再需要豁免），条目必须删除。
 */
function historySnapshot(migrations) {
  const entries = [];
  for (const name of migrations) {
    const path = `packages/db/prisma/migrations/${name}/migration.sql`;
    const log = spawnSync('git', ['log', '--diff-filter=A', '--format=%H', '-1', '--', path], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const commit = log.status === 0 ? log.stdout.trim().split('\n')[0] : '';
    let original = null;
    if (commit) {
      const blob = spawnSync('git', ['show', `${commit}:${path}`], {
        cwd: repoRoot,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (blob.status === 0) original = createHash('sha256').update(blob.stdout).digest('hex');
    }
    entries.push({ name, path, commit, original, current: fileSha256(name) });
  }
  return entries;
}

function checkHistoryImmutability(snapshot) {
  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (shallow.status !== 0 || shallow.stdout.trim() === 'true') {
    return ['仓库是浅克隆（或不是 git 仓库），无法校验迁移历史不可变性——checkout 需要 fetch-depth: 0。'];
  }
  const baseline = loadBaseline();
  const pinned = new Map(
    (Array.isArray(baseline.modifiedHistory) ? baseline.modifiedHistory : []).map((entry) => [
      entry.path,
      entry,
    ]),
  );
  const today = todayIsoDate();
  const problems = [];
  const usedPins = new Set();
  for (const entry of snapshot) {
    if (!entry.commit) {
      problems.push(`找不到把 ${entry.path} 加入仓库的提交（未跟踪或历史缺失）。`);
      continue;
    }
    if (entry.original === null) {
      problems.push(`git show ${entry.commit}:${entry.path} 失败，无法校验历史不可变性。`);
      continue;
    }
    if (entry.current === entry.original) continue;
    const pin = pinned.get(entry.path);
    if (!pin) {
      problems.push(
        `历史迁移文件被修改：${entry.name}（加入提交 ${entry.commit.slice(0, 12)} 的内容 ≠ 当前文件）` +
          ' —— 已应用迁移禁止改文件；需要变更请新增迁移。若为 gate 上线前的存量修改，' +
          '评审后登记进 docs/governance/ci-baselines/g2-migration-integrity.json 的 modifiedHistory（owner + 到期日）。',
      );
      continue;
    }
    usedPins.add(entry.path);
    if (pin.sha256 !== entry.current) {
      problems.push(
        `历史迁移文件再次被修改：${entry.name} —— 基线冻结的 sha256 ${pin.sha256} ≠ 当前 ${entry.current}。` +
          ' 已应用迁移禁止改文件；需要变更请新增迁移。',
      );
    }
    if (typeof pin.owner !== 'string' || typeof pin.expiresAt !== 'string') {
      problems.push(`基线 modifiedHistory 条目 ${entry.path} 缺少 owner/expiresAt`);
    } else if (pin.expiresAt < today) {
      problems.push(`基线 modifiedHistory 条目 ${entry.path} 已过期（${pin.expiresAt}，owner ${pin.owner}）`);
    }
  }
  for (const [path, pin] of pinned) {
    if (!usedPins.has(path)) {
      problems.push(
        `基线 modifiedHistory 条目 ${path} 已不再需要（文件与加入提交一致或文件已删除）——ratchet：必须删除该条目。`,
      );
    }
  }
  return problems;
}

async function checkAppliedHistory(databaseUrl, migrations) {
  const deploy = deployMigrations(databaseUrl);
  if (deploy.status !== 0) {
    return [
      'prisma migrate deploy 失败（历史文件被修改或迁移链不可重放）：\n' +
        `${deploy.stdout}\n${deploy.stderr}`.trim(),
    ];
  }
  const rows = await withPrismaClient(databaseUrl, (prisma) =>
    prisma.$queryRawUnsafe(
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at ASC',
    ),
  );
  const problems = [];
  const applied = new Set();
  for (const row of rows) {
    const name = row.migration_name;
    if (!migrations.includes(name)) {
      problems.push(`_prisma_migrations 含仓库中不存在的迁移：${name}（历史文件被删除？）`);
      continue;
    }
    applied.add(name);
    if (row.finished_at === null) {
      problems.push(`迁移未完成（finished_at IS NULL）：${name}`);
    }
    if (row.rolled_back_at !== null) {
      problems.push(`迁移被标记回滚（rolled_back_at 非空）：${name}`);
    }
    const expected = fileSha256(name);
    if (row.checksum !== expected) {
      problems.push(
        `历史迁移文件被修改：${name}（库 checksum ${row.checksum} ≠ 文件 sha256 ${expected}）` +
          ' —— 已应用迁移禁止改文件；需要变更请新增迁移。',
      );
    }
  }
  for (const name of migrations) {
    if (!applied.has(name)) {
      problems.push(`迁移未出现在 _prisma_migrations：${name}（deploy 未应用？）`);
    }
  }
  return problems;
}

function writeBaseline(gateDuplicates, snapshot) {
  const modifiedHistory = snapshot
    .filter((entry) => entry.original !== null && entry.current !== entry.original)
    .map((entry) => ({
      path: entry.path,
      sha256: entry.current,
      owner: 'P6-CI-01',
      expiresAt: '2027-01-31',
      reason:
        'gate 上线前的存量修改（旧实践）；自本基线起内容冻结，任何再次修改（含恢复旧内容）都红',
    }));
  const payload = {
    $comment:
      'G2 基线：时间戳撞车（历史已应用、改名会破坏 checksum）与 gate 上线前被修改过的迁移文件（内容冻结）。只许收紧：修复/退役后必须删除条目。',
    duplicateTimestamps: gateDuplicates.map(([timestamp, names]) => ({
      timestamp,
      migrations: names,
      owner: 'P6-CI-01',
      expiresAt: '2027-01-31',
      reason: '历史迁移已应用，改名会破坏 _prisma_migrations.checksum；新迁移必须使用唯一时间戳',
    })),
    modifiedHistory,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `[${GATE}] wrote ${payload.duplicateTimestamps.length} duplicate-timestamp entries, ${modifiedHistory.length} frozen-history entries → ${BASELINE_PATH}`,
  );
}

async function main() {
  const migrations = listMigrations();
  const gateDuplicates = duplicateTimestamps(migrations);
  const snapshot = historySnapshot(migrations);
  if (process.argv.includes('--write-baseline')) {
    writeBaseline(gateDuplicates, snapshot);
    return;
  }

  const problems = [
    ...checkNaming(migrations),
    ...checkDuplicates(gateDuplicates),
    ...checkHistoryImmutability(snapshot),
  ];
  const databaseUrl = assertDisposableDatabase(GATE, loadDatabaseUrl(GATE));
  problems.push(...(await checkAppliedHistory(databaseUrl, migrations)));

  if (problems.length > 0) {
    console.error(`[${GATE}] FAILED`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `[${GATE}] OK — ${migrations.length} 个迁移：命名合规、时间戳撞车均在基线（${gateDuplicates.length} 组）、历史文件未被修改、库 checksum 与文件一致。`,
  );
}

main().catch((error) => {
  fail(GATE, error instanceof Error ? error.message : String(error));
});

export { duplicateTimestamps, listMigrations };
