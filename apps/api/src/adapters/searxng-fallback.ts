import { Logger } from "@nestjs/common";
import type { ExecutionBroker, ToolContext } from "../tools/tool-contract";
import type {
  ExaSearchToolInput,
  SearchProviderOutput,
  SerperSearchToolInput,
} from "../tools/search-provider-tools";
import {
  exaSearch,
  resolveExaApiKey,
  resolveSerperApiKey,
  serperSearch,
  type SearchProviderDeps,
  type SearchProviderResponse,
} from "./search-providers";
import type { SearxQuery, SearxResult } from "./searxng";

const logger = new Logger("SearxngFallback");

export const DEFAULT_SEARXNG_COOLDOWN_MS = 180_000;
const MIN_COOLDOWN_MS = 1_000;
const MAX_COOLDOWN_MS = 3_600_000;
const PAID_SEARCH_FALLBACK_COST_CENTS = 1;

export type SearxngEffectiveProvider = "searxng" | "serper" | "exa";

export interface SearxngFallbackResult {
  readonly results: SearxResult[];
  readonly provider: SearxngEffectiveProvider;
  readonly fallbackUsed: boolean;
  readonly billed: boolean;
  readonly costCents: number;
  readonly cooldownActive: boolean;
  readonly reason?: string;
}

export interface SearxngFallbackDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly cooldownState?: SearxngCooldownTracker;
  /** Workspace scope; `platform` (or `platformEgress`) is strictly forbidden from calling paid fallback APIs. */
  readonly workspaceId?: string;
  readonly platformEgress?: unknown;
  /** Optional `data_provider` gate check so DISABLED paid providers are never bypassed. */
  readonly isProviderEnabled?: (
    providerKey: "serper" | "exa",
  ) => Promise<boolean> | boolean;
  readonly beforeRequest?: () => Promise<void>;
  readonly serper?: (
    input: { query: string; num?: number; hl?: string },
    deps?: SearchProviderDeps,
  ) => Promise<SearchProviderResponse>;
  readonly exa?: (
    input: { query: string; numResults?: number },
    deps?: SearchProviderDeps,
  ) => Promise<SearchProviderResponse>;
}

export class SearxngCooldownTracker {
  private cooldownUntilMs = 0;
  private lastReason: string | null = null;

  isInCooldown(nowMs: number): boolean {
    return nowMs < this.cooldownUntilMs;
  }

  remainingMs(nowMs: number): number {
    return Math.max(0, this.cooldownUntilMs - nowMs);
  }

  reason(): string | null {
    return this.lastReason;
  }

  trip(nowMs: number, durationMs: number, reason: string): void {
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, nowMs + durationMs);
    this.lastReason = reason;
  }

  reset(): void {
    this.cooldownUntilMs = 0;
    this.lastReason = null;
  }
}

const defaultCooldownTracker = new SearxngCooldownTracker();

export function resetSearxngCooldownForTests(): void {
  defaultCooldownTracker.reset();
}

export function getSearxngCooldownSnapshot(nowMs = Date.now()): {
  readonly active: boolean;
  readonly remainingMs: number;
  readonly reason: string | null;
} {
  return {
    active: defaultCooldownTracker.isInCooldown(nowMs),
    remainingMs: defaultCooldownTracker.remainingMs(nowMs),
    reason: defaultCooldownTracker.reason(),
  };
}

/**
 * Paid fallback (Serper / Exa) is strictly opt-in (default OFF) so a free
 * self-hosted SearXNG outage never silently incurs paid API spend unless
 * explicitly authorized via `SEARXNG_FALLBACK_ENABLED=on|true|1`.
 */
export function isSearxngFallbackEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.SEARXNG_FALLBACK_ENABLED?.trim().toLowerCase();
  return raw === "on" || raw === "true" || raw === "1";
}

export function isPlatformScopedContext(input: {
  readonly workspaceId?: string;
  readonly platformEgress?: unknown;
}): boolean {
  return input.workspaceId === "platform" || Boolean(input.platformEgress);
}

