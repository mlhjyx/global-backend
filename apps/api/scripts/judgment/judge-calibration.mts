/**
 * 判定校准报告（P3 J14；设计 §4.3.6.5）。
 *
 * 输入：逐条 (actual, predicted) 标签对（真实运行时来自 judgment_record × 金标 join；
 * 本卡先用文件/fixture 打通格式）。输出 Markdown + JSON：混淆矩阵、TPR/TNR/PPV/NPV/FNR
 * （全部带 Wilson 95% CI）、Cohen's kappa（+ 确定性 bootstrap CI）、Rogan–Gladen 校正。
 *
 * 用法：
 *   pnpm --filter @global/api exec tsx scripts/judgment/judge-calibration.mts --fixture
 *   pnpm --filter @global/api exec tsx scripts/judgment/judge-calibration.mts --input pairs.json [--out report.md]
 *
 * 纪律：任何数字必须带 n；kappa 必须与混淆矩阵同现；同输入同报告（bootstrap 种子固定）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import {
  bootstrapPercentileCI,
  cohenKappa,
  confusionMatrix,
  evaluateCalibration,
  roganGladen,
  type LabeledVerdict,
} from '../../src/discovery/judgment/calibration';

const { values } = parseArgs({
  options: {
    fixture: { type: 'boolean', default: false },
    input: { type: 'string' },
    out: { type: 'string' },
    seed: { type: 'string' },
  },
});

function syntheticFixture(): LabeledVerdict[] {
  // 确定性合成集（仅用于可复算演示；绝不作为真实校准结论）。
  const rows: LabeledVerdict[] = [];
  for (let i = 0; i < 200; i += 1) {
    rows.push({ actual: 'FIT', predicted: i < 180 ? 'FIT' : 'UNKNOWN' });
  }
  for (let i = 0; i < 100; i += 1) {
    rows.push({ actual: 'NOT_FIT', predicted: i < 12 ? 'FIT' : 'NOT_FIT' });
  }
  return rows;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function ci(interval: [number, number]): string {
  return `[${pct(interval[0])}, ${pct(interval[1])}]`;
}

let rows: LabeledVerdict[];
let banner: string;
if (values.input) {
  rows = JSON.parse(readFileSync(values.input, 'utf8')) as LabeledVerdict[];
  banner = `输入：${values.input}（${rows.length} 条）`;
} else {
  rows = syntheticFixture();
  banner = '⚠️ SYNTHETIC FIXTURE —— 合成样例，仅证明报告可复算；真实校准须等 J13 标注集。';
}
const seed = values.seed === undefined ? 20261109 : Number(values.seed);
const result = evaluateCalibration(rows);
const kappaCI = bootstrapPercentileCI(
  rows,
  (sample) => cohenKappa(confusionMatrix(sample)),
  { b: 1000, seed },
);
const observedPassRate =
  (result.matrix.tp + result.matrix.fp) / rows.length;
const rg = roganGladen(observedPassRate, result.tpr.value, result.tnr.value);

const json = {
  banner,
  n: rows.length,
  matrix: result.matrix,
  kappa: { value: result.kappa, ci: kappaCI },
  tpr: result.tpr,
  tnr: result.tnr,
  ppv: result.ppv,
  npv: result.npv,
  fnr: result.fnr,
  roganGladen: { observedPassRate, ...rg },
};

const markdown = `# judge 校准报告（${values.input ? '真实输入' : '合成 fixture'}）

> ${banner}
> 生成命令：\`judge-calibration.mts ${values.input ? `--input ${values.input}` : '--fixture'}${values.seed ? ` --seed ${seed}` : ''}\`；同输入同输出（bootstrap 种子 ${seed}）。

## 混淆矩阵（n=${rows.length}，阳性=目标客户 FIT）

| | 判 FIT | 判非 FIT（含 UNKNOWN） |
| --- | --- | --- |
| 金标 FIT | ${result.matrix.tp} | ${result.matrix.fn} |
| 金标 NOT_FIT | ${result.matrix.fp} | ${result.matrix.tn} |

## 指标（均带 Wilson 95% CI）

| 指标 | 值 | 95% CI | n |
| --- | --- | --- | --- |
| TPR（recall） | ${pct(result.tpr.value)} | ${ci(result.tpr.ci)} | ${result.tpr.n} |
| TNR（specificity） | ${pct(result.tnr.value)} | ${ci(result.tnr.ci)} | ${result.tnr.n} |
| PPV（precision） | ${pct(result.ppv.value)} | ${ci(result.ppv.ci)} | ${result.ppv.n} |
| NPV | ${pct(result.npv.value)} | ${ci(result.npv.ci)} | ${result.npv.n} |
| FNR | ${pct(result.fnr.value)} | ${ci(result.fnr.ci)} | ${result.fnr.n} |
| Cohen's κ | ${result.kappa.toFixed(4)} | ${ci(kappaCI)}（bootstrap B=1000） | ${rows.length} |

## Rogan–Gladen 校正

- 观测 FIT 率：${pct(observedPassRate)}
- 校正后真实匹配率 π̂：${rg.prevalence === null ? '不可计算（TPR+TNR≤1 或越界）' : pct(rg.prevalence)}
- 校正后 PPV：${rg.ppv === null ? '不可计算' : pct(rg.ppv)}

## 复算

\`\`\`bash
pnpm --filter @global/api exec tsx scripts/judgment/judge-calibration.mts ${values.input ? `--input ${values.input}` : '--fixture'}${values.seed ? ` --seed ${seed}` : ''}
\`\`\`
`;

if (values.out) {
  writeFileSync(values.out, markdown);
  console.log(JSON.stringify({ out: values.out, ...json }, null, 2));
} else {
  process.stdout.write(markdown);
  console.log(JSON.stringify(json, null, 2));
}
