import { proxyActivities } from '@temporalio/workflow';
import type {
  BacklogActivities,
  ContactBacklogResult,
  EnrichBacklogResult,
  FitBacklogResult,
  WatchBacklogResult,
} from './backlog.activities';
import type { QualifyActivities } from './qualify.activities';

// 资格门批 = 每家一次 LLM 结构化调用。实测 gemini-2.5-pro 单家 10-30s（含 schema 修复重试可更长）
// → 批默认 20 家 × 30s ≈ 10 分钟，配 30 分钟上界（40×20s 曾逼近 15 分钟超时线，会整批重试）。
const fitActs = proxyActivities<BacklogActivities>({
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 2 },
});
// 抓取类批（信号/监控/联系人：官网+sitemap+多页渲染，逐家数十秒）
const slowActs = proxyActivities<BacklogActivities>({
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 2 },
});
const scoreActs = proxyActivities<QualifyActivities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3 },
});

export interface BacklogSweepInput {
  /** 指定单目标；缺省 = 跨租户全部 ACTIVE ICP（owner 只读扫描）。 */
  workspaceId?: string;
  icpId?: string;
  /** 各阶段批大小/轮次上限（单次 sweep 有界；剩余交给下个 sweep 蚕食）。 */
  fitBatch?: number;
  maxFitRounds?: number;
  enrichBatch?: number;
  maxEnrichRounds?: number;
  signalBatch?: number;
  maxSignalRounds?: number;
  watchBatch?: number;
  maxWatchRounds?: number;
  contactBatch?: number;
  maxContactRounds?: number;
}

export interface BacklogSweepTargetStats {
  workspaceId: string;
  icpId: string;
  fit: { scanned: number; judged: number; verdicts: Record<string, number>; exhausted: boolean };
  enrich: { scanned: number; attempted: number; matched: number };
  signals: { scanned: number; attempted: number; matched: number };
  watches: { scanned: number; registered: number };
  contacts: { scanned: number; attempted: number; contactsCreated: number };
  scored: number;
}

/**
 * 存量对账 sweep（漏斗总闸）：资格门 → 快事实富集 → 信号富集 → 网站监控注册 → 联系人发现 → 重评分。
 * 每阶段游标分页 + 轮次上限（单次 sweep 有界；跑不完的交给下个 sweep —— Schedule 周期驱动，overlap=SKIP）。
 * 阶段间无跨项依赖 → 顺序执行即可；单阶段失败不阻断后续阶段（fail-safe）。
 */
export async function backlogSweepWorkflow(input?: BacklogSweepInput): Promise<BacklogSweepTargetStats[]> {
  const targets =
    input?.workspaceId && input?.icpId
      ? [{ workspaceId: input.workspaceId, icpId: input.icpId }]
      : (await fitActs.listBacklogTargets()).targets;

  const all: BacklogSweepTargetStats[] = [];
  for (const t of targets) {
    const stats: BacklogSweepTargetStats = {
      ...t,
      fit: { scanned: 0, judged: 0, verdicts: { match: 0, weak: 0, mismatch: 0 }, exhausted: false },
      enrich: { scanned: 0, attempted: 0, matched: 0 },
      signals: { scanned: 0, attempted: 0, matched: 0 },
      watches: { scanned: 0, registered: 0 },
      contacts: { scanned: 0, attempted: 0, contactsCreated: 0 },
      scored: 0,
    };

    // ① 资格门（解锁 fitVerdict=null 存量）
    try {
      let cursor: string | null = null;
      for (let round = 0; round < (input?.maxFitRounds ?? 60); round++) {
        const r: FitBacklogResult = await fitActs.qualifyFitBacklog({ ...t, limit: input?.fitBatch ?? 20, cursor });
        stats.fit.scanned += r.scanned;
        stats.fit.judged += r.judged;
        for (const [k, v] of Object.entries(r.verdicts)) stats.fit.verdicts[k] = (stats.fit.verdicts[k] ?? 0) + v;
        cursor = r.nextCursor;
        if (!cursor) {
          stats.fit.exhausted = true;
          break;
        }
      }
    } catch {
      /* 资格门批失败（如网关长时不可用）不阻断后续阶段 */
    }

    // ② 快事实富集（GLEIF/Wikidata，fit=match 缺命名空间者）
    try {
      let cursor: string | null = null;
      for (let round = 0; round < (input?.maxEnrichRounds ?? 10); round++) {
        const r: EnrichBacklogResult = await fitActs.enrichBacklog({ workspaceId: t.workspaceId, limit: input?.enrichBatch ?? 25, cursor });
        stats.enrich.scanned += r.scanned;
        stats.enrich.attempted += r.attempted;
        stats.enrich.matched += r.matched;
        cursor = r.nextCursor;
        if (!cursor) break;
      }
    } catch {
      /* fail-safe */
    }

    // ③ 信号富集（数字足迹/结构化收割，TTL 感知）
    try {
      let cursor: string | null = null;
      for (let round = 0; round < (input?.maxSignalRounds ?? 3); round++) {
        const r: EnrichBacklogResult = await slowActs.enrichSignalsBacklog({ workspaceId: t.workspaceId, limit: input?.signalBatch ?? 12, cursor });
        stats.signals.scanned += r.scanned;
        stats.signals.attempted += r.attempted;
        stats.signals.matched += r.matched;
        cursor = r.nextCursor;
        if (!cursor) break;
      }
    } catch {
      /* fail-safe */
    }

    // ④ 网站监控注册（web_watch → intentSweep 持续盯）
    try {
      let cursor: string | null = null;
      for (let round = 0; round < (input?.maxWatchRounds ?? 3); round++) {
        const r: WatchBacklogResult = await slowActs.registerWatchesBacklog({ workspaceId: t.workspaceId, limit: input?.watchBatch ?? 12, cursor });
        stats.watches.scanned += r.scanned;
        stats.watches.registered += r.registered;
        cursor = r.nextCursor;
        if (!cursor) break;
      }
    } catch {
      /* fail-safe */
    }

    // ⑤ 联系人发现（decision_maker 首选：具名决策人 + 买家角色）
    try {
      let cursor: string | null = null;
      for (let round = 0; round < (input?.maxContactRounds ?? 3); round++) {
        const r: ContactBacklogResult = await slowActs.discoverContactsBacklog({ ...t, limit: input?.contactBatch ?? 8, cursor });
        stats.contacts.scanned += r.scanned;
        stats.contacts.attempted += r.attempted;
        stats.contacts.contactsCreated += r.contactsCreated;
        cursor = r.nextCursor;
        if (!cursor) break;
      }
    } catch {
      /* fail-safe */
    }

    // ⑥ 重评分（新 verdict/信号/联系人 → lead 四队列刷新）
    try {
      const scored = await scoreActs.scoreCandidates({ workspaceId: t.workspaceId, icpId: t.icpId });
      stats.scored = scored.scored;
    } catch {
      /* fail-safe */
    }

    all.push(stats);
  }
  return all;
}