export function resolveSearxngCooldownMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.SEARXNG_COOLDOWN_MS?.trim();
  if (!raw) return DEFAULT_SEARXNG_COOLDOWN_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_SEARXNG_COOLDOWN_MS;
  return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, Math.trunc(parsed)));
}

/**
 * Classifies whether a SearXNG error warrants cooldown + Serper/Exa fallback:
 * HTTP 403 / 429 / 502 / 503 / 504 or upstream suspension/rate-limit signals.
 */
export function classifySearxngCooldownReason(error: unknown): string | null {
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  if (/\b403\b|forbidden|access denied/iu.test(message)) return "searxng_http_403";
  if (/\b429\b|too many requests|rate.?limit/iu.test(message)) {
    return "searxng_http_429";
  }
  if (/\b(?:502|503|504)\b/u.test(message)) return "searxng_http_5xx";
  if (/suspended|unusual traffic|captcha/iu.test(message)) {
    return "searxng_upstream_blocked";
  }
  return null;
}

/** Records a SearXNG cooldown transition when a 403/429/5xx/block error occurs. */
export function recordSearxngCooldownError(
  error: unknown,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: () => number;
    readonly cooldownState?: SearxngCooldownTracker;
  } = {},
): string | null {
  const reason = classifySearxngCooldownReason(error);
  if (!reason) return null;
  const tracker = options.cooldownState ?? defaultCooldownTracker;
  const now = options.now ?? Date.now;
  tracker.trip(now(), resolveSearxngCooldownMs(options.env ?? process.env), reason);
  return reason;
}

function hasAnyFallbackKey(env: NodeJS.ProcessEnv): boolean {
  return Boolean(resolveSerperApiKey(env) || resolveExaApiKey(env));
}

function normalizeSearchLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const trimmed = language.trim().toLowerCase();
  if (/^[a-z]{2}(?:-[a-z]{2})?$/u.test(trimmed)) return trimmed;
  return undefined;
}

async function providerAllowed(
  key: "serper" | "exa",
  check?: (providerKey: "serper" | "exa") => Promise<boolean> | boolean,
): Promise<boolean> {
  if (!check) return true;
  return Boolean(await check(key));
}

async function runAdapterFallbackChain(
  query: SearxQuery,
  maxResults: number,
  reason: string,
  deps: SearxngFallbackDeps,
): Promise<SearxngFallbackResult | null> {
  const env = deps.env ?? process.env;
  const serperKey = resolveSerperApiKey(env);
  const exaKey = resolveExaApiKey(env);
  const providerDeps: SearchProviderDeps = {
    ...(deps.beforeRequest ? { beforeRequest: deps.beforeRequest } : {}),
  };

  if (serperKey && (await providerAllowed("serper", deps.isProviderEnabled))) {
    try {
      const serperFn = deps.serper ?? serperSearch;
      const response = await serperFn(
        {
          query: query.q,
          num: Math.min(20, Math.max(1, maxResults)),
          hl: normalizeSearchLanguage(query.language),
        },
        { ...providerDeps, apiKey: serperKey },
      );
      logger.warn(
        `SearXNG fallback served via serper (reason=${reason}, hits=${response.hits.length})`,
      );
      return {
        results: response.hits.map((hit) => ({
          url: hit.url,
          title: hit.title ?? "",
          engine: "serper_fallback",
        })),
        provider: "serper",
        fallbackUsed: true,
        billed: response.billed,
        costCents: response.billed ? PAID_SEARCH_FALLBACK_COST_CENTS : 0,
        cooldownActive: true,
        reason,
      };
    } catch (error) {
      logger.warn(
        `Serper fallback failed after ${reason}: ${String((error as Error)?.message ?? error).slice(0, 120)}`,
      );
    }
  }

  if (exaKey && (await providerAllowed("exa", deps.isProviderEnabled))) {
    try {
      const exaFn = deps.exa ?? exaSearch;
      const response = await exaFn(
        {
          query: query.q,
          numResults: Math.min(20, Math.max(1, maxResults)),
        },
        { ...providerDeps, apiKey: exaKey },
      );
      logger.warn(
        `SearXNG fallback served via exa (reason=${reason}, hits=${response.hits.length})`,
      );
      return {
        results: response.hits.map((hit) => ({
          url: hit.url,
          title: hit.title ?? "",
          engine: "exa_fallback",
        })),
        provider: "exa",
        fallbackUsed: true,
        billed: response.billed,
        costCents: response.billed ? PAID_SEARCH_FALLBACK_COST_CENTS : 0,
        cooldownActive: true,
        reason,
      };
    } catch (error) {
      logger.warn(
        `Exa fallback failed after ${reason}: ${String((error as Error)?.message ?? error).slice(0, 120)}`,
      );
    }
  }

  return null;
}

