#!/usr/bin/env node
/**
 * G10：API Postgres 套件覆盖门（2026-11-12，K-2）。
 *
 * 每个 `apps/api/src/**\/*.postgres.spec.ts` 必须满足其一：
 *   1. 在 `.github/workflows/ci.yml` 中以 `src/...postgres.spec.ts` 形式被显式调用；
 *   2. 登记在 `docs/governance/ci-baselines/g10-api-postgres-suites.json` 的 exemptions 中，
 *      且必须带 reason / owner / expiresAt。
 *
 * 失败条件：套件既不在 CI 也未登记；豁免缺字段或重复；豁免已过期；豁免指向的文件已消失。
 * 目的：让「手工运行、不在 CI」成为显式且会过期的豁免，而不是默认状态。只许收紧。
 *
 * 用法：node scripts/governance-api-postgres-coverage.mjs verify
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = 'g10-api-postgres';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CI_PATH = '.github/workflows/ci.yml';
const BASELINE_PATH =
  'docs/governance/ci-baselines/g10-api-postgres-suites.json';
const SCHEMA = 'g10-api-postgres-suites/v1';

function fail(message) {
  console.error(`[${GATE}] ${message}`);
  process.exit(1);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

const command = process.argv[2] ?? 'verify';
if (command !== 'verify') fail(`unknown command '${command}' (expected verify)`);

const specs = execFileSync('git', ['ls-files', '-z', 'apps/api/src'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter((path) => path.endsWith('.postgres.spec.ts'))
  .sort();
if (specs.length === 0) fail('no *.postgres.spec.ts found under apps/api/src');

const ciText = readFileSync(join(repoRoot, CI_PATH), 'utf8');
const baseline = JSON.parse(readFileSync(join(repoRoot, BASELINE_PATH), 'utf8'));
if (baseline.schemaVersion !== SCHEMA) {
  fail(`baseline schemaVersion must be ${SCHEMA}`);
}

const exemptions = new Map();
for (const entry of baseline.exemptions ?? []) {
  if (
    !entry ||
    typeof entry.file !== 'string' ||
    typeof entry.reason !== 'string' ||
    entry.reason.trim() === '' ||
    typeof entry.owner !== 'string' ||
    entry.owner.trim() === '' ||
    typeof entry.expiresAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(entry.expiresAt)
  ) {
    fail('every exemption needs file, reason, owner and YYYY-MM-DD expiresAt');
  }
  if (exemptions.has(entry.file)) fail(`duplicate exemption for ${entry.file}`);
  exemptions.set(entry.file, entry);
}

const issues = [];
const exempted = [];
for (const spec of specs) {
  const ciPath = spec.replace(/^apps\/api\//u, '');
  const exemption = exemptions.get(spec);
  if (exemption) {
    if (exemption.expiresAt < today()) {
      issues.push(
        `${spec}: exemption expired on ${exemption.expiresAt} (${exemption.owner})`,
      );
    }
    exempted.push(spec);
    continue;
  }
  if (!ciText.includes(ciPath)) {
    issues.push(
      `${spec}: not referenced in ${CI_PATH} and no baseline exemption`,
    );
  }
}
for (const file of exemptions.keys()) {
  if (!specs.includes(file)) {
    issues.push(`${file}: exemption exists but the spec file is gone`);
  }
}

if (issues.length > 0) {
  for (const issue of issues) console.error(`[${GATE}] ${issue}`);
  process.exit(1);
}

console.log(
  `[${GATE}] ${specs.length} postgres suites: ${specs.length - exempted.length} referenced in CI, ${exempted.length} exempted`,
);
