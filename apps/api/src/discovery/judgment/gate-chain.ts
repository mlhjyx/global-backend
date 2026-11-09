/**
 * L0 门链接线（P3 J07/J08；设计 §4.3.2.2 W8、§4.3.2.6 W9）。
 *
 * `evaluateGates`（gates.ts）是门引擎与唯一写入口；本文件负责把它接进判定链：
 *  - 归一化「门链结论 → 判定链动作」：enforce 下 FAIL 拦截（不送模型）、G5 UNKNOWN
 *    进补数队列（快扫不送模型）、yellow/red 只标记不拦截；
 *  - 制裁名单陈旧告警 `SANCTIONS_LIST_STALE`：复用 outbox 的 `SanctionsListStale`
 *    集成事件（ch08 §3.1.12 同一事件类型），按「workspace × 状态 × 失败/缺刷新源集合」
 *    去重，窗口内同键只发一次；
 *  - 判定模式与 J03b 的 `JUDGE_CONTRACT_MODE` 协同：off 下深判保持旧行为；快扫因为
 *    W9（G5 域名门）必须总是评估 L0（否则补数队列永远为空），但 FAIL 的拦截仍按模式
 *    决定（off/shadow 只记录，enforce 才拦截）。
 *
 * 语义边界（设计 §4.3.2.1）：FAIL = NOT_FIT 且拦截；UNKNOWN 不短路、不拦截（G5 的
 * UNKNOWN 例外——`quickScanGateBlock` 让快扫不进 LLM，等补数完成后再评）；
 * PASS 但制裁名单 yellow/red 时只注入 stale 标记（禁止推荐/导出由 J20 面板负责）。
 */

import type { Prisma } from '@prisma/client';

import type { JudgeContractMode } from '../fit-judge-v2';
import {
  SANCTIONS_FRESH_MAX_HOURS,
  SANCTIONS_YELLOW_MAX_HOURS,
  evaluateGates,
  type GateChainVerdict,
  type GateDecision,
  type GateEvaluation,
  type GateId,
  type SanctionsFreshnessState,
} from './gates';
import type { GateReasonCode } from './failure-codes';

/** 四态对外口径：门引擎的 'none'（无 ENABLED 源）统一叫 not_screened。 */
export type SanctionsGateFreshness = 'fresh' | 'yellow' | 'red' | 'not_screened';

export function toSanctionsGateFreshness(
  state: SanctionsFreshnessState,
): SanctionsGateFreshness {
  return state === 'none' ? 'not_screened' : state;
}

/** stale 注入标记：只有 yellow/red 才有；fresh/not_screened 为 null。 */
export function sanctionsStaleMarker(
  freshness: SanctionsGateFreshness,
): 'yellow' | 'red' | null {
  return freshness === 'yellow' || freshness === 'red' ? freshness : null;
}

export interface GateChainSummary {
  readonly verdict: GateChainVerdict;
  readonly evaluation: GateEvaluation;
  readonly sanctions: {
    /** G1 制裁命中（potential_match 且未人工清白）→ FAIL。 */
    readonly hit: boolean;
    readonly freshness: SanctionsGateFreshness;
    /** yellow/red 的注入标记；G1 命中（拦截）时为 null——命中本身已经阻断链路。 */
    readonly staleMarker: 'yellow' | 'red' | null;
    readonly decision: GateDecision | null;
  };
  /** G5 UNKNOWN（无域名 / DEAD）：快扫据此写补数队列、不送 LLM。 */
  readonly domainUnknown: boolean;
  readonly domainDecision: GateDecision | null;
  /** 进补数队列的门（G3/G4/G5 的 UNKNOWN）。 */
  readonly enrichmentGates: readonly GateDecision[];
  /** 本次评估是否真的发出了 stale 告警（false = 非 stale 或去重命中）。 */
  readonly staleAlertEmitted: boolean;
}

export interface GateChainEvaluationContext {
  readonly workspaceId: string;
  readonly icpId: string;
  readonly companyId: string;
  /** 注入时钟（测试/回放）；默认 new Date()。 */
  readonly now?: Date;
  /** P2 域名解析流水线的存活校验结果；无生产者时保持 null（不视为 DEAD）。 */
  readonly domainStatus?: 'ALIVE' | 'DEAD' | 'UNKNOWN' | null;
  /** 关掉告警（回放/测试）；默认发。 */
  readonly emitStaleAlert?: boolean;
}

const ENRICHMENT_GATE_IDS: ReadonlySet<GateId> = new Set(['G_COUNTRY', 'G_SIZE', 'G_DOMAIN']);

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function factsStringArray(facts: Record<string, unknown>, key: string): string[] {
  return stringArray(facts[key]).sort();
}

