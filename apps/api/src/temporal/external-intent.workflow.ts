import { proxyActivities, patched } from '@temporalio/workflow';
import type { ExternalIntentActivities, ExternalIntentIcpResult, ExternalIntentRecomputeSummary, IngestSweepSummary, LiveProviderState, ResolvedIntentTarget } from './external-intent.activities';

const acts = proxyActivities<ExternalIntentActivities>({
  // 摄取活动对**全部** ACTIVE ICP 的唯一 TED/openFDA 指纹逐个有界分页——查询面多的 workspace 下时长可观，
  // 10min 易在触到尾部指纹前超时并整体重试。放宽到 30min 给全目标工作量足够 headroom（#56 P2）。
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 2 },
});

export interface ExternalIntentSweepResult {
  swept: number;
  expiredSignals: number; // 状态机翻转数（ACTIVE→EXPIRED）
  recompute?: ExternalIntentRecomputeSummary; // 过期后 intent 复算收敛统计（#56 P2）
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

  // 过期后 intent **复算收敛**（#56 P2）：expireStaleSignals 只翻转信号状态，增量投影只加不删——已写进
  // canonical.attributes.intent 的过期事件仍被评分（评分读租户属性而非 source_signal）直到自然衰减。故从事实源
  // 确定性重建受影响 workspace 的投影（无匹配事件即清除）。
  // 🔴 Temporal 版本化守卫（#70 P2）：新增活动命令用 `patched` 门——飞行中的**旧历史**（无此命令）replay 时走
  //    else（不调此活动），命令序列与旧历史一致、不触发非确定性重放失败；新执行走 true 分支。既有 liveProviderState
  //    命令**不重新包 patch**（已部署，重包反而破坏在飞历史）——版本化纪律自本次新插入命令起生效。
  if (patched('external-intent-recompute-v1')) {
    try {
      agg.recompute = await acts.recomputeExpiredIntent({ targets: resolved });
    } catch (err) {
      // fail-safe：复算失败不阻断本轮投影（过期事件仍会随评分新近度衰减，非硬失效）。
      agg.recompute = { workspacesRecomputed: 0, companiesRebuilt: 0, companiesCleared: 0, truncated: 0, error: String(err).slice(0, 200) };
    }
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
