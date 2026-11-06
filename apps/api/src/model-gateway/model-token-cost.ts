/**
 * Token-based model cost estimate (upper bound).
 *
 * `LLM_CENTS_PER_MTOK` cents per million tokens (default 100¢/M ≈ $1/M — still
 * several times above the flash tier, an honest upper bound for budget caps,
 * not exact billing). Shared by the paid-budget settle path and the usage-ledger
 * cost fallback, so both always speak the same unit price.
 */
export function centsFromTokens(usage?: {
  inputTokens?: number;
  outputTokens?: number;
}): number | null {
  const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
  if (tokens <= 0) return null;
  const env = Number(process.env.LLM_CENTS_PER_MTOK);
  const perMtok = Number.isFinite(env) && env > 0 ? env : 100;
  return Math.max(1, Math.ceil((tokens * perMtok) / 1_000_000));
}
