import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'recall-audit.mjs');
const FRAME = join(HERE, 'fixtures', 'recall-frame.sample.json');
const POOL = join(HERE, 'fixtures', 'recall-pool.sample.json');

function run(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('recall-audit CLI: census report on the sample fixtures', () => {
  const output = run(['--frame', FRAME, '--pool', POOL, '--period', '2026-11', '--json']);
  const payload = JSON.parse(output);
  assert.equal(payload.meta.period, '2026-11');
  assert.equal(payload.result.sample.sampled, false);
  assert.equal(payload.result.totals.N, 8);
  assert.equal(payload.result.totals.n, 8);
  assert.equal(payload.result.totals.found, 4);
  assert.equal(payload.result.totals.domainResolved, 3);
  assert.equal(payload.result.totals.contactFound, 2);
  assert.equal(payload.result.missed, 4);
  const strata = payload.result.strata.map((stratum) => stratum.stratumKey);
  assert.deepEqual(strata, ['DE:28:10-49', 'DE:28:50-249']);
  const low = payload.result.strata[0];
  assert.equal(low.found, 3);
  assert.ok(low.recall.low < low.recall.estimate && low.recall.estimate < low.recall.high);
});

test('recall-audit CLI: deterministic sampling with a fixed seed', () => {
  const first = JSON.parse(
    run(['--frame', FRAME, '--pool', POOL, '--period', '2026-11', '--sample', '2', '--seed', '2026-11', '--json']),
  );
  const second = JSON.parse(
    run(['--frame', FRAME, '--pool', POOL, '--period', '2026-11', '--sample', '2', '--seed', '2026-11', '--json']),
  );
  assert.deepEqual(first.result.strata, second.result.strata);
  assert.equal(first.result.sample.size, 2);
  for (const stratum of first.result.strata) assert.equal(stratum.n, 2);
});

test('recall-audit CLI: writes markdown and json report files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-audit-'));
  try {
    const output = run(['--frame', FRAME, '--pool', POOL, '--period', '2026-11', '--out', dir]);
    const base = join(dir, 'recall-2026-11');
    assert.equal(output.trim(), `${base}.md\n${base}.json`);
    const markdown = readFileSync(`${base}.md`, 'utf8');
    assert.match(markdown, /# 召回审计报告 · 2026-11/u);
    assert.match(markdown, /\| DE:28:10-49 \| 4 \| 4 \| 3 \|/u);
    const payload = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
    assert.equal(payload.result.totals.found, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recall-audit CLI: fails closed on missing or invalid arguments', () => {
  assert.throws(() => run(['--frame', FRAME]), /--pool/u);
  assert.throws(() => run(['--frame', resolve(HERE, 'missing.json'), '--pool', POOL]), /读取/u);
  assert.throws(() => run(['--frame', FRAME, '--pool', POOL, '--sample', '0']), /sample/u);
});
