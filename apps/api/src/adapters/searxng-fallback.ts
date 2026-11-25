import { Logger } from "@nestjs/common";
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

export type SearxngEffectiveProvider = "searxng" | "serper" | "exa";

export interface SearxngFallbackResult {
  readonly results: SearxResult[];
  readonly provider: SearxngEffectiveProvider;
  readonly fallbackUsed: boolean;
  readonly billed: boolean;
  readonly cooldownActive: boolean;
  readonly reason?: string;
}

export interface SearxngFallbackDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly cooldownState?: SearxngCooldownTracker;
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

export function isSearxngFallbackEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.SEARXNG_FALLBACK_ENABLED?.trim().toLowerCase();
  return raw !== "off" && raw !== "false" && raw !== "0";
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

function hasAnyFallbackKey(env: NodeJS.ProcessEnv): boolean {
  return Boolean(resolveSerperApiKey(env) || resolveExaApiKey(env));
}

function normalizeSearchLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const trimmed = language.trim().toLowerCase();
  if (/^[a-z]{2}(?:-[a-z]{2})?$/u.test(trimmed)) return trimmed;
  return undefined;
}

async function runFallbackChain(
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

  if (serperKey) {
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
        cooldownActive: true,
        reason,
      };
    } catch (error) {
      logger.warn(
        `Serper fallback failed after ${reason}: ${String((error as Error)?.message ?? error).slice(0, 120)}`,
      );
    }
  }

  if (exaKey) {
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
 * Executes a SearXNG search with automatic 403/429 cooldown tracking and
 * deterministic Serper -> Exa fallback when fallback API keys are configured.
 */
export async function executeWithSearxngFallback(
  primary: () => Promise<SearxResult[]>,
  query: SearxQuery,
  options: { pages?: number } & SearxngFallbackDeps = {},
): Promise<SearxngFallbackResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const tracker = options.cooldownState ?? defaultCooldownTracker;
  const fallbackEnabled = isSearxngFallbackEnabled(env);
  const maxResults = Math.min(20, Math.max(10, (options.pages ?? 1) * 10));

  if (fallbackEnabled && tracker.isInCooldown(now()) && hasAnyFallbackKey(env)) {
    const activeReason = tracker.reason() ?? "searxng_cooldown_active";
    const served = await runFallbackChain(query, maxResults, activeReason, options);
    if (served) return served;
  }

  try {
    const results = await primary();
    return {
      results,
      provider: "searxng",
      fallbackUsed: false,
      billed: false,
      cooldownActive: tracker.isInCooldown(now()),
    };
  } catch (error) {
    const reason = classifySearxngCooldownReason(error);
    if (reason) {
      tracker.trip(now(), resolveSearxngCooldownMs(env), reason);
      if (fallbackEnabled && hasAnyFallbackKey(env)) {
        const served = await runFallbackChain(query, maxResults, reason, options);
        if (served) return served;
      }
    }
    throw error;
  }
}
