/**
 * 判定灰度矩阵与回滚计划（P3 J22；设计 §4.3.9 J22 / §4.3.3.6）。
 *
 * 两个独立开关：
 *  - `JUDGE_CONTRACT_MODE = off | shadow | enforce`：v1 旧路径 / 双跑观察 / v2 聚合 verdict；
 *  - `JUDGE_PANEL_MODE   = off | shadow | enforce`：borderline 三模型面板（仅在 v2 路径内）。
 *
 * 本模块把「组合 → Lead 由谁决定」固化成纯函数，供 mode-drill 脚本与值班手册引用；
 * 非法值按 off 处理（与解析器一致），但这里会额外产出 warning 供演练/值班发现拼写错误。
 */

import { judgeContractMode, type JudgeContractMode } from '../fit-judge-v2';
import { judgePanelMode, type JudgePanelMode } from './panel';

export const GRAYSCALE_STAGES = [
  'contract=off / panel=off',
  'contract=shadow（双跑观察）',
  'contract=enforce / panel=shadow',
  'contract=enforce / panel=enforce',
] as const;

export interface JudgmentModeMatrixEntry {
  contract: JudgeContractMode;
  /** Lead.fitVerdict 由谁决定（值班排障的第一问题）。 */
  leadPath: string;
  panel: JudgePanelMode;
  /** 该组合下是否写 judgment_record（及写哪些）。 */
  records: string;
}

export interface JudgmentModeReport {
  entry: JudgmentModeMatrixEntry;
  warnings: string[];
}

function matrixEntry(
  contract: JudgeContractMode,
  panel: JudgePanelMode,
): JudgmentModeMatrixEntry {
  if (contract === 'off') {
    return {
      contract,
      panel,
      leadPath: 'v1 四门判定（旧路径逐字不变）',
      records: '不写 judgment_record（panel 不触发）',
    };
  }
  if (contract === 'shadow') {
    return {
      contract,
      panel,
      leadPath: 'v1 四门判定（面板如启用只观察）',
      records: 'v2 主记录（judge_level=2，容错写）；面板启用时附加面板记录',
    };
  }
  if (panel === 'off') {
    return {
      contract,
      panel,
      leadPath: 'v2 聚合 verdict（FIT→match / UNKNOWN→weak / NOT_FIT→mismatch）',
      records: 'v2 主记录（严格写）',
    };
  }
  if (panel === 'shadow') {
    return {
      contract,
      panel,
      leadPath: 'v2 聚合 verdict（borderline 面板只记录观察，不改 Lead）',
      records: 'v2 主记录 + borderline 面板记录（3 模型槽 + 汇总）',
    };
  }
  return {
    contract,
    panel,
    leadPath: 'v2 聚合 verdict；borderline 时面板多数票替代该情形 verdict',
    records: 'v2 主记录 + borderline 面板记录（3 模型槽 + 汇总）',
  };
}

/** 解析当前环境并给出矩阵条目 + 非法值警告（解析器会静默回落 off，这里暴露拼写错误）。 */
export function describeJudgmentModes(
  env: { readonly [key: string]: string | undefined } = process.env,
): JudgmentModeReport {
  const warnings: string[] = [];
  const rawContract = (env.JUDGE_CONTRACT_MODE ?? '').trim().toLowerCase();
  const rawPanel = (env.JUDGE_PANEL_MODE ?? '').trim().toLowerCase();
  if (rawContract && !['off', 'shadow', 'enforce'].includes(rawContract)) {
    warnings.push(
      `JUDGE_CONTRACT_MODE="${rawContract}" 非法，已按 off 处理（拼写错误不会改变生产判定，但请修正）`,
    );
  }
  if (rawPanel && !['off', 'shadow', 'enforce'].includes(rawPanel)) {
    warnings.push(
      `JUDGE_PANEL_MODE="${rawPanel}" 非法，已按 off 处理；请修正（注意 design §4.3.3.6 旧文写的 off|borderline 已被 off|shadow|enforce 取代）`,
    );
  }
  const contract = judgeContractMode(env);
  const panel = judgePanelMode(env);
  if (contract === 'off' && panel !== 'off') {
    warnings.push(
      `panel=${panel} 在 contract=off 下不生效（面板只在 v2 路径内触发）；如需观察面板请先开 contract=shadow`,
    );
  }
  return { entry: matrixEntry(contract, panel), warnings };
}

/** 回滚计划：从任意阶段回到基线，目标 <5 分钟。 */
export function rollbackPlan(): ReadonlyArray<{
  action: string;
  detail: string;
  minutes: number;
}> {
  return Object.freeze([
    {
      action: '置回基线环境',
      detail:
        'JUDGE_CONTRACT_MODE=off、JUDGE_PANEL_MODE=off（若在运行 env 里删除键等价于 off）',
      minutes: 0.5,
    },
    {
      action: '重启受管进程',
      detail:
        'sudo bash local-config/global/runtime.sh restart api worker（worker 是判定活动执行者，必须一起重启）',
      minutes: 2,
    },
    {
      action: '确认恢复',
      detail:
        '`gctl health` 就绪；mode-drill 显示 contract=off；新一轮 run 的 judgment_record 不再新增',
      minutes: 1,
    },
    {
      action: '留证',
      detail:
        '把 drill 输出与 /health/build 的 build_sha 贴进事故记录或 _archive 切换记录',
      minutes: 0.5,
    },
  ]);
}
