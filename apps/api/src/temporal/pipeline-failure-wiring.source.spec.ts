import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P3 J02 验收（设计 §4.3.9 W1/W4）：管线失败标记不得再出现聚合码字面量。
 * 行为断言在 workflow/activity 单测里；这里用源级守卫防止回归时把聚合码写回来
 *（注释里提到码名不算——断言的是带引号的字符串字面量）。
 */
const TEMPORAL = join(import.meta.dirname);
const read = (name: string): string => readFileSync(join(TEMPORAL, name), 'utf8');

describe('pipeline failure attribution wiring (P3 J02)', () => {
  it('workflow catch 不再写 COMPANY_PIPELINE_FAILED', () => {
    const workflow = read('discovery.run2.pipeline.workflow.ts');
    expect(workflow).not.toContain("'COMPANY_PIPELINE_FAILED'");
    expect(workflow).toContain('classifyPipelineFailure(error)');
    expect(workflow).toContain('failureStage: failure.failureStage');
  });

  it('quickJudgeBatch 不再写 QUICK_JUDGE_FAILED 并接入心跳/取消', () => {
    const activities = read('discovery.run2.activities.ts');
    expect(activities).not.toContain("'QUICK_JUDGE_FAILED'");
    expect(activities).toContain('classifyPipelineFailure(error)');
    expect(activities).toContain('throwIfActivityCancelled(activity)');
    expect(activities).toContain('activity?.heartbeat(');
  });

  it('pipeline 活动在边界包装类型化失败码；run_event 带 failureStage', () => {
    const pipeline = read('discovery.run2.pipeline.activities.ts');
    for (const activity of [
      'profileCompanyOnce',
      'fitCompanyOnce',
      'signalsCompanyOnce',
      'contactsCompanyOnce',
      'enrichContactsForCompany',
    ]) {
      expect(pipeline).toContain(`${activity}: withClassifiedFailure(activities.${activity})`);
    }
    expect(pipeline).toContain(
      '(args.failureStage ? { failureStage: args.failureStage } : {})',
    );
  });
});
