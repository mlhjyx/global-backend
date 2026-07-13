import { proxyActivities } from '@temporalio/workflow';
import type { createSiteBuilderActivities, DemoV0ActivityInput } from './site-builder.activities';

type SiteBuilderActivities = ReturnType<typeof createSiteBuilderActivities>;

const activities = proxyActivities<SiteBuilderActivities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 2 }, // 构建瞬时失败给一次重试；业务失败状态已在 activity 内落库
});

/**
 * demo v0 快速通道（02 §4）：单 activity，秒级出站；精装修管线（P1-P5）随 M1。
 * 终态失败（重试耗尽）走补偿清理——site 行残留会让 re-intake 永远 409（复审 MEDIUM）。
 */
export async function demoV0Workflow(input: DemoV0ActivityInput): Promise<void> {
  try {
    await activities.generateDemoV0(input);
  } catch (err) {
    await activities.cleanupFailedDemo(input);
    throw err;
  }
}
