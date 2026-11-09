/**
 * 模型层评测跑批（P3 J19 第一批；设计 §4.3.10.2）。
 *
 * 默认 **dry 模式**：不调用模型，跑完金标清单的确定性链路（schema → 证据 → 聚合），
 * 产出 eval-receipt/v1 回执（指标目前是「确定性链路 vs 期望」，模型层数字待真实跑批）。
 * 真实模型跑批需要预算授权与网关凭据（用户决策项）：`GAINOS_JUDGE_EVAL_LIVE=1`
 * 会显式拒绝——本卡只交付骨架与回执契约，不做付费调用。
 *
 * 用法：
 *   pnpm --filter @global/api exec tsx scripts/judgment/run-judgment-model-evals.mts [--out receipt.json]
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { aggregateJudgment } from '../../src/discovery/judgment/aggregate-judgment';
import {
  bootstrapPercentileCI,
  confusionMatrix,
  cohenKappa,
  evaluateCalibration,
  type LabeledVerdict,
} from '../../src/discovery/judgment/calibration';
import { buildEvalReceipt } from '../../src/discovery/judgment/eval-receipt';
import { validateEvidence } from '../../src/discovery/judgment/evidence-validate';
import { RUBRIC_VERSION } from '../../src/discovery/judgment/fit-rubric';
import {
  validateJudgeOutputV2,
  type JudgeCriterionOutput,
} from '../../src/discovery/judgment/judge-output-v2';
import { PROMPT_HASH } from '../../src/discovery/judgment/judge-prompt';

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
  },
});

if ((process.env.GAINOS_JUDGE_EVAL_LIVE ?? '').trim() === '1') {
  console.error(
    'REFUSED: 真实模型跑批需要预算授权与网关凭据（用户决策项）。本脚本当前只交付 dry 骨架与回执契约。',
  );
  process.exit(3);
}

const repoRoot = resolve(import.meta.dirname, '../../../..');
const manifestPath = resolve(repoRoot, 'evals/golden-judgments/manifest.json');
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
  cases: Array<{
    file: string;
    expectedLabel: 'FIT' | 'NOT_FIT' | 'UNKNOWN';
    id: string;
  }>;
};

const rows: LabeledVerdict[] = [];
let failed = 0;
const failures: string[] = [];
for (const manifestCase of manifest.cases) {
  const casePath = resolve(repoRoot, 'evals/golden-judgments', manifestCase.file);
  const parsed = JSON.parse(readFileSync(casePath, 'utf8')) as {
    expected: { label: 'FIT' | 'NOT_FIT' | 'UNKNOWN' };
    judge: { denyUrls?: string[]; now: string; output: unknown };
    input: { snapshot: { fetchedAt: string; text: string } };
  };
  const validation = validateJudgeOutputV2(parsed.judge.output);
  if (!validation.ok) {
    failed += 1;
    failures.push(`${manifestCase.id}: schema ${validation.errors[0]}`);
    continue;
  }
  const deny = new Set(parsed.judge.denyUrls ?? []);
  const evidence = validateEvidence(
    validation.value.criteria as readonly JudgeCriterionOutput[],
    {
      now: parsed.judge.now,
      snapshotFetchedAt: parsed.input.snapshot.fetchedAt,
      snapshotText: parsed.input.snapshot.text,
      urlPolicy: (url) => ({ allowed: !deny.has(url) }),
    },
  );
  const result = aggregateJudgment({ output: validation.value, evidence });
  const matches = result.verdict === parsed.expected.label;
  if (!matches) {
    failed += 1;
    failures.push(
      `${manifestCase.id}: verdict ${result.verdict} != expected ${parsed.expected.label}`,
    );
  }
  // 确定性链路的「混淆矩阵」：以金标实际 FIT/NOT_FIT 与聚合 verdict 对照（UNKNOWN 计未自动通过）。
  if (parsed.expected.label !== 'UNKNOWN') {
    rows.push({
      actual: parsed.expected.label,
      predicted: result.verdict === 'FIT' ? 'FIT' : result.verdict === 'NOT_FIT' ? 'NOT_FIT' : 'UNKNOWN',
    });
  }
}

const calibration = evaluateCalibration(rows);
const kappaCI = bootstrapPercentileCI(
  rows,
  (sample) => cohenKappa(confusionMatrix(sample)),
  { b: 1000, seed: 20261109 },
);

const receipt = buildEvalReceipt({
  datasetSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  rubricVersion: RUBRIC_VERSION,
  promptHash: PROMPT_HASH,
  modelResolved: 'dry-fixture-no-model-call',
  runAt: new Date().toISOString(),
  cases: {
    total: manifest.cases.length,
    passed: manifest.cases.length - failed,
    failed,
  },
  metrics: {
    kappa: { value: calibration.kappa, n: rows.length, ci: kappaCI },
    tpr: calibration.tpr,
    tnr: calibration.tnr,
  },
  thresholds: {},
});

const payload = JSON.stringify(receipt, null, 2);
if (values.out) {
  writeFileSync(values.out, `${payload}\n`);
  console.log(`receipt written to ${values.out}（gate.passed=${receipt.gate.passed}）`);
} else {
  console.log(payload);
}
if (failures.length > 0) {
  console.error(failures.join('\n'));
}
if (!receipt.gate.passed) {
  process.exitCode = 1;
}
