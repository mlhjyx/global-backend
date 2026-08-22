import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const repositoryRoot = resolve(new URL('..', import.meta.url).pathname);
const base = process.argv[2];
const coveragePath = resolve(repositoryRoot, process.argv[3] ?? 'apps/api/coverage/coverage-final.json');
const threshold = Number(process.argv[4] ?? 80);

if (!/^[0-9a-f]{7,40}$/u.test(base ?? '') || !Number.isFinite(threshold)) {
  throw new Error('usage: node scripts/task4-changed-scope-coverage.mjs <base-commit> [coverage-final.json] [threshold]');
}

function git(...args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function changedLines(path) {
  const lines = new Set();
  const diff = git('diff', '--unified=0', '--no-color', base, '--', path);
  for (const line of diff.split('\n')) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let offset = 0; offset < count; offset += 1) lines.add(start + offset);
  }
  return lines;
}

function overlaps(location, lines) {
  const start = location?.start?.line;
  const end = location?.end?.line ?? start;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
  for (let line = start; line <= end; line += 1) {
    if (lines.has(line)) return true;
  }
  return false;
}

function percentage(covered, total) {
  return total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2));
}

const changedPaths = git('diff', '--name-only', base, '--', 'apps/api/src')
  .trim()
  .split('\n')
  .filter((path) => path.endsWith('.ts') && !path.endsWith('.spec.ts'));
const coverage = JSON.parse(await readFile(coveragePath, 'utf8'));
const coverageByPath = new Map(Object.entries(coverage).map(([absolutePath, entry]) => [
  relative(repositoryRoot, absolutePath),
  entry,
]));

const totals = {
  statements: { covered: 0, total: 0 },
  branches: { covered: 0, total: 0 },
};
const files = [];
for (const path of changedPaths) {
  const changed = changedLines(path);
  const entry = coverageByPath.get(path);
  if (!entry) throw new Error(`coverage entry missing for changed path ${path}`);
  let statementTotal = 0;
  let statementCovered = 0;
  for (const [id, location] of Object.entries(entry.statementMap ?? {})) {
    if (!overlaps(location, changed)) continue;
    statementTotal += 1;
    if ((entry.s?.[id] ?? 0) > 0) statementCovered += 1;
  }
  let branchTotal = 0;
  let branchCovered = 0;
  for (const [id, branch] of Object.entries(entry.branchMap ?? {})) {
    const hits = entry.b?.[id] ?? [];
    for (const [index, location] of (branch.locations ?? []).entries()) {
      if (!overlaps(location, changed)) continue;
      branchTotal += 1;
      if ((hits[index] ?? 0) > 0) branchCovered += 1;
    }
  }
  totals.statements.covered += statementCovered;
  totals.statements.total += statementTotal;
  totals.branches.covered += branchCovered;
  totals.branches.total += branchTotal;
  files.push({
    path,
    changedLines: changed.size,
    statements: {
      covered: statementCovered,
      total: statementTotal,
      percentage: percentage(statementCovered, statementTotal),
    },
    branches: {
      covered: branchCovered,
      total: branchTotal,
      percentage: percentage(branchCovered, branchTotal),
    },
  });
}

const result = {
  schemaVersion: 'task4-changed-scope-coverage/v1',
  base,
  head: git('rev-parse', 'HEAD').trim(),
  coveragePath: relative(repositoryRoot, coveragePath),
  files,
  totals: {
    statements: {
      ...totals.statements,
      percentage: percentage(totals.statements.covered, totals.statements.total),
    },
    branches: {
      ...totals.branches,
      percentage: percentage(totals.branches.covered, totals.branches.total),
    },
  },
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (
  result.totals.statements.percentage < threshold ||
  result.totals.branches.percentage < threshold
) {
  process.exitCode = 1;
}
