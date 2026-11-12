#!/usr/bin/env node
/**
 * G16 模块依赖边界（2026-11-12，CA-1）：只许收紧。
 *
 * 从 `apps/api/src/**` 的**运行时**相对 import 建模块对（跳过 `import type` /
 * `export type`）；基线 `docs/governance/ci-baselines/g16-module-boundaries.json`
 * 记录当前全部模块对。新增跨模块运行时边必须显式更新基线（评审可见），
 * 已消失的边给出提示但不阻断（减少耦合不需要审批）。
 *
 * 用法：
 *   node scripts/governance-module-boundaries.mjs verify
 *   node scripts/governance-module-boundaries.mjs --write-baseline
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = 'g16-module-boundaries';
const SCHEMA = 'g16-module-boundaries/v1';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = 'docs/governance/ci-baselines/g16-module-boundaries.json';

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
const fileSet = new Set(files);

function moduleOf(path) {
  const parts = path.split('/');
  return parts.length > 4 ? parts[3] : '(root)';
}

function resolveSpecifier(from, specifier) {
  const base = resolve(repoRoot, dirname(from), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
  ]) {
    if (existsSync(candidate)) {
      return candidate.slice(repoRoot.length + 1);
    }
  }
  return null;
}

const statement = /(?:^|\n)\s*(?:import|export)\s+([^;]*?)\bfrom\s+['"](\.[^'"]+)['"]/gu;
const sideEffect = /(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/gu;
const dynamicImport = /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/gu;

const edges = new Map();
function addEdge(fromFile, specifier) {
  const toFile = resolveSpecifier(fromFile, specifier);
  if (!toFile || !fileSet.has(toFile)) return;
  const from = moduleOf(fromFile);
  const to = moduleOf(toFile);
  if (from === to) return;
  const key = `${from} -> ${to}`;
  edges.set(key, (edges.get(key) ?? 0) + 1);
}

for (const file of files) {
  const text = readFileSync(join(repoRoot, file), 'utf8');
  for (const match of text.matchAll(statement)) {
    const clause = match[1].trim();
    if (clause === 'type' || clause.startsWith('type ')) continue;
    addEdge(file, match[2]);
  }
  for (const match of text.matchAll(sideEffect)) addEdge(file, match[1]);
  for (const match of text.matchAll(dynamicImport)) addEdge(file, match[1]);
}

const sorted = [...edges.entries()].sort(([a], [b]) => a.localeCompare(b));

if (process.argv[2] === '--write-baseline') {
  const baseline = {
    $comment:
      'G16：apps/api 运行时跨模块依赖对基线（按 from -> to 去重）。新增对必须显式更新本文件；消失的对不阻断。',
    schemaVersion: SCHEMA,
    generatedFrom: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim(),
    pairs: sorted.map(([pair]) => {
      const [from, to] = pair.split(' -> ');
      return { from, to };
    }),
  };
  writeFileSync(
    join(repoRoot, BASELINE_PATH),
    `${JSON.stringify(baseline, null, 2)}\n`,
  );
  console.log(`[${GATE}] baseline written: ${sorted.length} module pairs`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(join(repoRoot, BASELINE_PATH), 'utf8'));
if (baseline.schemaVersion !== SCHEMA) {
  console.error(`[${GATE}] baseline schemaVersion must be ${SCHEMA}`);
  process.exit(1);
}
const known = new Set(baseline.pairs.map(({ from, to }) => `${from} -> ${to}`));
const issues = sorted.filter(([pair]) => !known.has(pair));
const removed = [...known].filter((pair) => !edges.has(pair));
if (issues.length > 0) {
  for (const [pair, count] of issues) {
    console.error(
      `[${GATE}] new runtime module dependency: ${pair} (${count} import(s)); update ${BASELINE_PATH} after review`,
    );
  }
  process.exit(1);
}
console.log(
  `[${GATE}] ${sorted.length} runtime module pairs (baseline ${known.size}); no new edges${removed.length ? `; ${removed.length} baseline edge(s) removed (informational)` : ''}`,
);