/**
 * Adapter-level SearXNG execution with 403/429 cooldown tracking and opt-in
 * Serper -> Exa fallback. Strictly blocks paid fallback when disabled (default)
 * or in `platform` scope, respects `isProviderEnabled`, and reports truthful
 * `costCents` (`1` when billed, `0` when served by free SearXNG).
 */
export async function executeWithSearxngFallback(
  primary: () => Promise<SearxResult[]>,
  query: SearxQuery,
  options: { pages?: number } & SearxngFallbackDeps = {},
): Promise<SearxngFallbackResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const tracker = options.cooldownState ?? defaultCooldownTracker;
  const canFallback =
    isSearxngFallbackEnabled(env) &&
    !isPlatformScopedContext(options) &&
    hasAnyFallbackKey(env);
  const maxResults = Math.min(20, Math.max(10, (options.pages ?? 1) * 10));

  if (canFallback && tracker.isInCooldown(now())) {
    const activeReason = tracker.reason() ?? "searxng_cooldown_active";
    const served = await runAdapterFallbackChain(
      query,
      maxResults,
      activeReason,
      options,
    );
    if (served) return served;
  }

  try {
    const results = await primary();
    return {
      results,
      provider: "searxng",
      fallbackUsed: false,
      billed: false,
      costCents: 0,
      cooldownActive: tracker.isInCooldown(now()),
    };
  } catch (error) {
    const reason = recordSearxngCooldownError(error, {
      env,
      now,
      cooldownState: tracker,
    });
    if (reason && canFallback) {
      const served = await runAdapterFallbackChain(
        query,
        maxResults,
        reason,
        options,
      );
      if (served) return served;
    }
    throw error;
  }
}

export interface BrokerSearxngFallbackOptions {
  readonly pages?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly cooldownState?: SearxngCooldownTracker;
  /** Optional `data_provider` gate check so DISABLED paid providers are never invoked. */
  readonly isProviderEnabled?: (
    providerKey: "serper" | "exa",
  ) => Promise<boolean> | boolean;
}

