import { proxyActivities } from '@temporalio/workflow';
import type { ContactReverifyActivities } from './contact-reverify.activities';

const { contactReverifySweepOnce } = proxyActivities<ContactReverifyActivities>({
  // 500 条 × 供应商限流（默认 2/s）≈ 4–5 分钟；20 分钟覆盖限流抖动与重试。
  startToCloseTimeout: '20 minutes',
  retry: { maximumAttempts: 2 },
});

export interface ContactReverifySweepInput {
  /** 每轮候选上限（缺省 500，activity 内再钳制到 1..1000）。 */
  limit?: number;
}

/**
 * P1-19：每日存量邮箱再验证（CONTACT_REVERIFY_SWEEP，默认 24h，注册即 paused）。
 *
 * 无平台预算 authority：Schedule 默认暂停、启用是运维显式决定，且活动自带三重门——
 * data_provider.millionverifier=ENABLED（kill switch）+ source_policy 已登记 +
 * MILLIONVERIFIER_API_KEY；任一不满足则零调用、返回 skipped。每日成本由
 * CONTACT_REVERIFY_MAX_COST_MICROUSD 硬上限（默认 $5/轮）约束。
 */
export async function contactReverifySweepWorkflow(
  input: ContactReverifySweepInput = {},
): Promise<Awaited<ReturnType<ContactReverifyActivities['contactReverifySweepOnce']>>> {
  return contactReverifySweepOnce(input);
}