/**
 * 评估 L0 门链并归一化结论（写库仍由 evaluateGates 唯一负责）。
 * 告警与门结果写入在调用方的事务内完成（outbox 与判定可审计地同源）。
 */
export async function evaluateL0Gates(
  tx: Prisma.TransactionClient,
  ctx: GateChainEvaluationContext,
): Promise<GateChainSummary> {
  const now = ctx.now ?? new Date();
  const evaluation = await evaluateGates(tx, {
    workspaceId: ctx.workspaceId,
    icpId: ctx.icpId,
    canonicalCompanyId: ctx.companyId,
    now,
    domainStatus: ctx.domainStatus ?? null,
  });

  const sanctionsDecision = evaluation.results.find((result) => result.gateId === 'G_SANCTIONS') ?? null;
  const rawFreshness = sanctionsDecision?.facts['freshness'];
  const freshness: SanctionsGateFreshness =
    rawFreshness === 'fresh' || rawFreshness === 'yellow' || rawFreshness === 'red'
      ? rawFreshness
      : 'not_screened';
  const hit = sanctionsDecision?.verdict === 'FAIL';

  const domainDecision = evaluation.results.find((result) => result.gateId === 'G_DOMAIN') ?? null;
  const domainUnknown = domainDecision?.verdict === 'UNKNOWN';

  const enrichmentGates = evaluation.results.filter(
    (result) => result.verdict === 'UNKNOWN' && ENRICHMENT_GATE_IDS.has(result.gateId),
  );

  let staleAlertEmitted = false;
  if (ctx.emitStaleAlert !== false && sanctionsDecision && freshness !== 'fresh' && freshness !== 'not_screened') {
    staleAlertEmitted = await emitSanctionsStaleAlertIfNeeded(tx, {
      workspaceId: ctx.workspaceId,
      icpId: ctx.icpId,
      decision: sanctionsDecision,
      now,
    });
  }

  return {
    verdict: evaluation.verdict,
    evaluation,
    sanctions: {
      hit,
      freshness,
      staleMarker: hit ? null : sanctionsStaleMarker(freshness),
      decision: sanctionsDecision,
    },
    domainUnknown,
    domainDecision,
    enrichmentGates,
    staleAlertEmitted,
  };
}

// ── 判定链动作（模式矩阵） ─────────────────────────────────────────────────

export interface GateBlock {
  readonly gateId: GateId;
  readonly reasonCode: GateReasonCode;
  readonly verdict: 'FAIL' | 'UNKNOWN';
}

/**
 * 快扫在批量判前的拦截规则（W9）：
 *  - G5 UNKNOWN（无域名/DEAD）→ 补数队列，任何模式都不送 LLM（J08 的固定行为）；
 *  - 其余 FAIL（含 G1 制裁命中）→ 仅 enforce 拦截；off/shadow 只记录（shadow 的
 *    L0 结果不改变 v1 产出，PR 说明里写明）。
 */
export function quickScanGateBlock(
  mode: JudgeContractMode,
  summary: GateChainSummary,
): GateBlock | null {
  if (summary.domainUnknown && summary.domainDecision?.reasonCode) {
    return {
      gateId: 'G_DOMAIN',
      reasonCode: summary.domainDecision.reasonCode,
      verdict: 'UNKNOWN',
    };
  }
  if (mode === 'enforce' && summary.verdict === 'FAIL' && summary.evaluation.failedGate?.reasonCode) {
    return {
      gateId: summary.evaluation.failedGate.gateId,
      reasonCode: summary.evaluation.failedGate.reasonCode,
      verdict: 'FAIL',
    };
  }
  return null;
}

/**
 * 深判在模型调用前的拦截规则：仅 enforce 下 FAIL 拦截（NOT_FIT，不调用模型）；
 * shadow 只记录（v1 产出照旧）；off 根本不评估 L0。
 */
export function deepJudgeGateBlock(
  mode: JudgeContractMode,
  summary: GateChainSummary,
): GateDecision | null {
  if (mode === 'enforce' && summary.verdict === 'FAIL') {
    return summary.evaluation.failedGate;
  }
  return null;
}

/** 深判是否评估 L0：off 保持旧行为（不评估），shadow/enforce 评估（W3 的 v2 路径含 L0）。 */
export function deepJudgeRunsL0(mode: JudgeContractMode): boolean {
  return mode !== 'off';
}

// ── SANCTIONS_LIST_STALE 告警（outbox 事件 + 去重） ────────────────────────

/** 复用 ch08 §3.1.12 已注册的集成事件类型（`relay/event-registry.ts`）。 */
export const SANCTIONS_STALE_EVENT_TYPE = 'SanctionsListStale';