async function runBrokerFallbackChain(
  broker: ExecutionBroker,
  query: SearxQuery,
  ctx: ToolContext,
  maxResults: number,
  reason: string,
  options: BrokerSearxngFallbackOptions,
): Promise<SearxngFallbackResult | null> {
  const env = options.env ?? process.env;

  if (
    resolveSerperApiKey(env) &&
    (await providerAllowed("serper", options.isProviderEnabled))
  ) {
    try {
      const input: SerperSearchToolInput = {
        query: query.q,
        num: Math.min(20, Math.max(1, maxResults)),
        ...(normalizeSearchLanguage(query.language)
          ? { hl: normalizeSearchLanguage(query.language) }
          : {}),
      };
      const out = await broker.invoke<SerperSearchToolInput, SearchProviderOutput>(
        "serper.search",
        input,
        ctx,
      );
      if (!out.degraded) {
        logger.warn(
          `SearXNG cooldown routed through ToolBroker serper.search (reason=${reason}, costCents=${out.costCents})`,
        );
        return {
          results: out.data.results.map((hit) => ({
            url: hit.url,
            title: hit.title ?? "",
            engine: "serper_fallback",
          })),
          provider: "serper",
          fallbackUsed: true,
          billed: out.costCents > 0,
          costCents: out.costCents,
          cooldownActive: true,
          reason,
        };
      }
    } catch (error) {
      logger.warn(
        `ToolBroker serper.search fallback failed after ${reason}: ${String((error as Error)?.message ?? error).slice(0, 120)}`,
      );
    }
  }

  if (
    resolveExaApiKey(env) &&
    (await providerAllowed("exa", options.isProviderEnabled))
  ) {
    try {
      const input: ExaSearchToolInput = {
        mode: "search",
        query: query.q,
        numResults: Math.min(20, Math.max(1, maxResults)),
      };
      const out = await broker.invoke<ExaSearchToolInput, SearchProviderOutput>(
        "exa.search",
        input,
        ctx,
      );
      if (!out.degraded) {
        logger.warn(
          `SearXNG cooldown routed through ToolBroker exa.search (reason=${reason}, costCents=${out.costCents})`,
        );
        return {
          results: out.data.results.map((hit) => ({
            url: hit.url,
            title: hit.title ?? "",
            engine: "exa_fallback",
          })),
          provider: "exa",
          fallbackUsed: true,
          billed: out.costCents > 0,
          costCents: out.costCents,
          cooldownActive: true,
          reason,
        };
      }
    } catch (error) {
      logger.warn(
        `ToolBroker exa.search fallback failed after ${reason}: ${String((error as Error)?.message ?? error).slice(0, 120)}`,
      );
    }
  }

  return null;
}

/**
 * Governed ToolBroker caller seam: routes SearXNG searches through `searxng.search`
 * and — only when `SEARXNG_FALLBACK_ENABLED=on|true|1` AND non-platform scope —
 * delegates 403/429 cooldown fallback to the properly budgeted & rate-limited
 * `serper.search` / `exa.search` ToolBroker tools so every paid call settles truthfully
 * in `tool_budget_operation` (never silently billed at 0c).
 */
export async function invokeSearxngWithBrokerFallback(
  broker: ExecutionBroker,
  query: SearxQuery,
  ctx: ToolContext,
  options: BrokerSearxngFallbackOptions = {},
): Promise<SearxngFallbackResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const tracker = options.cooldownState ?? defaultCooldownTracker;
  const pages = options.pages ?? 1;
  const maxResults = Math.min(20, Math.max(10, pages * 10));
  const canFallback =
    isSearxngFallbackEnabled(env) &&
    !isPlatformScopedContext(ctx) &&
    hasAnyFallbackKey(env);

  if (canFallback && tracker.isInCooldown(now())) {
    const activeReason = tracker.reason() ?? "searxng_cooldown_active";
    const served = await runBrokerFallbackChain(
      broker,
      query,
      ctx,
      maxResults,
      activeReason,
      options,
    );
    if (served) return served;
  }

  try {
    const out = await broker.invoke<
      SearxQuery & { pages?: number },
      { results: Array<{ url: string; title?: string }> }
    >("searxng.search", { ...query, pages }, ctx);
    return {
      results: out.data.results.map((hit) => ({
        url: hit.url,
        title: hit.title ?? "",
      })),
      provider: "searxng",
      fallbackUsed: false,
      billed: false,
      costCents: out.costCents,
      cooldownActive: tracker.isInCooldown(now()),
    };
  } catch (error) {
    const reason = recordSearxngCooldownError(error, {
      env,
      now,
      cooldownState: tracker,
    });
    if (reason && canFallback) {
      const served = await runBrokerFallbackChain(
        broker,
        query,
        ctx,
        maxResults,
        reason,
        options,
      );
      if (served) return served;
    }
    throw error;
  }
}
