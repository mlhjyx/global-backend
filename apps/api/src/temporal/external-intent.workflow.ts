import { proxyActivities } from '@temporalio/workflow';
import type { ExternalIntentActivities, ExternalIntentIcpResult, IngestSweepSummary, LiveProviderState, ResolvedIntentTarget } from './external-intent.activities';

const acts = proxyActivities<ExternalIntentActivities>({
  startToCloseTimeout: '10 minutes', // 摄取活动可能拉多个唯一指纹（各有界分页）
  retry: { maximumAttempts: 2 },
});

export interface ExternalIntentSweepResult {
  swept: number;
  expiredSignals: number; // 状态机翻转数（ACTIVE→EXPIRED）
  ingest?: IngestSweepSummary; // 平台层摄取统计（fetches/ledgerHits = ingest-once 可观测证据）
  tenderCompaniesTouched: number;
  tenderEvents: number;
  clearanceCompaniesTouched: number;
  clearanceEvents: number;
  results: ExternalIntentIcpResult[];
}

/**
 * **外部源 intent sweep**（收口⑤：ingest-once + 两层投影）—— 独立 Temporal Schedule 周期触发（overlap=SKIP）。
 * 四段：枚举 ACTIVE ICP → 信号状态机（过期翻转）→ 逐 ICP 确定性解析查询面 → **平台层按指纹去重拉取一次**
 * 写 source_signal → 逐 ICP 从平台表只读投影进本租户（动 Intent 维）。
 * 单 ICP 解析/投影失败不影响其余（fail-safe）；预算打穿停拉不停投影（已落库信号仍生效）。
 */
/** 投影循环里每处理 K 个 ICP 就在批次头重读一次 kill-switch 快照（把 sweep 中途翻闸的 stale 窗口封到 ≤K）。 */
const LIVE_REFRESH_EVERY = 25;

export async function externalIntentSweepWorkflow(
  input?: { limit?: number; liveRefreshEvery?: number },
): Promise<ExternalIntentSweepResult> {
  // 默认不传 limit → 枚举全部 ACTIVE ICP（无静默截断/不饿死旧 ICP）；调用方可显式传 limit 做有界跑。
  const { targets, tedEnabled, openfdaEnabled } = await acts.listExternalIntentTargets(
    input?.limit ? { limit: input.limit } : {},
  );

  const agg: ExternalIntentSweepResult = {
    swept: 0, expiredSignals: 0, tenderCompaniesTouched: 0, tenderEvents: 0, clearanceCompaniesTouched: 0, clearanceEvents: 0, results: [],
  };
  if (!tedEnabled && !openfdaEnabled) return agg; // 两 provider 全停 → 不跑

  // 状态机先行：过期信号翻 EXPIRED，本轮投影绝不吃过期需求。
  agg.expiredSignals = (await acts.expireStaleSignals()).expired;

  // 逐 ICP 确定性解析（零出网）；单 ICP 解析失败记录后继续。
  const resolved: ResolvedIntentTarget[] = [];
  for (const t of targets) {
    try {
      resolved.push(await acts.resolveExternalIntentTarget(t));
    } catch (err) {
      resolved.push({ ...t, cpvCodes: [], buyerCountries: [], fdaProductCodes: [], error: String(err).slice(0, 200) });
    }
  }

  // 平台层摄取一次（指纹全局去重 → 跨 workspace 共享拉取）。
  try {
    agg.ingest = await acts.ingestExternalSignals({ targets: resolved, tedEnabled, openfdaEnabled });
  } catch (err) {
    // 摄取整体失败 fail-safe：投影仍可吃此前窗口已落库的信号。
    agg.ingest = { tedSpecs: 0, fdaSpecs: 0, fetches: 0, ledgerHits: 0, signalsUpserted: 0, budgetExceeded: false, errors: [String(err).slice(0, 200)] };
  }

  // 摄取后逐 ICP 只读投影，用 kill-switch live 快照门控。**每 K 个 ICP 在批次头重读一次**（承 #70 单次读
  // 优化 + Codex P1 修正）：把「运维在 sweep 执行途中翻 DataProvider kill-switch」的 stale 窗口封到 ≤K 个投影，
  // 同时把 owner-DB 读从「每 ICP 一次」(N) 降到 ⌈N/K⌉——保住 #70 优化的绝大部分。首个批次头即在所有投影前读到
  // 最新态；单批读失败 fail-safe → undefined（该批投影退回活动自读兜底，防御纵深，不因一次读故障放大成整轮不投）。
  const refreshEvery = Math.max(1, input?.liveRefreshEvery ?? LIVE_REFRESH_EVERY);
  let live: LiveProviderState | undefined;
  for (let i = 0; i < resolved.length; i++) {
    const t = resolved[i];
    if (i % refreshEvery === 0) {
      try {
        live = await acts.liveProviderState();
      } catch {
        live = undefined;
      }
    }
    let r: ExternalIntentIcpResult;
    try {
      r = await acts.projectExternalIntentForIcp({ ...t, tedEnabled, openfdaEnabled, live });
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
