/**
 * 搜索 provider 路由与降级契约（ch03 §3.14.3 / T3-11 的离线骨架）。
 *
 * 真实 HTTP 适配器（Brave/Serper/Mojeek/SearXNG）与 ToolBroker/密钥属在线部分；
 * 本模块只固化三件事：
 *  1. **两种调用形态**——`searchPreferred`：按成本顺序串行、失败切下一家（结果带
 *     `degradedFrom`）；`searchAll`：域名解析强制的多路并行（各 provider 独立成败，
 *     单路失败不拖垮整体，结果按 provider 分组返回供并集/重叠估计）。
 *  2. **成本账本草案**——每 provider 声明 `costPerQueryUsd`，路由汇总为
 *     `UsageLedgerDraft`（purpose=`DISCOVERY_DOMAIN_RESOLVE`，ch03 §3.8.3），
 *     写账本属执行面。
 *  3. **健康阈值**——§3.14.3：连续 20 次失败或 4 天无成功 → 告警；30 次失败/7 天 →
 *     自动停用。`ProviderHealthTracker` 是纯事件窗口计算，路由跳过被停用的 provider。
 *
 * 复用 `DomainSearchProvider` 契约（domain-resolver.ts），保证与候选生成同一接口。
 */
import type { DomainSearchProvider, SearchHit, SearchQueryInput } from './domain-resolver';

export interface RoutedSearchProvider extends DomainSearchProvider {
  /** 单次查询成本（美元），用于预算与账本；免费路填 0。 */
  readonly costPerQueryUsd?: number;
}

export type ProviderCallStatus = 'ok' | 'failed' | 'skipped_disabled';

export interface ProviderCallOutcome {
  providerKey: string;
  status: ProviderCallStatus;
  hits: SearchHit[];
  costUsd: number;
  latencyMs: number;
  error?: string;
}

export interface UsageLedgerDraft {
  providerKey: string;
  quantity: number;
  costCents: number;
  purpose: 'DISCOVERY_DOMAIN_RESOLVE';
}

export interface SearchAllResult {
  /** 每个 provider 独立结果（含失败与跳过），供并集、Jaccard 重叠与账本使用。 */
  outcomes: ProviderCallOutcome[];
  /** 成功 provider 的合并命中（按 rank 升序、url 去重，保留首次出现的 provider）。 */
  merged: Array<SearchHit & { providerKey: string }>;
  /** 本次被降级/失败的 provider（查询串不变，结果来自其余路）。 */
  degradedFrom: string[];
  ledger: UsageLedgerDraft[];
}

export interface SearchPreferredResult {
  providerKey: string | null;
  hits: SearchHit[];
  degradedFrom: string[];
  ledger: UsageLedgerDraft[];
  /** 全部 provider 都失败/被停用时为 true（调用方应按 SOURCE_DISABLED 处理）。 */
  allUnavailable: boolean;
}

const DEFAULT_LATENCY_BUDGET_MS = 20_000;

function usdToCents(usd: number): number {
  // 向上取整：账本按分记账，亚分成本宁可高估不可漏记（对账偏差方向可控）。
  return Math.ceil(usd * 100);
}

/**
 * 健康跟踪（ch03 §3.14.3 阈值）：
 *  - 连续失败 ≥20 次，或最近一次成功距今 >4 天（且期间有失败）→ `warn`；
 *  - 7 天窗口内失败 ≥30 次 → `disabled`（自动停用，路由跳过；恢复由运维/在线部分决定）。
 */
export interface ProviderHealthSnapshot {
  providerKey: string;
  consecutiveFailures: number;
  failuresLast7Days: number;
  lastSuccessAt: string | null;
  state: 'healthy' | 'warn' | 'disabled';
}

export class ProviderHealthTracker {
  private readonly events = new Map<string, Array<{ at: number; ok: boolean }>>();

  record(providerKey: string, ok: boolean, atIso: string): void {
    const at = new Date(atIso).getTime();
    if (Number.isNaN(at)) throw new Error(`invalid health timestamp: ${atIso}`);
    const list = this.events.get(providerKey) ?? [];
    list.push({ at, ok });
    this.events.set(providerKey, list);
  }

  snapshot(providerKey: string, nowIso: string): ProviderHealthSnapshot {
    const now = new Date(nowIso).getTime();
    const events = (this.events.get(providerKey) ?? [])
      .slice()
      .sort((left, right) => left.at - right.at);
    let consecutiveFailures = 0;
    for (let index = events.length - 1; index >= 0; index--) {
      if (events[index]!.ok) break;
      consecutiveFailures += 1;
    }
    const sevenDaysAgo = now - 7 * 86_400_000;
    const failuresLast7Days = events.filter((event) => !event.ok && event.at >= sevenDaysAgo).length;
    const lastSuccess = [...events].reverse().find((event) => event.ok) ?? null;
    const lastSuccessAt = lastSuccess ? new Date(lastSuccess.at).toISOString() : null;
    const staleSuccess =
      events.length > 0 &&
      consecutiveFailures > 0 &&
      (lastSuccess === null || now - lastSuccess.at > 4 * 86_400_000);
    const state: ProviderHealthSnapshot['state'] =
      failuresLast7Days >= 30
        ? 'disabled'
        : consecutiveFailures >= 20 || staleSuccess
          ? 'warn'
          : 'healthy';
    return { providerKey, consecutiveFailures, failuresLast7Days, lastSuccessAt, state };
  }

