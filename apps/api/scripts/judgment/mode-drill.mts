/**
 * 判定灰度演练（P3 J22）：把当前进程环境的两个开关解析成矩阵条目并打印回滚计划。
 *
 * 只读、无副作用：不调用模型、不写库。发车前的值班演练与事故时的「现在跑到哪一档」
 * 都跑这一条命令；退出码 1 表示环境值非法（解析器会回落 off，但演练必须显式报错）。
 *
 * 用法：
 *   pnpm --filter @global/api exec tsx scripts/judgment/mode-drill.mts
 *   JUDGE_CONTRACT_MODE=enforce JUDGE_PANEL_MODE=shadow pnpm --filter @global/api exec tsx .../mode-drill.mts
 */

import {
  GRAYSCALE_STAGES,
  describeJudgmentModes,
  rollbackPlan,
} from '../../src/discovery/judgment/grayscale';

const report = describeJudgmentModes(process.env);

const output = {
  stages: GRAYSCALE_STAGES,
  current: report.entry,
  warnings: report.warnings,
  rollback: rollbackPlan().map((step) => ({
    action: step.action,
    detail: step.detail,
    minutes: step.minutes,
  })),
};

console.log(JSON.stringify(output, null, 2));

if (report.warnings.length > 0) {
  process.exitCode = 1;
}
