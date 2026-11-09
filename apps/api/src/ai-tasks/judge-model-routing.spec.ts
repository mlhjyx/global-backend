import { describe, expect, it } from 'vitest';

import {
  assertJudgeModelRouting,
  filterJudgeSubstitutes,
  isJudgeFinalVerdictTask,
  isJudgeModelAllowlisted,
  JUDGE_ALLOW_FLASH_ENV,
  JUDGE_FINAL_VERDICT_TASK_IDS,
  JUDGE_MODEL_ALLOWLIST,
  judgeAllowsFlash,
} from './judge-model-routing';

describe('judge model routing 护栏（P3 J03）', () => {
  it('终判任务集合与白名单是快照：任何增删都必须经评审', () => {
    expect([...JUDGE_FINAL_VERDICT_TASK_IDS]).toEqual(['discovery.qualify_fit']);
    expect([...JUDGE_MODEL_ALLOWLIST]).toEqual([
      'deepseek-v4-pro',
      'gemini-4-argon-high',
      'gpt-5.6-sol',
    ]);
  });

  it('isJudgeFinalVerdictTask：只认终判任务，L1 快扫/普通任务不在列', () => {
    expect(isJudgeFinalVerdictTask('discovery.qualify_fit')).toBe(true);
    expect(isJudgeFinalVerdictTask('discovery.quick_judge')).toBe(false);
    expect(isJudgeFinalVerdictTask('taxonomy.normalize')).toBe(false);
    expect(isJudgeFinalVerdictTask('discovery.extract_list')).toBe(false);
  });

  it('isJudgeModelAllowlisted：flash 档永远不在白名单', () => {
    expect(isJudgeModelAllowlisted(' deepseek-v4-pro ')).toBe(true);
    expect(isJudgeModelAllowlisted('gemini-3.8-flash')).toBe(false);
    expect(isJudgeModelAllowlisted('deepseek-v4-flash')).toBe(false);
    expect(isJudgeModelAllowlisted('deepseek-flash')).toBe(false);
  });

  it('judgeAllowsFlash：只有显式 true 才放行（大小写/空白容忍）', () => {
    expect(judgeAllowsFlash({})).toBe(false);
    expect(judgeAllowsFlash({ [JUDGE_ALLOW_FLASH_ENV]: 'false' })).toBe(false);
    expect(judgeAllowsFlash({ [JUDGE_ALLOW_FLASH_ENV]: 'true' })).toBe(true);
    expect(judgeAllowsFlash({ [JUDGE_ALLOW_FLASH_ENV]: ' TRUE ' })).toBe(true);
  });

  describe('filterJudgeSubstitutes', () => {
    it('终判任务剔除白名单之外的替换目标（pro→flash 不再生效）', () => {
      expect(
        filterJudgeSubstitutes('discovery.qualify_fit', ['deepseek-v4-flash'], {}),
      ).toEqual([]);
    });

    it('终判任务保留白名单内的替换目标', () => {
      expect(
        filterJudgeSubstitutes(
          'discovery.qualify_fit',
          ['gemini-4-argon-high', 'deepseek-v4-flash'],
          {},
        ),
      ).toEqual(['gemini-4-argon-high']);
    });

    it('普通获客任务不受影响；JUDGE_ALLOW_FLASH=true 时终判也放行', () => {
      expect(
        filterJudgeSubstitutes('discovery.extract_list', ['deepseek-v4-flash'], {}),
      ).toEqual(['deepseek-v4-flash']);
      expect(
        filterJudgeSubstitutes('discovery.qualify_fit', ['deepseek-v4-flash'], {
          [JUDGE_ALLOW_FLASH_ENV]: 'true',
        }),
      ).toEqual(['deepseek-v4-flash']);
    });
  });

  describe('assertJudgeModelRouting（启动自检）', () => {
    const resolveTo =
      (model: string | undefined) =>
      (taskId: string): string | undefined =>
        taskId === 'discovery.qualify_fit' ? model : undefined;

    it('白名单模型通过', () => {
      expect(() => assertJudgeModelRouting(resolveTo('gpt-5.6-sol'), {})).not.toThrow();
      expect(() =>
        assertJudgeModelRouting(resolveTo('deepseek-v4-pro'), {}),
      ).not.toThrow();
    });

    it('flash 档模型抛错（fail-closed），错误信息给出两条修复路径', () => {
      expect(() =>
        assertJudgeModelRouting(resolveTo('gemini-3.8-flash'), {}),
      ).toThrow(/JUDGE_MODEL_ALLOWLIST/);
      expect(() =>
        assertJudgeModelRouting(resolveTo('gemini-3.8-flash'), {}),
      ).toThrow(/MODEL_ACQUISITION_REASONING_MODEL/);
      expect(() =>
        assertJudgeModelRouting(resolveTo('gemini-3.8-flash'), {}),
      ).toThrow(/JUDGE_ALLOW_FLASH=true/);
    });

    it('JUDGE_ALLOW_FLASH=true 时显式放行 flash 档', () => {
      expect(() =>
        assertJudgeModelRouting(resolveTo('gemini-3.8-flash'), {
          [JUDGE_ALLOW_FLASH_ENV]: 'true',
        }),
      ).not.toThrow();
    });

    it('终判任务缺失或模型为空同样抛错（不允许无主模型启动）', () => {
      expect(() => assertJudgeModelRouting(resolveTo(undefined), {})).toThrow(
        /missing from the task registry/,
      );
      expect(() => assertJudgeModelRouting(resolveTo('  '), {})).toThrow(
        /missing from the task registry/,
      );
    });
  });
});
