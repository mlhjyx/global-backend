import { describe, expect, it } from 'vitest';

import {
  GRAYSCALE_STAGES,
  describeJudgmentModes,
  rollbackPlan,
} from './grayscale';

describe('判定灰度矩阵（P3 J22）', () => {
  it('off/off：Lead 由 v1 决定、不写记录（基线）', () => {
    const { entry, warnings } = describeJudgmentModes({});
    expect(entry).toMatchObject({
      contract: 'off',
      panel: 'off',
      leadPath: 'v1 四门判定（旧路径逐字不变）',
    });
    expect(warnings).toEqual([]);
  });

  it('contract=shadow：Lead 仍由 v1 决定，v2 记录容错写', () => {
    const { entry } = describeJudgmentModes({ JUDGE_CONTRACT_MODE: 'shadow' });
    expect(entry.leadPath).toContain('v1');
    expect(entry.records).toContain('v2 主记录');
  });

  it('enforce×off 与 enforce×enforce 的 Lead 路径不同', () => {
    const off = describeJudgmentModes({ JUDGE_CONTRACT_MODE: 'enforce' }).entry;
    const on = describeJudgmentModes({
      JUDGE_CONTRACT_MODE: 'enforce',
      JUDGE_PANEL_MODE: 'enforce',
    }).entry;
    expect(off.leadPath).toContain('v2 聚合 verdict');
    expect(off.leadPath).not.toContain('面板');
    expect(on.leadPath).toContain('多数票替代');
  });

  it('非法值与「panel 在 contract=off 下不生效」都产生 warning', () => {
    const invalid = describeJudgmentModes({
      JUDGE_CONTRACT_MODE: 'shadown', // 拼写错误
      JUDGE_PANEL_MODE: 'borderline', // 旧版设计词
    });
    expect(invalid.entry.contract).toBe('off');
    expect(invalid.warnings.join('\n')).toContain('JUDGE_CONTRACT_MODE="shadown" 非法');
    expect(invalid.warnings.join('\n')).toContain('off|borderline');

    const ineffective = describeJudgmentModes({ JUDGE_PANEL_MODE: 'shadow' });
    expect(ineffective.warnings.join('\n')).toContain('contract=off 下不生效');
  });

  it('回滚计划覆盖 env 复位/重启/确认/留证且总时长 <5 分钟', () => {
    const plan = rollbackPlan();
    expect(plan.map((step) => step.action)).toEqual([
      '置回基线环境',
      '重启受管进程',
      '确认恢复',
      '留证',
    ]);
    const total = plan.reduce((sum, step) => sum + step.minutes, 0);
    expect(total).toBeLessThan(5);
    expect(plan[1]!.detail).toContain('worker');
  });

  it('灰度阶段清单与设计一致（四阶段）', () => {
    expect(GRAYSCALE_STAGES).toHaveLength(4);
    expect(GRAYSCALE_STAGES[0]).toContain('contract=off');
    expect(GRAYSCALE_STAGES[3]).toContain('panel=enforce');
  });
});
