import { proxyActivities } from '@temporalio/workflow';
import type { ExternalIntentActivities, ExternalIntentIcpResult } from './external-intent.activities';

const acts = proxyActivities<ExternalIntentActivities>({
  startToCloseTimeout: '10 minutes', // 单 ICP 可能拉 TED + openFDA 两个外部 API（各有界分页）
  retry: { maximumAttempts: 2 },
});

export interface ExternalIntentSweepResult {
  swept: number;
  tenderCompaniesTouched: number;
  tenderEvents: number;
  clearanceCompaniesTouched: number;
  clearanceEvents: number;
  results: ExternalIntentIcpResult[];
}

/**
 * **外部源 intent sweep** —— 由独立 Temporal Schedule 周期触发（overlap=SKIP）。
 * 遍历 ACTIVE ICP，对每个 ICP 确定性解析 CPV/FDA 码 → 投影 TED 招标 + openFDA 510(k) 清关 intent（动 Intent 维）。
 * 让已落地的两 P3 投影在生产真跑（loop 收口）；单 ICP 失败不影响其余（fail-safe）。
 * 与 web_watch 的 intentSweep 并列但分开调度：外部源按 ICP 拉、web_watch 按监控源拉。
 */
export async function externalIntentSweepWorkflow(input?: { limit?: number }): Promise<ExternalIntentSweepResult> {
  const { targets, tedEnabled, openfdaEnabled } = await acts.listExternalIntentTargets({ limit: input?.limit ?? 200 });

  const agg: ExternalIntentSweepResult = {
    swept: 0, tenderCompaniesTouched: 0, tenderEvents: 0, clearanceCompaniesTouched: 0, clearanceEvents: 0, results: [],
  };
  if (!tedEnabled && !openfdaEnabled) return agg; // 两 provider 全停 → 不跑

  for (const t of targets) {
    let r: ExternalIntentIcpResult;
    try {
      r = await acts.projectExternalIntentForIcp({ ...t, tedEnabled, openfdaEnabled });
    } catch (err) {
      r = { workspaceId: t.workspaceId, icpId: t.icpId, cpvCodes: 0, fdaProductCodes: 0, error: String(err).slice(0, 200) };
    }
    agg.results.push(r);
    agg.swept += 1;
    agg.tenderCompaniesTouched += r.tenders?.companiesTouched ?? 0;
    agg.tenderEvents += r.tenders?.eventsProjected ?? 0;
    agg.clearanceCompaniesTouched += r.clearances?.companiesTouched ?? 0;
    agg.clearanceEvents += r.clearances?.eventsProjected ?? 0;
  }
  return agg;
}
