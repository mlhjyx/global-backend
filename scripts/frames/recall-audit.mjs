#!/usr/bin/env node
/**
 * 召回审计脚手架 CLI（GainOS v3.0 ch03 §3.17 Tier A 子集）。
 *
 * 给定「目标市场 frame 导出」与「一次 run 的产出池导出」，计算分层覆盖率/召回估计
 * （Wilson 95% CI），可选给环比与 miss 归因，输出固定模板报告（Markdown + JSON）。
 *
 * 计算逻辑在 apps/api/src/registry/recall-audit.ts（vitest 覆盖），本文件只做
 * 参数解析、文件 IO 与输出。Node ≥22.18 原生 type-strip 可直接运行；
 * 更老的 Node 用 `pnpm exec tsx scripts/frames/recall-audit.mjs`。
 *
 * 用法：
 *   node scripts/frames/recall-audit.mjs \
 *     --frame scripts/frames/fixtures/recall-frame.sample.json \
 *     --pool  scripts/frames/fixtures/recall-pool.sample.json \
 *     --period 2026-11 --sample 384 --seed 2026-11 \
 *     [--baseline <上一期报告.json>] [--verdicts <裁决.json>] \
 *     --out /tmp/recall-audit
 *
 * 输入格式：
 *   frame:   [{scheme, regNumber, country, name?, nace?, employeeBand?}, ...]
 *   pool:    [{registryScheme?, registryNumber?, domain?, contactFound?, contacts?, name?}, ...]
 *   baseline: 本 CLI 之前产出的报告 JSON（含 meta.period 与 result）
 *   verdicts: [{scheme, regNumber, missReason}, ...]（或 {verdicts: [...]}）
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  auditRecall,
  compareRecallAudit,
  renderRecallReportMarkdown,
  summarizeMissReasons,
} from '../../apps/api/src/registry/recall-audit.ts';

function fail(message) {
  process.stderr.write(`recall-audit: ${message}\n`);
  process.exit(1);
}

function readJson(path, what) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    fail(`读取 ${what} 失败（${path}）：${error.message}`);
  }
}

function readJsonArray(path, what) {
  const parsed = readJson(path, what);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.entities)) return parsed.entities;
  if (parsed && Array.isArray(parsed.records)) return parsed.records;
  if (parsed && Array.isArray(parsed.verdicts)) return parsed.verdicts;
  fail(`${what} 必须是数组（或 {entities: []} / {records: []} / {verdicts: []}）：${path}`);
}

const { values } = parseArgs({
  options: {
    frame: { type: 'string' },
    pool: { type: 'string' },
    period: { type: 'string' },
    sample: { type: 'string' },
    seed: { type: 'string' },
    baseline: { type: 'string' },
    verdicts: { type: 'string' },
    'delta-threshold': { type: 'string' },
    'frame-key': { type: 'string' },
    'snapshot-id': { type: 'string' },
    'pool-source': { type: 'string' },
    out: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  process.stdout.write(
    'usage: node scripts/frames/recall-audit.mjs --frame <frame.json> --pool <pool.json> [--period YYYY-MM] [--sample N --seed S] [--baseline prev-report.json] [--verdicts verdicts.json] [--out DIR] [--json]\n',
  );
  process.exit(0);
}
if (!values.frame || !values.pool) {
  fail('必须同时提供 --frame 与 --pool（--help 查看用法）');
}

const period = values.period ?? new Date().toISOString().slice(0, 7);
let sampleSize = null;
if (values.sample !== undefined) {
  sampleSize = Number(values.sample);
  if (!Number.isInteger(sampleSize) || sampleSize <= 0) {
    fail(`--sample 必须是正整数，收到 ${values.sample}`);
  }
}
const seed = sampleSize !== null ? (values.seed ?? period) : (values.seed ?? null);

let thresholdPp = 5;
if (values['delta-threshold'] !== undefined) {
  thresholdPp = Number(values['delta-threshold']);
  if (!Number.isFinite(thresholdPp) || thresholdPp <= 0) {
    fail(`--delta-threshold 必须是正数，收到 ${values['delta-threshold']}`);
  }
}

const frame = readJsonArray(values.frame, '--frame');
const pool = readJsonArray(values.pool, '--pool');
const result = auditRecall({ frame, pool, sampleSize, seed });

let comparison;
if (values.baseline !== undefined) {
  const baseline = readJson(values.baseline, '--baseline');
  if (!baseline || typeof baseline !== 'object' || !baseline.result || !Array.isArray(baseline.result.strata)) {
    fail('--baseline 不是本 CLI 产出的报告 JSON（缺 result.strata）');
  }
  comparison = compareRecallAudit(
    result,
    baseline.result,
    typeof baseline.meta?.period === 'string' ? baseline.meta.period : null,
    thresholdPp,
  );
}

let missReasons;
if (values.verdicts !== undefined) {
  missReasons = summarizeMissReasons(result.missedKeys, readJsonArray(values.verdicts, '--verdicts'));
}

const meta = {
  period,
  frameKey: values['frame-key'] ?? null,
  frameSnapshotId: values['snapshot-id'] ?? null,
  poolSource: values['pool-source'] ?? values.pool,
  generatedAt: new Date().toISOString(),
};
const markdown = renderRecallReportMarkdown(result, meta, { comparison, missReasons });
const payload = {
  meta,
  materializedAt: meta.generatedAt,
  result,
  ...(comparison !== undefined ? { comparison } : {}),
  ...(missReasons !== undefined ? { missReasons } : {}),
};

if (values.json) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else if (values.out) {
  mkdirSync(resolve(values.out), { recursive: true });
  const base = join(resolve(values.out), `recall-${period}`);
  writeFileSync(`${base}.md`, markdown, 'utf8');
  writeFileSync(`${base}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(`${base}.md\n${base}.json\n`);
} else {
  process.stdout.write(markdown);
}
