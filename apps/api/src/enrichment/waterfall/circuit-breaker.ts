import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * P1-08：finder 熔断器（计划 §2.3.4.6）。
 *
 * 参数：滑动窗口 15 分钟；窗口内**样本 ≥5** 且错误率 >20%，或连续 5 次失败 → OPEN 15 分钟；
 * OPEN 到期后放 1 个探针（HALF_OPEN）：成功 → CLOSED（窗口清零），失败 → 立即重开。
 * 「错误」只算供应商侧故障（429/5xx/超时/网络/欠费）——miss 是成功响应，不计错误率；
 * `provider_unconfigured` 不算（那是本地未配置，池子已过滤）。
 *
 * 状态存 `data_provider.config.circuit`（JSON，不新增表）。读写是**尽力而为**的
 * 运维优化：并发下 last-write-wins 可能少记一次样本，最坏结果只是熔断晚开一轮，
 * 不会放行已熔断的调用之外的错误。存储故障（data_provider 行缺失/JSON 损坏）按
 * 「无状态」处理（CLOSED），熔断器本身绝不阻断业务主链。
 */

export const CIRCUIT_WINDOW_MS = 15 * 60_000;
export const CIRCUIT_OPEN_MS = 15 * 60_000;
export const CIRCUIT_ERROR_RATE = 0.2;
export const CIRCUIT_MIN_SAMPLES = 5;
export const CIRCUIT_CONSECUTIVE_FAILURES = 5;

export type CircuitStatus = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitState {
  status: CircuitStatus;
  windowStartedAt: string | null;
  windowSuccesses: number;
  windowFailures: number;
  consecutiveFailures: number;
  openedAt: string | null;
  /** HALF_OPEN 探针是否在途（在途时其它调用继续被拒，避免一次放一窝）。 */
  probeInFlight: boolean;
}

export function emptyCircuitState(): CircuitState {
  return {
    status: 'CLOSED',
    windowStartedAt: null,
    windowSuccesses: 0,
    windowFailures: 0,
    consecutiveFailures: 0,
    openedAt: null,
    probeInFlight: false,
  };
}

/** 从 data_provider.config 的 JSON 里解析熔断状态（损坏/缺字段按空状态兜底）。 */
export function parseCircuitState(config: unknown): CircuitState {
  if (!config || typeof config !== 'object') return emptyCircuitState();
  const raw = (config as Record<string, unknown>).circuit;
  if (!raw || typeof raw !== 'object') return emptyCircuitState();
  const record = raw as Record<string, unknown>;
  const status =
    record.status === 'OPEN' || record.status === 'HALF_OPEN' || record.status === 'CLOSED'
      ? record.status
      : 'CLOSED';
  const isoOrNull = (value: unknown): string | null =>
    typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
  const nonNegativeInt = (value: unknown): number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
  return {
    status,
    windowStartedAt: isoOrNull(record.windowStartedAt),
    windowSuccesses: nonNegativeInt(record.windowSuccesses),
    windowFailures: nonNegativeInt(record.windowFailures),
    consecutiveFailures: nonNegativeInt(record.consecutiveFailures),
    openedAt: isoOrNull(record.openedAt),
    probeInFlight: record.probeInFlight === true,
  };
}

/**
 * 本次调用是否被允许：
 *  - CLOSED → 允许；
 *  - OPEN 未到期 → 拒绝；
 *  - OPEN 已到期 → 允许一次探针（HALF_OPEN 语义）；
 *  - HALF_OPEN 且探针在途 → 拒绝。
 */
export function circuitAllowsCall(state: CircuitState, now: Date): boolean {
  switch (state.status) {
    case 'CLOSED':
      return true;
    case 'OPEN': {
      if (state.openedAt === null) return true;
      return now.getTime() - Date.parse(state.openedAt) >= CIRCUIT_OPEN_MS;
    }
    case 'HALF_OPEN':
      return !state.probeInFlight;
  }
}

function openState(state: CircuitState, now: Date): CircuitState {
  return {
    ...state,
    status: 'OPEN',
    openedAt: now.toISOString(),
    probeInFlight: false,
  };
}

/**
 * 记录一次调用结果并推进熔断状态。
 * success = 供应商给出了响应（hit 或 miss 都算成功）；failure = 供应商侧故障。
 */
export function applyCircuitOutcome(
  state: CircuitState,
  outcome: 'success' | 'failure',
  now: Date,
): CircuitState {
  const nowMs = now.getTime();
  // OPEN 到期后的第一次结果按探针处理（无论调用方是否显式标 HALF_OPEN）。
  if (state.status === 'OPEN') {
    if (state.openedAt !== null && nowMs - Date.parse(state.openedAt) >= CIRCUIT_OPEN_MS) {
      return outcome === 'success'
        ? { ...emptyCircuitState(), windowStartedAt: now.toISOString() }
        : openState(state, now);
    }
    return state;
  }
  if (state.status === 'HALF_OPEN') {
    return outcome === 'success'
      ? { ...emptyCircuitState(), windowStartedAt: now.toISOString() }
      : openState(state, now);
  }
  // CLOSED：窗口滚动 + 计数。
  const windowFresh =
    state.windowStartedAt !== null &&
    nowMs - Date.parse(state.windowStartedAt) < CIRCUIT_WINDOW_MS;
  const windowStartedAt = windowFresh ? state.windowStartedAt : now.toISOString();
  const windowSuccesses = (windowFresh ? state.windowSuccesses : 0) + (outcome === 'success' ? 1 : 0);
  const windowFailures = (windowFresh ? state.windowFailures : 0) + (outcome === 'failure' ? 1 : 0);
  const consecutiveFailures =
    outcome === 'failure' ? state.consecutiveFailures + 1 : 0;
  const samples = windowSuccesses + windowFailures;
  const tripped =
    consecutiveFailures >= CIRCUIT_CONSECUTIVE_FAILURES ||
    (samples >= CIRCUIT_MIN_SAMPLES && windowFailures / samples > CIRCUIT_ERROR_RATE);
  const next: CircuitState = {
    ...state,
    windowStartedAt,
    windowSuccesses,
    windowFailures,
    consecutiveFailures,
    probeInFlight: false,
  };
  return tripped ? openState(next, now) : next;
}

export interface CircuitBreakerStore {
  load(providerKey: string): Promise<CircuitState>;
  save(providerKey: string, state: CircuitState): Promise<void>;
}

/** data_provider.config.circuit 持久化（平台表，无 RLS）。 */
export class PrismaCircuitBreakerStore implements CircuitBreakerStore {
  constructor(private readonly prisma: PrismaClient) {}

  async load(providerKey: string): Promise<CircuitState> {
    try {
      const row = await this.prisma.dataProvider.findUnique({
        where: { key: providerKey },
        select: { config: true },
      });
      return parseCircuitState(row?.config);
    } catch {
      return emptyCircuitState();
    }
  }

  async save(providerKey: string, state: CircuitState): Promise<void> {
    try {
      const row = await this.prisma.dataProvider.findUnique({
        where: { key: providerKey },
        select: { config: true },
      });
      const config =
        row?.config && typeof row.config === 'object'
          ? (row.config as Record<string, unknown>)
          : {};
      await this.prisma.dataProvider.update({
        where: { key: providerKey },
        data: { config: { ...config, circuit: state } as unknown as Prisma.InputJsonValue },
      });
    } catch {
      // 熔断状态是运维优化，存储故障不阻断主链（本轮按无状态处理）。
    }
  }
}