/** 同一（状态 × 失败/缺刷新源集合）在窗口内只告警一次。 */
export const SANCTIONS_STALE_ALERT_DEDUPE_HOURS = 6;

const HOUR_MS = 3_600_000;

/** 进程内去重（同一 worker 内多次评估不重复查库/发事件）。 */
const recentStaleAlerts = new Map<string, number>();

/** 测试隔离用；生产不需要调用。 */
export function resetSanctionsStaleAlertDedupeForTests(): void {
  recentStaleAlerts.clear();
}

/**
 * 去重键：workspace × 状态 × 失败源集合 × 缺刷新源集合。
 * 「同一源同一状态不重复轰炸」：源集合或状态变化（yellow→red、eu_fsf 加入失败集）算新事实。
 */
export function sanctionsStaleAlertDedupeKey(input: {
  workspaceId: string;
  freshness: 'yellow' | 'red';
  failedSources: readonly string[];
  missingRefreshSources: readonly string[];
}): string {
  return [
    input.workspaceId,
    input.freshness,
    `failed:${[...input.failedSources].sort().join(',')}`,
    `missing:${[...input.missingRefreshSources].sort().join(',')}`,
  ].join('|');
}

/**
 * 在调用方事务内发 `SanctionsListStale` 告警；同键窗口内已发过（进程内或库里的近期
 * 事件）则跳过。返回是否真的写入了一条事件。
 *
 * 选择 outbox 而非新增告警服务的原因：ch08 §3.1.12 的 qualify 路径已用同一事件类型
 * （SaaS 站内通知 + 运营台消费），这里沿用同一机制，不引入第二套告警通道。
 */
export async function emitSanctionsStaleAlertIfNeeded(
  tx: Prisma.TransactionClient,
  input: {
    workspaceId: string;
    icpId: string;
    decision: GateDecision;
    now: Date;
  },
): Promise<boolean> {
  const freshness = input.decision.facts['freshness'];
  if (freshness !== 'yellow' && freshness !== 'red') return false;

  const failedSources = factsStringArray(input.decision.facts, 'failed_sources');
  const missingRefreshSources = factsStringArray(input.decision.facts, 'missing_refresh_sources');
  const dedupeKey = sanctionsStaleAlertDedupeKey({
    workspaceId: input.workspaceId,
    freshness,
    failedSources,
    missingRefreshSources,
  });
  const nowMs = input.now.getTime();
  const windowMs = SANCTIONS_STALE_ALERT_DEDUPE_HOURS * HOUR_MS;

  for (const [key, at] of recentStaleAlerts) {
    if (nowMs - at >= windowMs) recentStaleAlerts.delete(key);
  }
  const lastInProcess = recentStaleAlerts.get(dedupeKey);
  if (lastInProcess !== undefined && nowMs - lastInProcess < windowMs) return false;

  // 进程重启后仍不轰炸：回看窗口内库里已写入的同类事件（payload.dedupeKey 精确匹配）。
  const recent = await tx.outboxEvent.findMany({
    where: {
      workspaceId: input.workspaceId,
      eventType: SANCTIONS_STALE_EVENT_TYPE,
      occurredAt: { gte: new Date(nowMs - windowMs) },
    },
    select: { payload: true },
    orderBy: { occurredAt: 'desc' },
    take: 50,
  });
  const alreadyRecorded = recent.some((row) => {
    const payload = row.payload;
    return (
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>)['dedupeKey'] === dedupeKey
    );
  });
  if (alreadyRecorded) {
    recentStaleAlerts.set(dedupeKey, nowMs);
    return false;
  }

  await tx.outboxEvent.create({
    data: {
      workspaceId: input.workspaceId,
      eventType: SANCTIONS_STALE_EVENT_TYPE,
      aggregateType: 'ICP',
      aggregateId: input.icpId,
      payload: {
        // 告警码：与 accept 拒绝码同名（运维/审计一眼对上「为什么不得放行」）。
        code: 'SANCTIONS_LIST_STALE',
        origin: 'l0_gate',
        dedupeKey,
        icpId: input.icpId,
        // 复用 ch08 事件消费者的 reason 语义：stale = 不得自动放行（yellow/red 都是）。
        reason: 'stale',
        freshness,
        reasonCode: input.decision.reasonCode,
        failedSourceKeys: failedSources,
        missingRefreshSourceKeys: missingRefreshSources,
        minRefreshedAt: input.decision.facts['min_refreshed_at'] ?? null,
        thresholds: {
          freshMaxHours: SANCTIONS_FRESH_MAX_HOURS,
          yellowMaxHours: SANCTIONS_YELLOW_MAX_HOURS,
        },
      } as Prisma.InputJsonValue,
    },
  });
  recentStaleAlerts.set(dedupeKey, nowMs);
  return true;
}
