/**
 * Token-based model cost estimate (upper bound).
 *
 * `LLM_CENTS_PER_MTOK` cents per million tokens (default 100¢/M ≈ $1/M — still
 * several times above the flash tier, an honest upper bound for budget caps,
 * not exact billing). Shared by the paid-budget settle path and the usage-ledger
 * cost fallback, so both always speak the same unit price.
 */
const MICROUSD_PER_CENT = 10_000;

function centsPerMtok(): number {
  const env = Number(process.env.LLM_CENTS_PER_MTOK);
  return Number.isFinite(env) && env > 0 ? env : 100;
}

/**
 * MicroUSD token cost estimate — eliminates the 1-cent ($0.01 = 10,000 µUSD)
 * minimum floor per call that overcharged Flash calls by 10x–33x.
 * At default 100¢/M ($1/M = 1 µUSD/token), a 1,000-token call settles at
 * 1,000 µUSD ($0.001) instead of 10,000 µUSD ($0.01).
 */
export function microusdFromTokens(usage?: {
  inputTokens?: number;
  outputTokens?: number;
}): number | null {
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (tokens <= 0) return null;
  const microusdPerMtok = centsPerMtok() * MICROUSD_PER_CENT;
  return Math.max(1, Math.ceil((tokens * microusdPerMtok) / 1_000_000));
}

/**
 * Legacy cent-granularity helper preserved for cent-only displays/fallbacks.
 */
export function centsFromTokens(usage?: {
  inputTokens?: number;
  outputTokens?: number;
}): number | null {
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (tokens <= 0) return null;
  return Math.max(1, Math.ceil((tokens * centsPerMtok()) / 1_000_000));
}
