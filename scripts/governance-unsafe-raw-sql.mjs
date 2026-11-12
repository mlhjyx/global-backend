#!/usr/bin/env node
/**
 * G17 Raw SQL 安全约束（2026-11-12，CA-8）：只许收紧。
 *
 * `$queryRawUnsafe` / `$executeRawUnsafe` 的能力无法由调用点参数化保证。
 * 基线 `docs/governance/ci-baselines/g17-unsafe-raw-sql.json` 记录当前生产代码
 * 每文件数量；超出基线的新调用必须带 `// unsafe-reason: <常量/白名单/参数化>`
 * 注释（同一行或前 3 行），否则失败。已消失文件的基线条目必须删除。
 *
 * 用法：
 *   node scripts/governance-unsafe-raw-sql.mjs verify
 *   node scripts/governance-unsafe-raw-sql.mjs --write-baseline
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = 'g17-unsafe-raw-sql';
const SCHEMA = 'g17-unsafe-raw-sql/v1';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = 'docs/governance/ci-baselines/g17-unsafe-raw-sql.json';
const PATTERN = /\$(?:queryRawUnsafe|executeRawUnsafe)\b/gu;
const ANNOTATION = 'unsafe-reason:';

const files = execFileSync('git', ['ls-files', '-z', 'apps/api/src'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter(
    (path) =>
      path.endsWith('.ts') &&
      !/\.(spec|test)\.ts$/u.test(path) &&
      !path.endsWith('.d.ts'),
  )
  .sort();

const counts = new Map();
const occurrences = new Map();
for (const file of files) {
  const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');
  const found = [];
  lines.forEach((line, index) => {
    const matches = [...line.matchAll(PATTERN)];
    if (matches.length === 0) return;
    const annotated = lines
      .slice(Math.max(0, index - 3), index + 1)
      .some((candidate) => candidate.includes(ANNOTATION));
    found.push({ line: index + 1, annotated, count: matches.length });
  });
  if (found.length > 0) {
    counts.set(file, found.reduce((sum, item) => sum + item.count, 0));
    occurrences.set(file, found);
  }
}

if (process.argv[2] === '--write-baseline') {
  const baseline = {
    $comment:
      'G17：apps/api 生产代码 $queryRawUnsafe/$executeRawUnsafe 每文件基线；新增调用须带 unsafe-reason 注释。',
    schemaVersion: SCHEMA,
    generatedFrom: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim(),
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    files: Object.fromEntries([...counts.entries()].sort()),
  };
  writeFileSync(
    join(repoRoot, BASELINE_PATH),
    `${JSON.stringify(baseline, null, 2)}\n`,
  );
  console.log(
    `[${GATE}] baseline written: ${baseline.files ? Object.keys(baseline.files).length : 0} files / ${baseline.total} calls`,
  );
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(join(repoRoot, BASELINE_PATH), 'utf8'));
if (baseline.schemaVersion !== SCHEMA) {
  console.error(`[${GATE}] baseline schemaVersion must be ${SCHEMA}`);
  process.exit(1);
}
const allowed = baseline.files ?? {};
const issues = [];
for (const [file, found] of occurrences) {
  const allowance = allowed[file] ?? 0;
  let seen = 0;
  for (const item of found) {
    for (let i = 0; i < item.count; i += 1) {
      seen += 1;
      if (seen > allowance && !item.annotated) {
        issues.push(
          `${file}:${item.line}: unsafe raw SQL beyond baseline without '// unsafe-reason:' (allowed ${allowance})`,
        );
      }
    }
  }
}
for (const file of Object.keys(allowed)) {
  if (!counts.has(file)) issues.push(`${file}: baseline entry exists but file has no unsafe raw SQL; remove it`);
}
if (issues.length > 0) {
  for (const issue of issues) console.error(`[${GATE}] ${issue}`);
  process.exit(1);
}
const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
console.log(
  `[${GATE}] ${total} unsafe raw SQL calls in ${counts.size} production files (baseline ${baseline.total}); no unannotated additions`,
);