  disabledProviders(nowIso: string, providerKeys: readonly string[]): Set<string> {
    const disabled = new Set<string>();
    for (const key of providerKeys) {
      if (this.snapshot(key, nowIso).state === 'disabled') disabled.add(key);
    }
    return disabled;
  }
}

export interface SearchRouterOptions {
  /** 按成本顺序排列；`searchPreferred` 依序回退。 */
  providers: RoutedSearchProvider[];
  health?: ProviderHealthTracker;
  /** 记录时钟（默认 new Date）；测试注入固定时钟。 */
  now?: () => string;
  latencyBudgetMs?: number;
}

export class SearchRouter {
  private readonly providers: RoutedSearchProvider[];
  private readonly health: ProviderHealthTracker;
  private readonly now: () => string;
  private readonly latencyBudgetMs: number;

  constructor(options: SearchRouterOptions) {
    if (options.providers.length === 0) {
      throw new Error('SearchRouter 需要至少一个 provider');
    }
    const keys = options.providers.map((provider) => provider.key);
    if (new Set(keys).size !== keys.length) {
      throw new Error(`SearchRouter provider key 重复：${keys.join(', ')}`);
    }
    this.providers = [...options.providers];
    this.health = options.health ?? new ProviderHealthTracker();
    this.now = options.now ?? (() => new Date().toISOString());
    this.latencyBudgetMs = options.latencyBudgetMs ?? DEFAULT_LATENCY_BUDGET_MS;
  }

  private async call(
    provider: RoutedSearchProvider,
    input: SearchQueryInput,
  ): Promise<ProviderCallOutcome> {
    const started = Date.now();
    try {
      const hits = await provider.search(input);
      const latencyMs = Date.now() - started;
      this.health.record(provider.key, true, this.now());
      return {
        providerKey: provider.key,
        status: 'ok',
        hits,
        costUsd: provider.costPerQueryUsd ?? 0,
        latencyMs,
      };
    } catch (error) {
      const latencyMs = Date.now() - started;
      this.health.record(provider.key, false, this.now());
      return {
        providerKey: provider.key,
        status: 'failed',
        hits: [],
        costUsd: 0,
        latencyMs,
        error: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }

  private skipped(providerKey: string): ProviderCallOutcome {
    return { providerKey, status: 'skipped_disabled', hits: [], costUsd: 0, latencyMs: 0 };
  }

  /**
   * 域名解析强制形态（ch03 §3.14.3）：全部未停用 provider 并行各查一次，取并集。
   * 失败路不抛出；`degradedFrom` 记录本次失败的 provider。
   */
  async searchAll(input: SearchQueryInput): Promise<SearchAllResult> {
    const now = this.now();
    const disabled = this.health.disabledProviders(
      now,
      this.providers.map((provider) => provider.key),
    );
    const outcomes: ProviderCallOutcome[] = await Promise.all(
      this.providers.map(async (provider) => {
        if (disabled.has(provider.key)) return this.skipped(provider.key);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            this.call(provider, input),
            new Promise<ProviderCallOutcome>((resolve) => {
              timer = setTimeout(() => {
                this.health.record(provider.key, false, this.now());
                resolve({
                  providerKey: provider.key,
                  status: 'failed',
                  hits: [],
                  costUsd: 0,
                  latencyMs: this.latencyBudgetMs,
                  error: 'LATENCY_BUDGET_EXCEEDED',
                });
              }, this.latencyBudgetMs);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }),
    );

    const seen = new Map<string, SearchHit & { providerKey: string }>();
    for (const outcome of outcomes) {
      for (const hit of [...outcome.hits].sort((left, right) => left.rank - right.rank)) {
        if (!seen.has(hit.url)) seen.set(hit.url, { ...hit, providerKey: outcome.providerKey });
      }
    }
    return {
      outcomes,
      merged: [...seen.values()].sort((left, right) => left.rank - right.rank),
      degradedFrom: outcomes
        .filter((outcome) => outcome.status === 'failed')
        .map((outcome) => outcome.providerKey),
      ledger: outcomes
        .filter((outcome) => outcome.status === 'ok')
        .map((outcome) => ({
          providerKey: outcome.providerKey,
          quantity: 1,
          costCents: usdToCents(outcome.costUsd),
          purpose: 'DISCOVERY_DOMAIN_RESOLVE' as const,
        })),
    };
  }

  /**
   * 成本优先的串行形态：按构造顺序尝试，首个成功即返回；失败记录 `degradedFrom` 并切下一家。
   * 全部不可用（失败或被停用）→ `allUnavailable`，调用方按 SOURCE_DISABLED 处理。
   */
  async searchPreferred(input: SearchQueryInput): Promise<SearchPreferredResult> {
    const now = this.now();
    const disabled = this.health.disabledProviders(
      now,
      this.providers.map((provider) => provider.key),
    );
    const degradedFrom: string[] = [];
    for (const provider of this.providers) {
      if (disabled.has(provider.key)) {
        degradedFrom.push(provider.key);
        continue;
      }
      const outcome = await this.call(provider, input);
      if (outcome.status === 'ok') {
        return {
          providerKey: provider.key,
          hits: outcome.hits,
          degradedFrom,
          ledger: [
            {
              providerKey: provider.key,
              quantity: 1,
              costCents: usdToCents(outcome.costUsd),
              purpose: 'DISCOVERY_DOMAIN_RESOLVE',
            },
          ],
          allUnavailable: false,
        };
      }
      degradedFrom.push(provider.key);
    }
    return { providerKey: null, hits: [], degradedFrom, ledger: [], allUnavailable: true };
  }
}
